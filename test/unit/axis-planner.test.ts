// The evidence planner's time limits: a step past its limit is skipped AND its database queries are cancelled
// (not left running), and every step's time is reported for the turn log, keyed without names.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { abortableDb, gatherEvidence, STEP_TIMEOUT_MS, type PlanContext } from "../../src/lib/axis/planner.js";
import { SourceLedger } from "../../src/lib/axis/ledger.js";
import type { Understanding } from "../../src/lib/axis/nlu.js";

const STUDENT = "00000000-0000-4000-8000-0000000000a1";

/** A db whose every query records the signal it was given; `hang` makes queries wait until that signal aborts. */
function fakeDb(o: { hang: boolean; rows?: Record<string, unknown>[] }) {
  const signals: (AbortSignal | undefined)[] = [];
  const builder = () => {
    let signal: AbortSignal | undefined;
    let single = false;
    const chain: Record<string, unknown> = {
      abortSignal(s: AbortSignal) {
        signal = s;
        return chain;
      },
      maybeSingle() {
        single = true;
        return chain;
      },
      then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) {
        signals.push(signal);
        if (!o.hang) return Promise.resolve({ data: single ? (o.rows?.[0] ?? null) : (o.rows ?? []), error: null }).then(resolve, reject);
        return new Promise((_, rej) => {
          if (!signal) return; // never settles: the bug this guards against
          if (signal.aborted) return rej(new Error("AbortError"));
          signal.addEventListener("abort", () => rej(new Error("AbortError")), { once: true });
        }).then(resolve, reject);
      },
    };
    for (const m of ["select", "eq", "order", "limit", "neq", "gte", "lte", "in", "is", "not", "or", "ilike"]) chain[m] = () => chain;
    return chain;
  };
  return { db: { from: () => builder(), rpc: () => builder() }, signals };
}

function request(db: unknown): FastifyRequest {
  return {
    auth: { userId: "c0000000-0000-4000-8000-000000000001" },
    profile: { role: "counselor" },
    db,
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
  } as unknown as FastifyRequest;
}

const roster = { get: (id: string) => (id === STUDENT ? { name: "Ada Lovelace" } : undefined), size: 1 };
const dueQuestion = {
  intent: "record", clauses: [{ intent: "record" }], students: [], ambiguousStudents: [], colleges: [], ambiguousColleges: [], attributes: ["deadline"],
  window: { from: null, to: "2027-01-31", label: "by January" }, norm: "what is due by january", text: "What is due by January?",
  keywords: [], form: "lookup", judgement: false,
} as unknown as Understanding;

function ctx(req: FastifyRequest, extra: Partial<PlanContext> = {}): PlanContext {
  return {
    request: req, u: dueQuestion, chatStudentId: null, roster: roster as unknown as PlanContext["roster"], ledger: new SourceLedger(),
    connected: [], retrievalReady: false, speculative: Promise.resolve([]), signal: new AbortController().signal, onStep: () => undefined,
    ...extra,
  };
}

test("the step limit is one named constant, still 2.5 seconds", () => {
  assert.equal(STEP_TIMEOUT_MS, 2_500);
});

test("a step past its limit is skipped and its database queries are cancelled", async () => {
  const { db, signals } = fakeDb({ hang: true });
  const started = Date.now();
  const ev = await gatherEvidence(ctx(request(db), { stepTimeoutMs: 40 }));
  assert.ok(Date.now() - started < 1_000, "the planner didn't wait for the slow query");
  assert.deepEqual(ev.skipped, ["Checking what's due by January"]);
  assert.ok(signals.length > 0, "the step reached the database");
  assert.ok(signals.every((s) => s?.aborted), "every query the step started was given a signal that is now aborted");
  assert.deepEqual(ev.timings.map((t) => [t.step, t.outcome]), [["upcoming", "timeout"]]);
});

test("the turn being cancelled cancels the step's queries too", async () => {
  const { db, signals } = fakeDb({ hang: true });
  const turn = new AbortController();
  const p = gatherEvidence(ctx(request(db), { signal: turn.signal, stepTimeoutMs: 60_000 }));
  await new Promise((r) => setTimeout(r, 20));
  turn.abort();
  const ev = await p;
  assert.deepEqual(ev.skipped, ["Checking what's due by January"]);
  assert.ok(signals.length > 0 && signals.every((s) => s?.aborted));
});

test("each step reports its time in ms and its outcome, keyed without names", async () => {
  const { db } = fakeDb({ hang: false });
  const named = { ...dueQuestion, intent: "record", students: [{ id: STUDENT, name: "Ada Lovelace" }] } as unknown as Understanding;
  const ev = await gatherEvidence(ctx(request(db), { u: named }));
  const steps = ev.timings.map((t) => t.step).sort();
  assert.deepEqual(steps, ["student_record", "upcoming"]);
  for (const t of ev.timings) {
    assert.equal(typeof t.ms, "number");
    assert.ok(t.ms >= 0 && t.ms < 2_500);
    assert.ok(["ok", "timeout", "error"].includes(t.outcome));
  }
  assert.doesNotMatch(JSON.stringify(ev.timings), /Ada|Lovelace/);
});

test("abortableDb attaches the signal to every table query and rpc, and leaves the rest alone", () => {
  const seen: AbortSignal[] = [];
  const b = () => {
    const chain: Record<string, unknown> = { abortSignal: (s: AbortSignal) => (seen.push(s), chain), eq: () => chain };
    return chain;
  };
  const raw = { from: () => ({ select: () => b(), insert: () => b() }), rpc: () => b(), channel: () => "channel", url: "u" };
  const ac = new AbortController();
  const db = abortableDb(raw, ac.signal) as typeof raw;
  (db.from() as { select: () => { eq: () => unknown } }).select().eq();
  (db.from() as { insert: () => unknown }).insert();
  db.rpc();
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s === ac.signal));
  assert.equal(db.channel(), "channel");
  assert.equal(db.url, "u");
});
