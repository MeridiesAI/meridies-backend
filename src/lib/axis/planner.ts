/**
 * The evidence planner: decides from the understanding what the answer will
 * need, fetches all of it at once, and hands it to the model in the user turn.
 *
 * A tool-calling model finds what it needs one round trip at a time: call,
 * wait, read, call again. Most of those calls are predictable from the
 * question (a named school's figures, another student's record, what is due
 * this week, the passages about the transcript), so the planner makes them
 * before the model starts, in parallel, each under its own time limit. The
 * model then usually answers on its first call; its tools stay available for
 * whatever the plan didn't foresee.
 *
 * The speculative search started with the turn (the raw question against the
 * RAG port, launched before the question was even understood) is folded into
 * the fused document search here, so that work is never wasted.
 *
 * Time limits: each step runs under STEP_TIMEOUT_MS with its own AbortController.
 * When the limit passes (or the turn is cancelled) the step is skipped and the
 * controller aborts, which cancels its database queries (every `request.db`
 * query the step makes carries the signal, see abortableDb) and its searches,
 * so a slow query stops instead of running on after nobody is waiting. Each
 * step's time and outcome go into the "axis turn" log line (engine.ts).
 */
import { errInfo } from "./failsafe.js";
import type { FastifyRequest } from "fastify";
import { resolveStudentId } from "../guards.js";
import { cachedStudentContext, collegeFacts, collegeFactText, isoDay, plain, upcomingItems } from "./data.js";
import type { RosterIndex } from "./entities.js";
import { counselorZone, daysFromToday } from "./tz.js";
import { filterAllowedChunks } from "./guard.js";
import type { SourceLedger } from "./ledger.js";
import type { Intent, Understanding } from "./nlu.js";
import { getConnectors, type ConnectedProvider, type RetrievedChunk } from "./ports.js";
import { fusedSearch, retrievalQueries } from "./retrieval.js";
import { loadRosterRisk } from "./risk.js";
import { readsOutside } from "./tools.js";
import { anyLong, freeBlocks } from "../context/freeText.js";
import { wrapUntrusted } from "../context/pack.js";
import { TRUSTED_SECTIONS } from "../context/profiles.js";

export type PlanContext = {
  request: FastifyRequest;
  u: Understanding;
  chatStudentId: string | null;
  roster: RosterIndex;
  ledger: SourceLedger;
  connected: ConnectedProvider[];
  retrievalReady: boolean;
  /** The free-text rule is on (20261108000004): a question's record of another student is built short-only. */
  freeRule?: boolean;
  /** The raw-question search started at the top of the turn. */
  speculative: Promise<RetrievedChunk[]>;
  signal: AbortSignal;
  onStep: (label: string) => void;
  /** Tests only: a shorter step limit than STEP_TIMEOUT_MS. */
  stepTimeoutMs?: number;
};

/** How long one planner step took, for the turn log. `step` is a fixed key, never a name or a label. */
export type StepTiming = { step: string; ms: number; outcome: "ok" | "timeout" | "error" };

export type Evidence = {
  /** Rendered for the user turn: passages first, then the other blocks. */
  text: string;
  /**
   * A shown block carries text someone other than the counselor wrote (another student's record,
   * a deadline's or a student-added task's title): every change this turn waits for a click.
   */
  outside: boolean;
  /**
   * The narrower rule (lib/context/freeText.ts), used once 20261108000004 is in: a shown block holds free text
   * (another student's document or long student-written value, a deadline or student task title over 80).
   */
  freeText: boolean;
  /** That free text, for the quote check. */
  freeBlocks: { source: string; text: string }[];
  /** Everything read, for the grounding index. */
  raw: string[];
  sources: string[];
  trace: string[];
  skipped: string[];
  timings: StepTiming[];
};

/**
 * Per step. A slow source is skipped and its queries cancelled, not waited on: the model can still ask for it
 * with a tool. The one place the limit is set; to be tuned from the logged step times (about 3x the p95).
 */
export const STEP_TIMEOUT_MS = 2_500;

const UPCOMING_WORDS = /\b(due|deadlines?|coming up|upcoming|next|this week|next week|overdue|behind|schedule|calendar|plan|prioriti[sz]e)\b/;

