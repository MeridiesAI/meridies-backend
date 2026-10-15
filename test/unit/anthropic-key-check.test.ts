import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { createKeyCheck, keyRejected, withDeadline, type KeyCheckLog } from "../../src/lib/anthropicKeyCheck.js";

const MIN = 60_000;

/** A real SDK error for `status`, built the way the SDK builds them from a response. */
const apiError = (status: number, message = "x") => APIError.generate(status, { error: { message } }, message, new Headers());

/** A fake models.list: each call takes the next scripted outcome. */
function harness(outcomes: Array<"ok" | unknown>) {
  let t = 0;
  let calls = 0;
  const logs: Array<{ level: "warn" | "info"; o: object; m: string }> = [];
  const log: KeyCheckLog = {
    warn: (o, m) => logs.push({ level: "warn", o, m }),
    info: (o, m) => logs.push({ level: "info", o, m }),
  };
  const kc = createKeyCheck({
    now: () => t,
    list: async () => {
      const next = outcomes[calls++];
      if (next === "ok") return { data: [] };
      throw next;
    },
  });
  return {
    check: () => kc.check(log),
    peek: kc.peek,
    advance: (ms: number) => {
      t += ms;
    },
    calls: () => calls,
    logs,
  };
}

test("the SDK's own classes: 401 and 403 are refusals, the rest carry another status or none", () => {
  assert.ok(apiError(401) instanceof AuthenticationError);
  assert.ok(apiError(403) instanceof PermissionDeniedError);
  assert.equal(new APIConnectionTimeoutError().status, undefined);
  assert.equal(new APIConnectionError({ message: "down" }).status, undefined);
  assert.equal(new APIUserAbortError().status, undefined);
  // `name` is "Error" on every SDK error, which is why nothing here reads it.
  assert.equal(new APIConnectionTimeoutError().name, "Error");
});

test("keyRejected: only 401 and 403", () => {
  assert.equal(keyRejected(apiError(401)), true);
  assert.equal(keyRejected(apiError(403)), true);
  assert.equal(keyRejected(Object.assign(new Error("x"), { status: 401 })), true);
  assert.equal(keyRejected({ status: 403 }), true);
  for (const err of [
    new APIConnectionTimeoutError(),
    new APIConnectionError({ message: "x" }),
    new APIUserAbortError(),
    apiError(400),
    apiError(404),
    apiError(429),
    apiError(500),
    apiError(529),
    new Error("plain"),
    { status: undefined },
    { status: 0 },
    { status: "401" },
    { status: null },
    null,
    undefined,
    "401",
  ]) {
    assert.equal(keyRejected(err), false, String((err as { constructor?: { name?: string } })?.constructor?.name ?? err));
  }
});

test("an accepted key reads true and isn't asked again for ten minutes", async () => {
  const h = harness(["ok", "ok"]);
  assert.equal(await h.check(), true);
  h.advance(10 * MIN - 1);
  assert.equal(await h.check(), true);
  assert.equal(h.calls(), 1);
  h.advance(1);
  assert.equal(await h.check(), true);
  assert.equal(h.calls(), 2);
});

test("a 401 reads false, and so does a 403", async () => {
  assert.equal(await harness([apiError(401)]).check(), false);
  assert.equal(await harness([apiError(403)]).check(), false);
});

test("before any firm answer, every inconclusive failure reads null", async () => {
  for (const err of [
    new APIConnectionTimeoutError(),
    new APIConnectionError({ message: "x" }),
    new APIUserAbortError(),
    apiError(429),
    new RateLimitError(429, undefined, "x", new Headers()),
    apiError(500),
    new InternalServerError(503, undefined, "x", new Headers()),
    apiError(529),
    apiError(400),
    apiError(404),
    new TypeError("fetch failed"),
    "a thrown string",
  ]) {
    const h = harness([err]);
    assert.equal(await h.check(), null);
    assert.equal(h.peek(), null);
  }
});

test("true, then a timeout ten minutes later: still true; then a 401 a minute later: false", async () => {
  const h = harness(["ok", new APIConnectionTimeoutError(), apiError(401)]);
  assert.equal(await h.check(), true);
  h.advance(10 * MIN);
  assert.equal(await h.check(), true);
  h.advance(MIN);
  assert.equal(await h.check(), false);
  assert.equal(h.calls(), 3);
});

test("false (401), then a 503: still false", async () => {
  const h = harness([apiError(401), apiError(503)]);
  assert.equal(await h.check(), false);
  h.advance(MIN);
  assert.equal(await h.check(), false);
  assert.equal(h.calls(), 2);
});

