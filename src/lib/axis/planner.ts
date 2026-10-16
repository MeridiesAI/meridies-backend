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
 */
import { errInfo } from "./failsafe.js";
import type { FastifyRequest } from "fastify";
import { resolveStudentId } from "../guards.js";
import { cachedStudentContext, collegeFacts, collegeFactText, isoDay, plain, upcomingItems } from "./data.js";
import type { RosterIndex } from "./entities.js";
import { filterAllowedChunks } from "./guard.js";
import type { SourceLedger } from "./ledger.js";
import type { Intent, Understanding } from "./nlu.js";
import { getConnectors, type ConnectedProvider, type RetrievedChunk } from "./ports.js";
import { fusedSearch, retrievalQueries } from "./retrieval.js";
import { loadRosterRisk } from "./risk.js";
import { readsOutside } from "./tools.js";
import { TRUSTED_SECTIONS } from "../context/profiles.js";

export type PlanContext = {
  request: FastifyRequest;
  u: Understanding;
  chatStudentId: string | null;
  roster: RosterIndex;
  ledger: SourceLedger;
  connected: ConnectedProvider[];
  retrievalReady: boolean;
  /** The raw-question search started at the top of the turn. */
  speculative: Promise<RetrievedChunk[]>;
  signal: AbortSignal;
  onStep: (label: string) => void;
};

export type Evidence = {
  /** Rendered for the user turn: passages first, then the other blocks. */
  text: string;
  /**
   * A shown block carries text someone other than the counselor wrote (another student's record,
   * a deadline's or a student-added task's title): every change this turn waits for a click.
   */
  outside: boolean;
  /** Everything read, for the grounding index. */
  raw: string[];
  sources: string[];
  trace: string[];
  skipped: string[];
};

/** Per step. A slow source is skipped, not waited on: the model can still ask for it with a tool. */
export const STEP_TIMEOUT_MS = 2_500;

const UPCOMING_WORDS = /\b(due|deadlines?|coming up|upcoming|next|this week|next week|overdue|behind|schedule|calendar|plan|prioriti[sz]e)\b/;

type Step = { label: string; source: string; run: () => Promise<string | null>; outside?: () => boolean };

