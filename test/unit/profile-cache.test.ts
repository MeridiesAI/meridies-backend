// lib/profileCache.ts: the caller's profile row shared between requests. De-duplication always; a short cache only
// when a TTL is set; a failed read, "no row" and anything evicted are never kept. And lib/authFaults.ts: which
// failures of sign-in are the token's (401) and which are an outage (503 auth_unavailable).
import assert from "node:assert/strict";
import { test } from "node:test";
import { errors as jose } from "jose";
import { AUTH_UNAVAILABLE, authUnavailable, isTokenFault, isTokenRejectedByDatabase } from "../../src/lib/authFaults.js";
import { ProfileCache } from "../../src/lib/profileCache.js";

type Row = { id: string; role: string };
const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";

/** A loader that counts its calls and answers when the test says so. */
function gated() {
  let calls = 0;
  const waiting: Array<{ resolve: (row: Row | null) => void; reject: (err: Error) => void }> = [];
  const load = () => {
    calls += 1;
    return new Promise<Row | null>((resolve, reject) => waiting.push({ resolve, reject }));
  };
  return { load, waiting, calls: () => calls };
}

/** Let the cache's own microtasks (it starts a read one tick after `get`) run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("with no TTL every request reads again", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 0 });
  let calls = 0;
  const load = async () => { calls += 1; return { id: U, role: "counselor" }; };
  assert.deepEqual(await cache.get(U, load), { id: U, role: "counselor" });
  assert.deepEqual(await cache.get(U, load), { id: U, role: "counselor" });
  assert.equal(calls, 2);
  assert.equal(cache.size, 0, "nothing is kept between requests");
});

test("requests that arrive while a read is in flight share it, TTL or not", async () => {
  for (const ttlMs of [0, 5000]) {
    const cache = new ProfileCache<Row>({ ttlMs });
    const g = gated();
    const all = Promise.all([cache.get(U, g.load), cache.get(U, g.load), cache.get(U, g.load)]);
    await tick();
    assert.equal(g.calls(), 1, `one read for three requests (ttl ${ttlMs})`);
    g.waiting[0].resolve({ id: U, role: "student" });
    const rows = await all;
    assert.deepEqual(rows, [{ id: U, role: "student" }, { id: U, role: "student" }, { id: U, role: "student" }]);
    assert.notEqual(rows[0], rows[1], "each request gets its own copy");
  }
});

test("another user never shares a read or a cached row", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  assert.deepEqual(await cache.get(U, async () => ({ id: U, role: "counselor" })), { id: U, role: "counselor" });
  assert.deepEqual(await cache.get(V, async () => ({ id: V, role: "student" })), { id: V, role: "student" });
  assert.deepEqual(await cache.get(U, async () => { throw new Error("must not read"); }), { id: U, role: "counselor" });
});

test("a cached row is reused until the TTL passes, then read again", async () => {
  const c = clock();
  const cache = new ProfileCache<Row>({ ttlMs: 5000, now: c.now });
  let calls = 0;
  const load = async () => { calls += 1; return { id: U, role: calls === 1 ? "counselor" : "parent" }; };
  await cache.get(U, load);
  c.advance(4999);
  assert.equal((await cache.get(U, load))?.role, "counselor");
  assert.equal(calls, 1);
  c.advance(1);
  assert.equal((await cache.get(U, load))?.role, "parent", "at the TTL the row is read again");
  assert.equal(calls, 2);
});

test("changing the copy a request was handed changes nobody else's", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  const load = async () => ({ id: U, role: "counselor" });
  const first = await cache.get(U, load);
  assert.ok(first);
  first.role = "student";
  assert.equal((await cache.get(U, load))?.role, "counselor");
});

test("evict makes the next request read again", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  let calls = 0;
  const load = async () => { calls += 1; return { id: U, role: "counselor" }; };
  await cache.get(U, load);
  cache.evict(U);
  await cache.get(U, load);
  assert.equal(calls, 2);
});

test("a read in flight when the user is evicted is cached for nobody, and later requests don't join it", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  const g = gated();
  const before = cache.get(U, g.load);
  await tick();
  cache.evict(U); // the user's write landed while the read was out
  const after = cache.get(U, g.load);
  await tick();
  assert.equal(g.calls(), 2, "the request after the write starts its own read");
  g.waiting[0].resolve({ id: U, role: "stale" });
  g.waiting[1].resolve({ id: U, role: "fresh" });
  assert.equal((await before)?.role, "stale", "the request already waiting still gets its answer");
  assert.equal((await after)?.role, "fresh");
  assert.equal((await cache.get(U, async () => { throw new Error("must not read"); }))?.role, "fresh", "only the newer read was kept");
});

test("a late answer from a read that was evicted does not replace a newer entry", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  const g = gated();
  const old = cache.get(U, g.load);
  await tick();
  cache.evict(U);
  const fresh = cache.get(U, g.load);
  await tick();
  g.waiting[1].resolve({ id: U, role: "fresh" });
  await fresh;
  g.waiting[0].resolve({ id: U, role: "stale" });
  await old;
  assert.equal((await cache.get(U, async () => { throw new Error("must not read"); }))?.role, "fresh");
});

test("a failed read rejects for everyone sharing it and is never kept", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  const g = gated();
  const a = cache.get(U, g.load);
  const b = cache.get(U, g.load);
  await tick();
  g.waiting[0].reject(new Error("database down"));
  const settled = await Promise.allSettled([a, b]);
  for (const s of settled) {
    assert.equal(s.status, "rejected");
    assert.match(String((s as PromiseRejectedResult).reason), /database down/);
  }
  assert.equal(cache.size, 0);
  assert.deepEqual(await cache.get(U, async () => ({ id: U, role: "counselor" })), { id: U, role: "counselor" });
});

test("a loader that throws synchronously is a rejection, not a crash", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  await assert.rejects(cache.get(U, () => { throw new Error("boom"); }), /boom/);
  assert.equal(cache.size, 0);
});

test("'no profile row' is answered and never kept", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000 });
  let calls = 0;
  const load = async () => { calls += 1; return calls === 1 ? null : { id: U, role: "student" }; };
  assert.equal(await cache.get(U, load), null);
  assert.equal(cache.size, 0);
  assert.equal((await cache.get(U, load))?.role, "student", "the row that lands a moment later is seen at once");
});

test("the map is bounded: the oldest user goes first", async () => {
  const cache = new ProfileCache<Row>({ ttlMs: 5000, maxEntries: 3 });
  let reads = 0;
  const loadFor = (id: string) => async () => { reads += 1; return { id, role: "student" }; };
  for (const id of ["a", "b", "c", "d"]) await cache.get(id, loadFor(id));
  assert.equal(cache.size, 3);
  assert.equal(reads, 4);
  await cache.get("b", loadFor("b"));
  assert.equal(reads, 4, "b is still held");
  await cache.get("a", loadFor("a"));
  assert.equal(reads, 5, "a was the oldest and was dropped");
  assert.equal(cache.size, 3);
});

test("token faults are 401s; a key set that can't be fetched, and anything that isn't jose's, is an outage", () => {
  assert.equal(isTokenFault(new jose.JWTExpired("exp", {})), true);
  assert.equal(isTokenFault(new jose.JWTClaimValidationFailed("aud", {})), true);
  assert.equal(isTokenFault(new jose.JWSSignatureVerificationFailed()), true);
  assert.equal(isTokenFault(new jose.JWSInvalid("malformed")), true);
  assert.equal(isTokenFault(new jose.JWTInvalid("malformed")), true);
  assert.equal(isTokenFault(new jose.JWKSNoMatchingKey()), true);
  assert.equal(isTokenFault(new jose.JOSENotSupported("alg")), true);

  assert.equal(isTokenFault(new jose.JWKSTimeout()), false);
  assert.equal(isTokenFault(new jose.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response")), false);
  assert.equal(isTokenFault(new TypeError("fetch failed")), false);
  assert.equal(isTokenFault(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), false);
  assert.equal(isTokenFault(undefined), false);
});

test("only PostgREST's own JWT refusals count as a bad session on the profile read", () => {
  assert.equal(isTokenRejectedByDatabase({ code: "PGRST301" }), true);
  assert.equal(isTokenRejectedByDatabase({ code: "PGRST303" }), true);
  assert.equal(isTokenRejectedByDatabase({ code: "57014" }), false);
  assert.equal(isTokenRejectedByDatabase({ code: "PGRST000" }), false);
  assert.equal(isTokenRejectedByDatabase({}), false);
  assert.equal(isTokenRejectedByDatabase(null), false);
});

test("the outage answer is a 503 carrying the code the app keys on", () => {
  const err = authUnavailable("Try again.");
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "auth_unavailable");
  assert.equal(err.message, "Try again.");
  assert.equal(AUTH_UNAVAILABLE, "auth_unavailable");
});
