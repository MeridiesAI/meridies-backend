// The fail-safes around AxIS: the fallback signal before the stream opens,
// schema errors recognised wherever they surface, and a streamed turn that
// always ends, with a message written for the counselor.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { runAxisTurn } from "../../src/lib/axis/engine.js";
import {
  AXIS_UNAVAILABLE,
  AXIS_UNAVAILABLE_MESSAGE,
  axisReadiness,
  axisUnavailable,
  isSchemaMissing,
  probeAxisSchema,
  resetReadiness,
  runSseTurn,
  TURN_TIMEOUT_MESSAGE,
  unavailableBody,
  type SseSink,
} from "../../src/lib/axis/failsafe.js";
import type { MessagesApi, StreamLike } from "../../src/lib/axis/loop.js";
import { loadHistory, saveState } from "../../src/lib/axis/memory.js";
import { resetFeatures } from "../../src/lib/axis/models.js";
import { HttpError } from "../../src/lib/errors.js";
import { fakeRequest } from "./axis-fakes.js";

const quietLog = { warn: () => undefined, error: () => undefined };

// ---- Recognising a missing migration ------------------------------------------------------

test("schema errors are recognised by their Postgres and PostgREST codes, nothing else", () => {
  for (const code of ["42P01", "42703", "PGRST200", "PGRST202", "PGRST204", "PGRST205"]) assert.equal(isSchemaMissing({ code }), true, code);
  for (const code of ["42501", "23505", "PGRST116", "08006"]) assert.equal(isSchemaMissing({ code }), false, code);
  assert.equal(isSchemaMissing(null), false);
  assert.equal(isSchemaMissing(new Error("42P01")), false);
});

test("the fallback signal is a 503 with code axis_unavailable", () => {
  const e = axisUnavailable();
  assert.ok(e instanceof HttpError);
  assert.equal(e.statusCode, 503);
  assert.equal(e.code, AXIS_UNAVAILABLE);
  assert.deepEqual(unavailableBody(), { error: AXIS_UNAVAILABLE_MESSAGE, message: AXIS_UNAVAILABLE_MESSAGE, code: "axis_unavailable" });
});

type ProbeResult = { error: { code?: string; message?: string } | null };
function probeDb(errors: Record<string, { code: string } | undefined>) {
  const asked: string[] = [];
  return {
    asked,
    db: {
      from(table: string) {
        return {
          select(cols: string) {
            asked.push(`${table}:${cols}`);
            return { limit: (_n: number): PromiseLike<ProbeResult> => Promise.resolve({ error: errors[table] ?? null }) };
          },
        };
      },
    },
  };
}

test("the schema probe reads each new column and table, and reports the first that is missing", async () => {
  const ok = probeDb({});
  assert.equal(await probeAxisSchema(ok.db), null);
  assert.deepEqual(ok.asked.sort(), ["ai_conversations:summary, summary_through, state", "ai_messages:verification", "axis_actions:id"]);
  const missing = probeDb({ axis_actions: { code: "PGRST205" } });
  assert.deepEqual(await probeAxisSchema(missing.db), { code: "PGRST205" });
});

test("no API key: unavailable before any database read", async () => {
  resetReadiness();
  let probed = 0;
  const r = await axisReadiness({ hasKey: false, probe: async () => (probed++, null) });
  assert.deepEqual(r, { ok: false, reason: "no_key" });
  assert.equal(probed, 0);
});

test("a missing migration is remembered for 30 seconds, then probed again; ready is remembered for good", async () => {
  resetReadiness();
  let probed = 0;
  let answer: { code: string } | null = { code: "42703" };
  const probe = async () => (probed++, answer);
  assert.deepEqual(await axisReadiness({ hasKey: true, probe, now: 1_000 }), { ok: false, reason: "schema" });
  assert.deepEqual(await axisReadiness({ hasKey: true, probe, now: 20_000 }), { ok: false, reason: "schema" });
  assert.equal(probed, 1);
  answer = null; // the migration was applied
  assert.deepEqual(await axisReadiness({ hasKey: true, probe, now: 31_001 }), { ok: true });
  assert.deepEqual(await axisReadiness({ hasKey: true, probe, now: 99_000 }), { ok: true });
  assert.equal(probed, 2);
  resetReadiness();
});

