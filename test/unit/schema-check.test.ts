import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUIRED_SCHEMA, missingSchema } from "../../src/lib/schemaCheck.js";

/** A stand-in client: `answers[table]` is the PostgREST error for that table's probe, or null. */
function fakeDb(answers: Record<string, { code?: string } | null | "throw">) {
  const asked: Record<string, string> = {};
  const usedHead: string[] = [];
  const db = {
    from: (table: string) => ({
      select: (cols: string, opts?: { head?: boolean }) => {
        asked[table] = cols;
        if (opts?.head) usedHead.push(table);
        const q = {
          limit: () => q,
          abortSignal: () =>
            answers[table] === "throw"
              ? Promise.reject(new Error("timeout"))
              : Promise.resolve({ error: answers[table] ?? null }),
        };
        return q;
      },
    }),
  };
  return { db: db as never, asked, usedHead };
}

const need = { profiles: ["counselor_approved_at", "role"], counselor_access_requests: ["token_hash"] };

test("nothing is missing when every probe succeeds", async () => {
  const { db, asked } = fakeDb({});
  assert.deepEqual(await missingSchema(db, need), []);
  assert.equal(asked.profiles, "counselor_approved_at,role");
});

test("a missing column is reported by table and columns", async () => {
  const { db } = fakeDb({ profiles: { code: "42703" } });
  assert.deepEqual(await missingSchema(db, need), ["profiles(counselor_approved_at, role)"]);
});

test("a missing table is reported, in either form PostgREST uses", async () => {
  assert.equal((await missingSchema(fakeDb({ counselor_access_requests: { code: "42P01" } }).db, need)).length, 1);
  assert.equal((await missingSchema(fakeDb({ counselor_access_requests: { code: "PGRST205" } }).db, need)).length, 1);
});

test("permission denied means the table is there", async () => {
  assert.deepEqual(await missingSchema(fakeDb({ counselor_access_requests: { code: "42501" } }).db, need), []);
});

test("a timeout or an unknown error is not called a missing schema", async () => {
  assert.deepEqual(await missingSchema(fakeDb({ profiles: "throw" }).db, need), []);
  assert.deepEqual(await missingSchema(fakeDb({ profiles: { code: "57014" } }).db, need), []);
});

test("the list names the column every signed-in request reads", () => {
  assert.ok(REQUIRED_SCHEMA.profiles.includes("counselor_approved_at"));
});

test("the probe is a GET, never a HEAD: a HEAD error has no body, so no code to read", async () => {
  // Seen against a real PostgREST: HEAD on a missing column answers 400 with an
  // empty body, the client reports an error with no code, and the column looked present.
  const { db, usedHead } = fakeDb({});
  await missingSchema(db, need);
  assert.deepEqual(usedHead, []);
});
