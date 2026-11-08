// lib/pagedRead.ts: every export table read is paged in a stable order, so
// PostgREST's max_rows (1,000) can't silently cut a table short, up to a
// per-table cap; `truncated` is reported only when the cap is really hit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ORDER_KEYS, PAGE_SIZE, ReadStopped, TABLE_ROW_CAP, orderKeysFor, readPaged } from "../../src/lib/pagedRead.js";

/** A table of `n` rows served the way PostgREST does: range is inclusive, and at most `maxRows` per answer. */
function table(n: number, maxRows = 1000) {
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, n, from + maxRows);
    return { data: Array.from({ length: Math.max(0, end - from) }, (_, i) => ({ id: from + i })), error: null };
  };
  return { fetchPage, calls };
}

test("pages are 1,000 rows and the cap is 5,000 per table", () => {
  assert.equal(PAGE_SIZE, 1000);
  assert.equal(TABLE_ROW_CAP, 5000);
});

test("1,200 rows all come back, in two pages", async () => {
  const t = table(1200);
  const r = await readPaged(t.fetchPage);
  assert.equal(r.rows.length, 1200);
  assert.equal(r.truncated, false);
  assert.deepEqual(t.calls, [[0, 999], [1000, 1999]]);
  assert.deepEqual(r.rows.map((x) => (x as { id: number }).id), Array.from({ length: 1200 }, (_, i) => i));
});

test("an empty table is one query", async () => {
  const t = table(0);
  const r = await readPaged(t.fetchPage);
  assert.deepEqual(r.rows, []);
  assert.equal(t.calls.length, 1);
});

test("exactly the cap is not truncated (a one-row probe says so)", async () => {
  const t = table(5000);
  const r = await readPaged(t.fetchPage);
  assert.equal(r.rows.length, 5000);
  assert.equal(r.truncated, false);
  assert.deepEqual(t.calls.at(-1), [5000, 5000]);
});

test("past the cap: the first 5,000 rows and truncated", async () => {
  const t = table(7000);
  const r = await readPaged(t.fetchPage);
  assert.equal(r.rows.length, 5000);
  assert.equal(r.truncated, true);
});

test("a smaller cap and page size are honoured", async () => {
  const t = table(25);
  const r = await readPaged(t.fetchPage, { pageSize: 10, cap: 20 });
  assert.equal(r.rows.length, 20);
  assert.equal(r.truncated, true);
  assert.deepEqual(t.calls, [[0, 9], [10, 19], [20, 20]]);
});

test("an error is returned with what was read, not thrown", async () => {
  let n = 0;
  const r = await readPaged(async () => (n++ === 0 ? { data: Array.from({ length: 1000 }, () => ({})), error: null } : { data: null, error: { code: "42501" } }));
  assert.equal(r.rows.length, 1000);
  assert.deepEqual(r.error, { code: "42501" });
});

test("onPage sees each page and can stop the read", async () => {
  const t = table(3000);
  const seen: number[] = [];
  await assert.rejects(
    readPaged(t.fetchPage, {
      onPage: (rows) => {
        seen.push(rows.length);
        if (seen.length === 2) throw new ReadStopped();
      },
    }),
    ReadStopped
  );
  assert.deepEqual(seen, [1000, 1000]);
  assert.equal(t.calls.length, 2);
});

test("every student table has a stable order key", () => {
  assert.deepEqual(orderKeysFor("activities"), ["id"]);
  assert.deepEqual(orderKeysFor("deliverable_documents"), ["deliverable_id", "document_id"]);
  assert.deepEqual(orderKeysFor("meeting_attendees"), ["meeting_id"]);
  assert.deepEqual(orderKeysFor("student_academics"), ["student_id"]);
  for (const keys of Object.values(ORDER_KEYS)) assert.ok(keys.length > 0);
});