test("a transient probe failure is unavailable but not remembered", async () => {
  resetReadiness();
  let probed = 0;
  const flaky = async () => (probed++, probed === 1 ? { code: "08006" } : null);
  assert.deepEqual(await axisReadiness({ hasKey: true, probe: flaky, now: 0 }), { ok: false, reason: "probe_failed" });
  assert.deepEqual(await axisReadiness({ hasKey: true, probe: flaky, now: 1 }), { ok: true });
  resetReadiness();
  const throws = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await axisReadiness({ hasKey: true, probe: throws, log: quietLog }), { ok: false, reason: "probe_failed" });
  resetReadiness();
});

// ---- The streamed turn always ends ---------------------------------------------------------

function sink() {
  const chunks: string[] = [];
  let ended = false;
  const s: SseSink & { chunks: string[]; events: () => [string, unknown][] } = {
    chunks,
    write: (c) => void chunks.push(c),
    end: () => void (ended = true),
    get ended() {
      return ended;
    },
    events: () =>
      chunks
        .filter((c) => c.startsWith("event: "))
        .map((c) => {
          const [ev, data] = c.trim().split("\n");
          return [ev!.slice(7), JSON.parse(data!.slice(6))] as [string, unknown];
        }),
  };
  return s;
}

test("an internal error ends the stream with one error event in our words, never the raw message", async () => {
  const s = sink();
  const t = runSseTurn({
    sink: s,
    log: quietLog,
    work: async ({ emit }) => {
      emit("status", { phase: "thinking" });
      throw new Error("401 invalid x-api-key sk-ant-REDACTED at https://api.anthropic.com");
    },
  });
  await t.settled;
  assert.deepEqual(s.events(), [["status", { phase: "thinking" }], ["error", { message: AXIS_UNAVAILABLE_MESSAGE }]]);
  assert.equal(s.ended, true);
  assert.ok(!s.chunks.join("").includes("sk-ant"));
});

test("an HttpError's own message reaches the counselor (a quota, a forbidden student)", async () => {
  const s = sink();
  await runSseTurn({ sink: s, log: quietLog, work: async () => { throw new HttpError(429, "You've hit today's AI limit. It resets at midnight."); } }).settled;
  assert.deepEqual(s.events(), [["error", { message: "You've hit today's AI limit. It resets at midnight." }]]);
});

