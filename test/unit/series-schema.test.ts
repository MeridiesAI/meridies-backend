import assert from "node:assert/strict";
import { test } from "node:test";
import { resetSeriesReady, seriesReady } from "../../src/lib/seriesSchema.js";

/** A stand-in for the caller's client: the zero-row select answers `answer` and counts the asks. */
function probe(answer: () => { code?: string } | null) {
  const asked: string[] = [];
  let calls = 0;
  const db = {
    from: (table: string) => ({
      select: (cols: string) => ({
        limit: async () => (calls++, asked.push(`${table}.${cols}`), { error: answer() }),
      }),
    }),
  };
  return { db, asked, calls: () => calls };
}

test("seriesReady: false on a missing column, true once it exists, then kept for the process", async () => {
  resetSeriesReady();
  let answer: { code?: string } | null = { code: "42703" };
  const p = probe(() => answer);
  assert.equal(await seriesReady(p.db, 0), false);
  assert.deepEqual(p.asked, ["meetings.series_id"]);
  answer = null;
  assert.equal(await seriesReady(p.db, 31_000), true);
  answer = { code: "42703" };
  assert.equal(await seriesReady(p.db, 99_000_000), true, "ready is kept");
  assert.equal(p.calls(), 2, "the true answer is not asked again");
  resetSeriesReady();
});

test("seriesReady: a miss is asked again only after 30 s", async () => {
  resetSeriesReady();
  const p = probe(() => ({ code: "42703" }));
  assert.equal(await seriesReady(p.db, 0), false);
  assert.equal(await seriesReady(p.db, 29_999), false);
  assert.equal(p.calls(), 1, "inside the 30 s the miss is cached");
  assert.equal(await seriesReady(p.db, 30_000), false);
  assert.equal(p.calls(), 2, "after 30 s it asks again");
  resetSeriesReady();
});

test("seriesReady: any other error is false and never cached, not even as a miss", async () => {
  resetSeriesReady();
  const p = probe(() => ({ code: "57014" }));
  assert.equal(await seriesReady(p.db, 0), false);
  assert.equal(await seriesReady(p.db, 1), false);
  assert.equal(p.calls(), 2);
  resetSeriesReady();
});

test("seriesReady: a client that throws is false", async () => {
  resetSeriesReady();
  const db = { from: () => ({ select: () => ({ limit: async () => { throw new Error("network"); } }) }) };
  assert.equal(await seriesReady(db, 0), false);
  resetSeriesReady();
});
