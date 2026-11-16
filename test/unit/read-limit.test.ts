// lib/readLimit.ts and the limit() preHandler in lib/limits.ts: a read (GET, HEAD) is decided from an in-process
// mirror of the durable counter and counted durably without waiting; a write still waits for the durable counter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { limit } from "../../src/lib/limits.js";
import { decideRead, ReadLimiter } from "../../src/lib/readLimit.js";

function clock(start = 5_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** The durable counter: the same fixed-window arithmetic, with a count that can be set from outside (another replica). */
function durableCounter(limitValue: number) {
  let count = 0;
  let calls = 0;
  return {
    consume: async () => { calls += 1; count += 1; return count <= limitValue; },
    calls: () => calls,
    set: (n: number) => { count = n; },
  };
}

/** Let un-awaited durable answers land. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("in one process the 429 lands on the same request number as the durable counter's", async () => {
  const limiter = new ReadLimiter();
  const durable = durableCounter(60);
  const answers: boolean[] = [];
  for (let i = 0; i < 62; i++) answers.push(await decideRead(limiter, "guardians:roster:u1", 60, 60, durable.consume));
  assert.deepEqual(answers.slice(0, 60), Array(60).fill(true));
  assert.equal(answers[60], false, "the 61st is the first refused");
  assert.equal(answers[61], false);
  await settle();
  assert.equal(durable.calls(), 62, "every request, allowed or refused, is counted durably exactly once");
});

test("an allowed read does not wait for the durable counter", async () => {
  const limiter = new ReadLimiter();
  let release: (under: boolean) => void = () => {};
  let started = 0;
  const slow = () => { started += 1; return new Promise<boolean>((resolve) => { release = resolve; }); };
  assert.equal(await decideRead(limiter, "k", 5, 60, slow), true, "answered while the durable call is still out");
  await settle();
  assert.equal(started, 1);
  release(true);
});

test("keys are separate: one user's reads don't count against another's", async () => {
  const limiter = new ReadLimiter();
  const ok = async () => true;
  assert.equal(await decideRead(limiter, "list:a", 1, 60, ok), true);
  assert.equal(await decideRead(limiter, "list:a", 1, 60, ok), false);
  assert.equal(await decideRead(limiter, "list:b", 1, 60, ok), true);
});

test("a new window starts once the old one is as old as the window", async () => {
  const c = clock();
  const limiter = new ReadLimiter({ now: c.now });
  const ok = async () => true;
  assert.equal(await decideRead(limiter, "k", 2, 60, ok), true);
  assert.equal(await decideRead(limiter, "k", 2, 60, ok), true);
  assert.equal(await decideRead(limiter, "k", 2, 60, ok), false);
  c.advance(59_999);
  assert.equal(await decideRead(limiter, "k", 2, 60, ok), false, "still the same window");
  c.advance(1);
  assert.equal(await decideRead(limiter, "k", 2, 60, ok), true, "the window is 60 s old: a new one");
});

test("a durable 'over' answer is honoured: later requests in the window wait for the durable counter and are refused", async () => {
  const c = clock();
  const limiter = new ReadLimiter({ now: c.now });
  const durable = durableCounter(60);
  durable.set(60); // another replica (or this one before a restart) already spent the window
  assert.equal(await decideRead(limiter, "k", 60, 60, durable.consume), true, "this process had not heard yet");
  await settle();
  assert.equal(await decideRead(limiter, "k", 60, 60, durable.consume), false, "now it has: refused though the local count is 2");
  assert.equal(await decideRead(limiter, "k", 60, 60, durable.consume), false);

  // Once the durable window has rolled over, the durable answer lets requests through again.
  durable.set(0);
  assert.equal(await decideRead(limiter, "k", 60, 60, durable.consume), true);

  // And a new local window is no longer strict: it answers without waiting.
  c.advance(60_000);
  let release: (under: boolean) => void = () => {};
  const slow = () => new Promise<boolean>((resolve) => { release = resolve; });
  assert.equal(await decideRead(limiter, "k", 60, 60, slow), true);
  release(true);
});

test("a late 'over' answer for a key whose bucket is gone changes nothing", () => {
  const limiter = new ReadLimiter();
  limiter.markOver("never-seen");
  assert.equal(limiter.size, 0);
  assert.deepEqual(limiter.hit("never-seen", 5, 60), { allowed: true, strict: false });
});

test("a durable call that fails is reported, never thrown, and the read goes ahead", async () => {
  const limiter = new ReadLimiter();
  const seen: unknown[] = [];
  const broken = async () => { throw new Error("rpc down"); };
  assert.equal(await decideRead(limiter, "k", 5, 60, broken, (err) => seen.push(err)), true);
  await settle();
  assert.equal(seen.length, 1);
  assert.match(String(seen[0]), /rpc down/);

  // Even when the reporter itself throws, and even on the strict path where the answer is awaited.
  limiter.markOver("k");
  assert.equal(await decideRead(limiter, "k", 5, 60, broken, () => { throw new Error("logger down"); }), true);
});

test("the map is bounded and ended windows are swept", () => {
  const c = clock();
  const limiter = new ReadLimiter({ maxKeys: 3, now: c.now });
  for (const k of ["a", "b", "c"]) limiter.hit(k, 5, 60);
  assert.equal(limiter.size, 3);
  limiter.hit("d", 5, 60);
  assert.equal(limiter.size, 3, "the oldest live key made room");
  assert.deepEqual(limiter.hit("a", 5, 60), { allowed: true, strict: false }, "a starts again from one");

  c.advance(60_000);
  limiter.sweep();
  assert.equal(limiter.size, 0);

  // A full map drops ended windows before any live one.
  limiter.hit("short", 5, 1);
  limiter.hit("long-1", 5, 3600);
  limiter.hit("long-2", 5, 3600);
  c.advance(1000);
  limiter.hit("new", 5, 60);
  assert.equal(limiter.size, 3);
  assert.equal(limiter.hit("long-1", 5, 3600).allowed, true);
  assert.equal(limiter.size, 3, "long-1 was still there: only the ended window went");
});

// ---- limit(): the preHandler. No service key in unit tests, so the durable counter is the in-process fallback. ----

const req = (userId: string, method?: string) => ({ auth: { userId }, method });
const statusOf = async (run: Promise<void>): Promise<number> => run.then(() => 200, (err: { statusCode?: number }) => err.statusCode ?? 500);

test("limit(): a GET is refused on exactly the request after the limit, with the route's message", async () => {
  const handler = limit("unit-read-limit:get", 3, 60, "Slow down a little.");
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push(await statusOf(handler(req("user-get", "GET"))));
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  await assert.rejects(handler(req("user-get", "GET")), /Slow down a little\./);
  assert.equal(await statusOf(handler(req("someone-else", "GET"))), 200, "per user");
});

test("limit(): HEAD is a read too", async () => {
  const handler = limit("unit-read-limit:head", 1, 60);
  assert.deepEqual([await statusOf(handler(req("u", "HEAD"))), await statusOf(handler(req("u", "HEAD")))], [200, 429]);
});

test("limit(): a write waits for the durable counter and is refused on the same request number as before", async () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE", undefined]) {
    const handler = limit(`unit-read-limit:write:${method}`, 3, 60);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push(await statusOf(handler(req("user-write", method))));
    assert.deepEqual(statuses, [200, 200, 200, 429, 429], String(method));
  }
});

test("limit(): reads and writes of one name share the durable count, so a read after the writes spent it is refused once that is heard", async () => {
  const handler = limit("unit-read-limit:shared", 2, 60);
  assert.equal(await statusOf(handler(req("u", "POST"))), 200);
  assert.equal(await statusOf(handler(req("u", "POST"))), 200);
  assert.equal(await statusOf(handler(req("u", "POST"))), 429);
  // The first read is decided locally (this process has seen no reads), and the durable answer arrives after it.
  assert.equal(await statusOf(handler(req("u", "GET"))), 200);
  await settle();
  assert.equal(await statusOf(handler(req("u", "GET"))), 429);
});