test("after an inconclusive check, the next ask waits a minute", async () => {
  const h = harness([apiError(500), "ok"]);
  assert.equal(await h.check(), null);
  h.advance(MIN - 1);
  assert.equal(await h.check(), null);
  assert.equal(h.calls(), 1);
  h.advance(1);
  assert.equal(await h.check(), true);
  assert.equal(h.calls(), 2);
});

test("an inconclusive check doesn't extend the life of an accepted key", async () => {
  // true at 0; at 10 min a timeout keeps true and schedules a minute later;
  // at 11 min Anthropic is asked again rather than trusting the old answer for another ten.
  const h = harness(["ok", new APIConnectionTimeoutError(), "ok"]);
  await h.check();
  h.advance(10 * MIN);
  assert.equal(await h.check(), true);
  h.advance(MIN);
  assert.equal(await h.check(), true);
  assert.equal(h.calls(), 3);
});

test("a refusal is asked again after a minute, so a fixed key shows up", async () => {
  const h = harness([apiError(401), "ok"]);
  assert.equal(await h.check(), false);
  h.advance(MIN);
  assert.equal(await h.check(), true);
});

test("concurrent checks share one call", async () => {
  let resolve!: () => void;
  let calls = 0;
  const kc = createKeyCheck({
    list: () => {
      calls++;
      return new Promise<void>((r) => {
        resolve = r;
      });
    },
  });
  const a = kc.check();
  const b = kc.check();
  await new Promise((r) => setImmediate(r)); // list starts on the next microtask
  resolve();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(calls, 1);
});

test("a list that throws synchronously reads null and doesn't reject", async () => {
  const kc = createKeyCheck({
    list: () => {
      throw new Error("sync");
    },
  });
  assert.equal(await kc.check(), null);
});

test("peek is null before an answer and the firm answer after one, without asking", async () => {
  const h = harness(["ok"]);
  assert.equal(h.peek(), null);
  await h.check();
  assert.equal(h.peek(), true);
  assert.equal(h.calls(), 1);
});

test("the log names the error's class and status, never its message", async () => {
  const secret = "sk-ant-api03-SECRETSECRET";
  const h = harness([new APIConnectionTimeoutError({ message: `timed out ${secret}` }), apiError(429, secret), apiError(401, secret)]);
  await h.check();
  h.advance(MIN);
  await h.check();
  h.advance(MIN);
  await h.check();
  assert.deepEqual(
    h.logs.map((l) => [l.level, (l.o as { type?: string }).type, (l.o as { status?: number }).status]),
    [
      ["info", "APIConnectionTimeoutError", undefined],
      ["info", "RateLimitError", 429],
      ["warn", "AuthenticationError", 401],
    ],
  );
  assert.ok(!JSON.stringify(h.logs).includes(secret));
});

test("withDeadline: a slower promise gives the fallback, and keeps running", async () => {
  let settled = false;
  const slow = new Promise<boolean | null>((r) => setTimeout(() => {
    settled = true;
    r(true);
  }, 60));
  assert.equal(await withDeadline(slow, 10, () => null), null);
  assert.equal(settled, false);
  assert.equal(await slow, true);
});

test("withDeadline: a faster promise gives its own value and clears the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fellBack = false;
  const v = await withDeadline(Promise.resolve(false), 2000, () => {
    fellBack = true;
    return null;
  });
  assert.equal(v, false);
  // If the timer were still pending, running the clock past it would call the fallback.
  t.mock.timers.tick(5000);
  assert.equal(fellBack, false);
});

test("withDeadline: the fallback reads the cache at the deadline, not before", async () => {
  const kc = createKeyCheck({ list: () => new Promise(() => {}) });
  assert.equal(await withDeadline(kc.check(), 5, kc.peek), null);
});

// test/env.ts sets no ANTHROPIC_API_KEY; a shell that exports one skips this.
test("anthropicKeyWorks without a key reads false without asking Anthropic", { skip: Boolean(process.env.ANTHROPIC_API_KEY) }, async () => {
  const { anthropicKeyWorks } = await import("../../src/lib/anthropic.js");
  const { hasAnthropic } = await import("../../src/env.js");
  assert.equal(hasAnthropic, false);
  assert.equal(await anthropicKeyWorks(undefined, { waitMs: 10 }), false);
  assert.equal(await anthropicKeyWorks(), false);
});
