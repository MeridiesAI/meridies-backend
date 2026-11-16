// lib/supabase.ts: every Supabase request carries a deadline, except Storage object transfers.
// The base fetch is a stand-in; nothing reaches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isStorageTransfer, withRequestTimeout } from "../../src/lib/supabase.js";

const REST = "http://127.0.0.1:54321/rest/v1/profiles?select=id";
const OBJECT = "http://127.0.0.1:54321/storage/v1/object/student-documents/a/b.pdf";

type Init = { signal?: AbortSignal | null; method?: string; headers?: Record<string, string> };

/** A fetch that never answers on its own: it settles only when its signal aborts. */
function hanging() {
  const seen: Init[] = [];
  const base = ((_input: unknown, init: Init = {}) => {
    seen.push(init);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return reject(new Error("no signal was passed"));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  return { base, seen };
}

/**
 * AbortSignal.timeout's timer is unref'd, so with nothing else pending the event loop would
 * drain before the deadline fires and the runner would cancel the test. A server always has
 * its listening socket; here a ref'd timer holds the loop while the deadline is awaited.
 */
async function holdingLoop<T>(run: () => Promise<T>): Promise<T> {
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    return await run();
  } finally {
    clearTimeout(keepAlive);
  }
}

test("which requests are Storage object transfers", () => {
  assert.equal(isStorageTransfer(OBJECT), true);
  assert.equal(isStorageTransfer("http://127.0.0.1:54321/storage/v1/object/sign/student-documents/a/b.pdf"), true);
  assert.equal(isStorageTransfer("http://127.0.0.1:54321/storage/v1/object/upload/sign/student-banners/a.jpg?token=x"), true);
  assert.equal(isStorageTransfer(REST), false);
  assert.equal(isStorageTransfer("http://127.0.0.1:54321/rest/v1/rpc/consume_rate_limit"), false);
  assert.equal(isStorageTransfer("http://127.0.0.1:54321/storage/v1/bucket"), false);
  assert.equal(isStorageTransfer("http://127.0.0.1:54321/auth/v1/admin/users"), false);
  // A path that only mentions it elsewhere is not one.
  assert.equal(isStorageTransfer("http://127.0.0.1:54321/rest/v1/documents?path=/storage/v1/object/x"), false);
  assert.equal(isStorageTransfer("not a url"), false);
});

test("a stalled request is cut off at the deadline", async () => {
  const { base, seen } = hanging();
  const timed = withRequestTimeout(base, 20);
  const started = Date.now();
  await holdingLoop(() =>
    assert.rejects(timed(REST, { method: "GET", headers: { apikey: "k" } }), (err: unknown) => {
      assert.equal((err as { name?: string }).name, "TimeoutError");
      return true;
    })
  );
  assert.ok(Date.now() - started < 2000);
  // Everything else the caller passed still reaches fetch.
  assert.equal(seen[0]!.method, "GET");
  assert.deepEqual(seen[0]!.headers, { apikey: "k" });
});

test("a request with no init gets the deadline too", async () => {
  const { base, seen } = hanging();
  await holdingLoop(() => assert.rejects(withRequestTimeout(base, 20)(new URL(REST))));
  assert.ok(seen[0]!.signal instanceof AbortSignal);
});

test("the caller's own signal still applies, alongside the deadline", async () => {
  const { base, seen } = hanging();
  const timed = withRequestTimeout(base, 60_000);
  const caller = new AbortController();
  const pending = timed(REST, { signal: caller.signal });
  assert.notEqual(seen[0]!.signal, caller.signal, "composed, not passed through");
  caller.abort(new Error("the caller gave up"));
  await assert.rejects(pending, /the caller gave up/);
});

test("a Storage object transfer has no deadline added", async () => {
  const seen: Init[] = [];
  const base = (async (_input: unknown, init: Init = {}) => {
    seen.push(init);
    return new Response("ok");
  }) as unknown as typeof fetch;
  const timed = withRequestTimeout(base, 20);
  const res = await timed(OBJECT, { method: "POST" });
  assert.equal(await res.text(), "ok");
  assert.equal(seen[0]!.signal, undefined);
  await timed(OBJECT);
  assert.equal(seen.length, 2);
});