type Free = { source: string; text: string }[];
/** What a step runs with: a request whose db queries carry `signal`, and `signal` itself for searches. */
type StepScope = { request: FastifyRequest; signal: AbortSignal };
type Step = { key: string; label: string; source: string; run: (scope: StepScope) => Promise<string | null>; outside?: () => boolean; free?: () => Free };

function intentsOf(u: Understanding): Set<Intent> {
  return new Set<Intent>([u.intent, ...u.clauses.map((c) => c.intent)]);
}

const BUILDER_METHODS = new Set(["select", "insert", "upsert", "update", "delete"]);
const withSignal = (b: unknown, signal: AbortSignal): unknown =>
  b && typeof (b as { abortSignal?: unknown }).abortSignal === "function" ? (b as { abortSignal: (s: AbortSignal) => unknown }).abortSignal(signal) : b;

/**
 * The Supabase client with `signal` attached to every query it builds (`from(...).select/insert/...` and `rpc`),
 * so aborting the signal cancels the HTTP request. Everything else passes through. Exported for tests.
 */
export function abortableDb<T extends object>(db: T, signal: AbortSignal): T {
  return new Proxy(db, {
    // Reads go to the real objects (not the proxy) so getters and private fields keep working.
    get(target, prop) {
      const v = Reflect.get(target, prop) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "rpc") return (...args: unknown[]) => withSignal((v as (...a: unknown[]) => unknown).apply(target, args), signal);
      if (prop === "from") {
        return (...args: unknown[]) => {
          const qb = (v as (...a: unknown[]) => unknown).apply(target, args) as object;
          return new Proxy(qb, {
            get(t, p) {
              const m = Reflect.get(t, p) as unknown;
              if (typeof m !== "function") return m;
              const fn = m as (...a: unknown[]) => unknown;
              return BUILDER_METHODS.has(String(p)) ? (...a: unknown[]) => withSignal(fn.apply(t, a), signal) : fn.bind(t);
            },
          });
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/** The request as a step sees it: the same request, with db queries that stop when `signal` aborts. */
function scopedRequest(request: FastifyRequest, signal: AbortSignal): FastifyRequest {
  const db = abortableDb(request.db, signal);
  return new Proxy(request, {
    get(t, p) {
      if (p === "db") return db;
      const v = Reflect.get(t, p) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** Runs a step under its own limit. On the limit or the turn's abort, the step's controller aborts its queries. */
async function runStep(s: Step, request: FastifyRequest, ms: number, turn: AbortSignal): Promise<string | null | "timeout"> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onTurnAbort: (() => void) | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    const stop = () => {
      resolve("timeout");
      ctl.abort();
    };
    timer = setTimeout(stop, ms);
    onTurnAbort = stop;
    if (turn.aborted) stop();
    else turn.addEventListener("abort", stop, { once: true });
  });
  try {
    // A run that throws once aborted is handled by the race (it lost); nothing is left unhandled.
    return await Promise.race([s.run({ request: scopedRequest(request, ctl.signal), signal: ctl.signal }), timeout]);
  } finally {
    clearTimeout(timer);
    if (onTurnAbort) turn.removeEventListener("abort", onTurnAbort);
  }
}

export function planSteps(ctx: PlanContext): { steps: Step[]; passages: string[] } {
  const { u } = ctx;
  // Set by a step when what it returned carries someone else's words; read only for steps whose block is shown.
  const flag = () => {
    let on = false;
    return { set: (v: boolean) => (on = on || v), get: () => on };
  };
  // Set by a step with the free text it showed.
  const freeOf = () => {
    let blocks: Free = [];
    return { set: (b: Free) => (blocks = [...blocks, ...b]), get: () => blocks };
  };
  const intents = intentsOf(u);
  const steps: Step[] = [];
  const passages: string[] = [];
  const addPassages = async (request: FastifyRequest, chunks: RetrievedChunk[]) => {
    const { kept } = await filterAllowedChunks(request, chunks, ctx.chatStudentId);
    if (!kept.length) return null;
    const { rendered } = ctx.ledger.add(kept);
    passages.push(rendered);
    return rendered;
  };

  // Other students named in the question: their record, narrowed to what a comparison or a question needs.
  const change = u.intent === "action";
  for (const s of u.students.filter((x) => x.id !== ctx.chatStudentId).slice(0, 2)) {
    const outside = flag();
    const free = freeOf();
    steps.push({
      key: "student_record",
      label: `Reading ${plain(s.name, 60)}'s record`,
      source: "Student profile",
      outside: outside.get,
      free: free.get,
      run: async ({ request }) => {
        const id = await resolveStudentId(request, s.id, "view");
        // A change only needs to know who the student is: read what the counselor wrote, so the
        // student's own words don't turn the change into a card (as for the chat's own student).
        const c = change
          ? await cachedStudentContext(request, id, TRUSTED_SECTIONS.slice(), true)
          : await cachedStudentContext(request, id, ["profile", "academics", "personal", "testScores", "colleges", "activities", "awards", "tasks", "deadlines", "meetingNotes"], false, ctx.freeRule === true);
        outside.set(readsOutside(c));
        if ((c.freeText?.length ?? 0) > 0) free.set(freeBlocks(c.text));
        return c.text ? `## Record of another student: ${plain(s.name, 60)}\n${c.text}` : null;
      },
    });
  }

  // What is due, when the question is about time or about who is behind.
  if ((intents.has("roster") || intents.has("record") || intents.has("strategy") || intents.has("action")) && (u.window || UPCOMING_WORDS.test(u.norm))) {
    const named = u.students.length === 1 ? u.students[0]!.id : null;
    const target = ctx.chatStudentId ?? named;
    const zone = counselorZone(ctx.request);
    const window = u.window ?? { from: null, to: daysFromToday(zone, 21), label: "in the next three weeks" };
    const outside = flag();
    const free = freeOf();
    steps.push({
      key: "upcoming",
      label: `Checking what's due ${window.label}`,
      source: "Calendar",
      outside: outside.get,
      free: free.get,
      run: async ({ request }) => {
        const id = target ? await resolveStudentId(request, target, "view") : null;
        const items = await upcomingItems(request, { studentId: id, window, meetings: true, roster: ctx.roster, limit: 60 });
        outside.set(items.some((i) => i.outside));
        // A title or detail over 80 characters, of an item someone other than the counselor wrote, is free text.
        free.set(items.filter((i) => i.outside && anyLong([i.title, i.detail])).map((i) => ({ source: i.kind, text: `${i.title}${i.detail ? `, ${i.detail}` : ""}` })));
        if (!items.length) return `## Due ${window.label}\nNothing open.`;
        return [
          `## Due ${window.label} (today is ${isoDay(zone)})`,
          ...items.map(
            (i) =>
              // Titles and details are the student's words (a deadline, a task they added): in a data block, short or free.
              `${i.date}${i.overdue ? " OVERDUE" : ""} ${i.kind}${i.status ? ` [${i.status}]` : ""}${id ? "" : ` · ${wrapUntrusted("student", plain(ctx.roster.get(i.studentId)?.name ?? "Student", 60), false)}`} · ${wrapUntrusted(i.kind, `${plain(i.title, 120)}${i.detail ? `, ${plain(i.detail, 60)}` : ""}`, i.outside && anyLong([i.title, i.detail]))}`
          ),
        ].join("\n");
      },
    });
  }

  // Who is behind, ranked in code (lib/axis/risk.ts), for caseload questions.
  if (intents.has("roster") && !ctx.chatStudentId && !u.students.length) {
    const outside = flag();
    steps.push({
      key: "caseload_risk",
      label: "Ranking the caseload",
      source: "Tasks",
      outside: outside.get,
      run: async ({ request }) => {
        const ranked = (await loadRosterRisk(request, 14)).slice(0, 8);
        outside.set(ranked.some((r) => r.outside));
        if (!ranked.length) return "## Caseload ranking\nNobody has overdue work, a red flag or a deadline at risk in the next 14 days.";
        // A reason quotes a title cut to 80 characters (lib/axis/risk.ts): a short field, inside a data block.
        return ["## Caseload ranking (computed: overdue work, deadlines in 14 days, days without activity, red flags)", ...ranked.map((r, i) => `${i + 1}. ${wrapUntrusted("student", plain(r.name, 60), false)} (score ${r.score}): ${wrapUntrusted("reasons", r.reasons.join("; "), false)}`)].join("\n");
      },
    });
  }

  // Named schools: their official figures, as citable passages.
  const collegeIds = u.colleges.map((c) => c.id).slice(0, 4);
  if (collegeIds.length) {
    steps.push({
      key: "colleges",
      label: `Looking up ${collegeIds.length === 1 ? plain(u.colleges[0]!.name, 60) : `${collegeIds.length} schools`}`,
      source: "College catalog",
      run: async ({ request }) => {
        const facts = await collegeFacts(request, collegeIds);
        if (!facts.length) return null;
        const { rendered } = ctx.ledger.add(
          facts.map((f) => ({
            chunkId: `college:${f.id}`,
            documentId: null,
            studentId: null,
            title: `${f.name} (${[f.city, f.state].filter(Boolean).join(", ")})`,
            text: collegeFactText(f),
            score: 1,
            source: "catalog" as const,
            url: f.website,
          }))
        );
        passages.push(rendered);
        return null;
      },
    });
  }

  // Files: the fused search over the RAG port, with the speculative search folded in.
  if (ctx.retrievalReady && ["documents", "record", "strategy", "colleges", "email"].some((i) => intents.has(i as Intent))) {
    const names = [ctx.chatStudentId ? ctx.roster.get(ctx.chatStudentId)?.name : null, ...u.students.map((s) => s.name)].filter((n): n is string => !!n);
    steps.push({
      key: "files",
      label: "Searching the files",
      source: "Documents",
      run: async ({ request, signal }) => {
        const speculative = await ctx.speculative.catch((): RetrievedChunk[] => []);
        const chunks = await fusedSearch(request, retrievalQueries(u, names), {
          studentId: ctx.chatStudentId,
          k: intents.has("documents") ? 6 : 4,
          signal,
          extraLists: speculative.length ? [speculative] : [],
        });
        await addPassages(request, chunks);
        return null;
      },
    });
  }

  if (ctx.connected.length && intents.has("email")) {
    steps.push({
      key: "email",
      label: "Searching email",
      source: "Email",
      run: async ({ request, signal }) => {
        const q = u.keywords.slice(0, 12).join(" ") || u.text;
        await addPassages(request, await getConnectors().searchMail(request, { query: q, studentId: ctx.chatStudentId, k: 6, signal }));
        return null;
      },
    });
  }
  if (ctx.connected.length && intents.has("documents")) {
    steps.push({
      key: "connected_files",
      label: "Searching Drive and OneDrive",
      source: "Connected files",
      run: async ({ request, signal }) => {
        const q = u.keywords.slice(0, 12).join(" ") || u.text;
        await addPassages(request, await getConnectors().searchFiles(request, { query: q, studentId: ctx.chatStudentId, k: 3, signal }));
        return null;
      },
    });
  }

  return { steps, passages };
}

export async function gatherEvidence(ctx: PlanContext): Promise<Evidence> {
  const { steps, passages } = planSteps(ctx);
  const blocks: string[] = [];
  const trace: string[] = [];
  const skipped: string[] = [];
  const sources = new Set<string>();
  let outside = false;
  const free: Free = [];
  const timings: StepTiming[] = [];
  const limit = ctx.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  await Promise.all(
    steps.map(async (s) => {
      ctx.onStep(s.label);
      trace.push(s.label);
      const started = Date.now();
      const time = (outcome: StepTiming["outcome"]) => timings.push({ step: s.key, ms: Date.now() - started, outcome });
      try {
        const out = await runStep(s, ctx.request, limit, ctx.signal);
        if (out === "timeout") {
          time("timeout");
          skipped.push(s.label);
          return;
        }
        time("ok");
        sources.add(s.source);
        if (out) {
          blocks.push(out);
          if (s.outside?.()) outside = true;
          free.push(...(s.free?.() ?? []));
        }
      } catch (err) {
        time("error");
        ctx.request.log.warn({ err: errInfo(err), step: s.label }, "axis evidence step failed");
        skipped.push(s.label);
      }
    })
  );
  // Passages first, then the computed blocks. A step that timed out may still finish later and add
  // passages to the ledger; those are left out of this text, so the model only cites what it was shown.
  const shown = passages.filter((p) => p.trim());
  const text = [shown.length ? `Passages (cite as [S#]):\n${shown.join("\n\n")}` : "", ...blocks].filter((b) => b.trim()).join("\n\n");
  return {
    text,
    outside,
    freeText: free.length > 0,
    freeBlocks: free,
    raw: [...blocks, ...ctx.ledger.all().map((p) => p.text)],
    sources: [...sources],
    trace,
    skipped,
    timings,
  };
}