test("a turn that never settles is ended by the hard timeout, with its signal aborted", async () => {
  const s = sink();
  let seen: AbortSignal | null = null;
  runSseTurn({
    sink: s,
    log: quietLog,
    timeoutMs: 30,
    work: ({ signal }) => {
      seen = signal;
      return new Promise<void>(() => undefined); // ignores the signal on purpose
    },
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.ended, true);
  assert.equal(seen!.aborted, true);
  assert.deepEqual(s.events(), [["error", { message: TURN_TIMEOUT_MESSAGE }]]);
});

test("after done, neither a timeout nor a failure adds an error event", async () => {
  const late = sink();
  runSseTurn({
    sink: late,
    log: quietLog,
    timeoutMs: 30,
    work: async ({ emit, markDone }) => {
      emit("done", { messageId: "m1" });
      markDone();
      await new Promise<void>(() => undefined);
    },
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(late.events(), [["done", { messageId: "m1" }]]);
  assert.equal(late.ended, true);

  const failing = sink();
  await runSseTurn({
    sink: failing,
    log: quietLog,
    work: async ({ emit, markDone }) => {
      emit("done", { messageId: "m2" });
      markDone();
      throw new Error("verification write failed");
    },
  }).settled;
  assert.deepEqual(failing.events(), [["done", { messageId: "m2" }]]);
});

test("the client closing aborts the turn and nothing more is written", async () => {
  const s = sink();
  let seen: AbortSignal | null = null;
  let release: () => void = () => undefined;
  const t = runSseTurn({
    sink: s,
    log: quietLog,
    work: async ({ signal, emit }) => {
      seen = signal;
      emit("status", { phase: "thinking" });
      await new Promise<void>((r) => (release = r));
      emit("delta", { text: "too late" });
      throw new Error("aborted");
    },
  });
  t.clientClosed();
  assert.equal(seen!.aborted, true);
  release();
  await t.settled;
  assert.deepEqual(s.events(), [["status", { phase: "thinking" }]]);
});

// ---- The engine: sanitised failures and abort propagation ---------------------------------

const TABLES = {
  profiles: [{ id: "s1", full_name: "Sophia Martinez", counselor_id: "counselor-1", role: "student", archived_at: null, grad_year: 2027, high_school: "Lincoln High" }],
  colleges: [],
  deliverables: [],
  deadlines: [],
  red_flags: [],
  meetings: [],
  accountability_settings: [],
  practice_settings: [],
  "rpc:crm_my_workspace": [{ firm_id: null, is_admin: false }],
  ai_conversations: [{ id: "conv-1", summary: null, summary_through: null, state: null }],
  ai_messages: [],
};

/** A model that records the signal it was handed, then waits for it or fails as told. */
function hangingApi(o: { fail?: unknown } = {}) {
  const signals: AbortSignal[] = [];
  const api: MessagesApi = {
    stream(_params, options) {
      if (options?.signal) signals.push(options.signal);
      const final = new Promise<Anthropic.Beta.BetaMessage>((_, reject) => {
        if (o.fail) return void queueMicrotask(() => reject(o.fail));
        options?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true });
      });
      const stream = { on: () => stream, finalMessage: () => final } as unknown as StreamLike;
      return stream;
    },
  };
  return { api, signals };
}

const judgement = "Should Sophia apply early decision somewhere, given how her year is going?";

test("a model failure mid-turn reaches the route as our 503, not the SDK's text", async () => {
  resetFeatures();
  const { api } = hangingApi({ fail: new Error("upstream said: invalid x-api-key sk-ant-REDACTED") });
  await assert.rejects(
    runAxisTurn({ request: fakeRequest(TABLES), conversationId: "conv-1", studentId: null, content: judgement, emit: () => undefined, signal: new AbortController().signal, api }),
    (err: unknown) => err instanceof HttpError && err.statusCode === 503 && !err.message.includes("sk-ant")
  );
});

test("closing the panel aborts the model stream itself", async () => {
  resetFeatures();
  const { api, signals } = hangingApi();
  const ctl = new AbortController();
  const run = runAxisTurn({ request: fakeRequest(TABLES), conversationId: "conv-1", studentId: null, content: judgement, emit: () => undefined, signal: ctl.signal, api });
  while (!signals.length) await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  await assert.rejects(run);
  assert.equal(signals[0]!.aborted, true);
});

// ---- Memory without the migration ---------------------------------------------------------

/** A db whose ai_conversations reads fail as if the memory columns were missing. */
function noMemoryColumns(messages: Record<string, unknown>[]) {
  const base = fakeRequest({ ai_messages: messages });
  const missing = { data: null, error: { code: "42703", message: "column ai_conversations.summary does not exist" } };
  const conversations = {
    select: () => conversations,
    update: () => conversations,
    eq: () => conversations,
    maybeSingle: () => conversations,
    then: (resolve: (r: unknown) => unknown) => Promise.resolve(missing).then(resolve),
  };
  const db = base.db as unknown as { from(t: string): unknown };
  const from = db.from.bind(db);
  return { ...base, db: { from: (t: string) => (t === "ai_conversations" ? conversations : from(t)) } } as unknown as FastifyRequest;
}

test("before the migration, history is the recent turns alone and saving state is skipped, not thrown", async () => {
  const now = Date.now();
  const request = noMemoryColumns([
    { conversation_id: "conv-1", role: "user", content: "Who is behind?", created_at: new Date(now - 2000).toISOString() },
    { conversation_id: "conv-1", role: "assistant", content: "Sophia is first [S1]", created_at: new Date(now - 1000).toISOString() },
  ]);
  const h = await loadHistory(request, "conv-1");
  assert.equal(h.summary, null);
  assert.equal(h.state, null);
  assert.deepEqual(h.turns, [{ role: "user", content: "Who is behind?" }, { role: "assistant", content: "Sophia is first" }]);
  await saveState(request, "conv-1", { students: [], colleges: [], at: new Date().toISOString() });
});