function intentsOf(u: Understanding): Set<Intent> {
  return new Set<Intent>([u.intent, ...u.clauses.map((c) => c.intent)]);
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    signal.addEventListener("abort", () => resolve("timeout"), { once: true });
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function planSteps(ctx: PlanContext): { steps: Step[]; passages: string[] } {
  const { u, request } = ctx;
  // Set by a step when what it returned carries someone else's words; read only for steps whose block is shown.
  const flag = () => {
    let on = false;
    return { set: (v: boolean) => (on = on || v), get: () => on };
  };
  const intents = intentsOf(u);
  const steps: Step[] = [];
  const passages: string[] = [];
  const addPassages = async (chunks: RetrievedChunk[]) => {
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
    steps.push({
      label: `Reading ${plain(s.name, 60)}'s record`,
      source: "Student profile",
      outside: outside.get,
      run: async () => {
        const id = await resolveStudentId(request, s.id, "view");
        // A change only needs to know who the student is: read what the counselor wrote, so the
        // student's own words don't turn the change into a card (as for the chat's own student).
        const c = change
          ? await cachedStudentContext(request, id, TRUSTED_SECTIONS.slice(), true)
          : await cachedStudentContext(request, id, ["profile", "academics", "personal", "testScores", "colleges", "activities", "awards", "tasks", "deadlines", "meetingNotes"]);
        outside.set(readsOutside(c));
        return c.text ? `## Record of another student: ${plain(s.name, 60)}\n${c.text}` : null;
      },
    });
  }

  // What is due, when the question is about time or about who is behind.
  if ((intents.has("roster") || intents.has("record") || intents.has("strategy") || intents.has("action")) && (u.window || UPCOMING_WORDS.test(u.norm))) {
    const named = u.students.length === 1 ? u.students[0]!.id : null;
    const target = ctx.chatStudentId ?? named;
    const window = u.window ?? { from: null, to: isoDay(new Date(Date.now() + 21 * 86_400_000)), label: "in the next three weeks" };
    const outside = flag();
    steps.push({
      label: `Checking what's due ${window.label}`,
      source: "Calendar",
      outside: outside.get,
      run: async () => {
        const id = target ? await resolveStudentId(request, target, "view") : null;
        const items = await upcomingItems(request, { studentId: id, window, meetings: true, roster: ctx.roster, limit: 60 });
        outside.set(items.some((i) => i.outside));
        if (!items.length) return `## Due ${window.label}\nNothing open.`;
        return [
          `## Due ${window.label} (today is ${isoDay()})`,
          ...items.map(
            (i) =>
              `${i.date}${i.overdue ? " OVERDUE" : ""} ${i.kind}${i.status ? ` [${i.status}]` : ""}${id ? "" : ` · ${plain(ctx.roster.get(i.studentId)?.name ?? "Student", 60)}`} · ${plain(i.title, 120)}${i.detail ? `, ${plain(i.detail, 60)}` : ""}`
          ),
        ].join("\n");
      },
    });
  }

  // Who is behind, ranked in code (lib/axis/risk.ts), for caseload questions.
  if (intents.has("roster") && !ctx.chatStudentId && !u.students.length) {
    const outside = flag();
    steps.push({
      label: "Ranking the caseload",
      source: "Tasks",
      outside: outside.get,
      run: async () => {
        const ranked = (await loadRosterRisk(request, 14)).slice(0, 8);
        outside.set(ranked.some((r) => r.outside));
        if (!ranked.length) return "## Caseload ranking\nNobody has overdue work, a red flag or a deadline at risk in the next 14 days.";
        return ["## Caseload ranking (computed: overdue work, deadlines in 14 days, days without activity, red flags)", ...ranked.map((r, i) => `${i + 1}. ${plain(r.name, 60)} (score ${r.score}): ${r.reasons.join("; ")}`)].join("\n");
      },
    });
  }

  // Named schools: their official figures, as citable passages.
  const collegeIds = u.colleges.map((c) => c.id).slice(0, 4);
  if (collegeIds.length) {
    steps.push({
      label: `Looking up ${collegeIds.length === 1 ? plain(u.colleges[0]!.name, 60) : `${collegeIds.length} schools`}`,
      source: "College catalog",
      run: async () => {
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
      label: "Searching the files",
      source: "Documents",
      run: async () => {
        const speculative = await ctx.speculative.catch((): RetrievedChunk[] => []);
        const chunks = await fusedSearch(request, retrievalQueries(u, names), {
          studentId: ctx.chatStudentId,
          k: intents.has("documents") ? 6 : 4,
          signal: ctx.signal,
          extraLists: speculative.length ? [speculative] : [],
        });
        await addPassages(chunks);
        return null;
      },
    });
  }

  if (ctx.connected.length && intents.has("email")) {
    steps.push({
      label: "Searching email",
      source: "Email",
      run: async () => {
        const q = u.keywords.slice(0, 12).join(" ") || u.text;
        await addPassages(await getConnectors().searchMail(request, { query: q, studentId: ctx.chatStudentId, k: 6, signal: ctx.signal }));
        return null;
      },
    });
  }
  if (ctx.connected.length && intents.has("documents")) {
    steps.push({
      label: "Searching Drive and OneDrive",
      source: "Connected files",
      run: async () => {
        const q = u.keywords.slice(0, 12).join(" ") || u.text;
        await addPassages(await getConnectors().searchFiles(request, { query: q, studentId: ctx.chatStudentId, k: 3, signal: ctx.signal }));
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
  await Promise.all(
    steps.map(async (s) => {
      ctx.onStep(s.label);
      trace.push(s.label);
      try {
        const out = await withTimeout(s.run(), STEP_TIMEOUT_MS, ctx.signal);
        if (out === "timeout") {
          skipped.push(s.label);
          return;
        }
        sources.add(s.source);
        if (out) {
          blocks.push(out);
          if (s.outside?.()) outside = true;
        }
      } catch (err) {
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
    raw: [...blocks, ...ctx.ledger.all().map((p) => p.text)],
    sources: [...sources],
    trace,
    skipped,
  };
}
