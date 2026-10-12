/**
 * One AxIS turn, start to finish.
 *
 *   1. In parallel: the counselor's roster, the college index, the student's
 *      record (or the roster view), memory, connected apps, the chat
 *      student's facts, and a speculative document search on the raw
 *      question. All but the search are cached in-process for a minute or
 *      more, so a follow-up starts with most of this already in hand.
 *   2. Understanding, in code (lib/axis/nlu.ts): intent, entities, dates.
 *   3. The answer compiler: a lookup with one right answer is answered from
 *      the rows, with no model call (lib/axis/compiler.ts).
 *   4. Essay requests go to the guarded bullet path.
 *   5. The evidence planner fetches what the answer will need, in parallel
 *      (lib/axis/planner.ts).
 *   6. A compound question fans out to specialists, then one streamed
 *      synthesis; anything else is one streamed specialist (lib/axis/loop.ts,
 *      lib/axis/specialists.ts).
 *   7. While it streams, every figure is checked against the evidence
 *      (lib/axis/grounding.ts); citations are resolved against the ledger.
 *
 * The route then saves the answer, sends `done`, and runs the adjudicator
 * and the memory fold after the counselor can already type again.
 */
import { errInfo } from "./failsafe.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyRequest } from "fastify";
import { enforceNoProse, NO_PROSE_SYSTEM } from "../anthropic.js";
import { buildRosterContext } from "../chat.js";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../context/pack.js";
import type { ContextUsage } from "../context/types.js";
import { HttpError, unavailable } from "../errors.js";
import { z } from "zod";
import { compileDirect } from "./compiler.js";
import { cachedStudentContext, loadRoster, studentFacts } from "./data.js";
import { loadCollegeIndex, type CollegeIndex } from "./entities.js";
import { EvidenceIndex, LiveGrounder, type SentenceCheck } from "./grounding.js";
import { dropInvalidCitations, renderSource, resolveCitations, SourceLedger, type Citation } from "./ledger.js";
import { chargeCall, chargeOutput, closeRun, messagesApi, openRun, structured, type Run } from "./llm.js";
import { emptyUsage, runLoop, type LoopOptions, type MessagesApi, type Usage } from "./loop.js";
import { loadHistory } from "./memory.js";
import {
  AXIS_MODEL,
  effortMessage,
  estimateTokens,
  featureOn,
  modeMessage,
  PER_MESSAGE_EFFORT_BETA,
  PINNED_EFFORT,
  PROMPT_TOKEN_BUDGET,
  THINKING,
  type Effort,
} from "./models.js";
import { nextState, understand, type DialogueState, type Understanding } from "./nlu.js";
import { gatherEvidence } from "./planner.js";
import { getConnectors, getRetrieval, retrievalReady, type RetrievedChunk } from "./ports.js";
import { AXIS_SYSTEM, effortFor, modeLine, PROFILES, type Mode } from "./profiles.js";
import { renderFindings, runSpecialists, specialistTasks } from "./specialists.js";
import { isReadOnly, readsDocuments, runTool, toolLabel, toolList, type ProposedAction, type ToolContext } from "./tools.js";
import { newTurnBudget, recentActionsText, type OperationEvent } from "./ops/run.js";

export type Emit = (event: string, data: unknown) => void;

/** Wall clock for the tool phase of a turn; after it the next model call must answer. */
export const TURN_BUDGET_MS = 40_000;

const SECTION_LABELS: Record<string, string> = {
  profile: "Student profile", personal: "Student profile", academics: "Grades and scores", testScores: "Grades and scores",
  courses: "Courses", activities: "Activities and awards", awards: "Activities and awards", essays: "Essays",
  colleges: "College list", meetingNotes: "Meeting notes", deadlines: "Calendar", upcomingMeetings: "Calendar",
  documents: "Documents", tasks: "Tasks", polygon: "Strength profile", intake: "Intake answers",
};
const TOOL_SOURCES: Record<string, string> = {
  search_documents: "Documents", read_document: "Documents", search_email: "Email", search_connected_files: "Connected files",
  search_colleges: "College catalog", list_upcoming: "Calendar", rank_caseload: "Tasks", get_student_record: "Student profile",
};

export type TurnResult = {
  path: "direct" | "essay" | "agent" | "specialists";
  text: string;
  citations: Citation[];
  trace: { label: string }[];
  sources: string[];
  /** Proposals and changes this turn: email drafts (propose_action) and operations (perform_action). */
  actions: (ProposedAction | OperationEvent)[];
  understanding: Understanding;
  state: DialogueState;
  /** For the adjudicator, after `done`. */
  verify: { wanted: boolean; checks: SentenceCheck[]; material: string[]; ledger: SourceLedger };
  runId: string | null;
};

/** The cached system prompt: the stable rules (shared by every counselor), then today and this student or roster. */
export function systemBlocks(record: string | null, roster: string | null, summary: string | null, now = new Date()): Anthropic.Beta.BetaTextBlockParam[] {
  const today = now.toISOString().slice(0, 10);
  const context = record
    ? `Today is ${today}.\n\n--- STUDENT ON FILE ---\n${record}\n--- END STUDENT ---`
    : roster
      ? `Today is ${today}. No student is selected; questions are about the roster.\n\n--- ROSTER, NEXT THREE WEEKS ---\n${wrapUntrusted("roster", roster)}\n--- END ROSTER ---`
      : `Today is ${today}. No student is selected.`;
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: AXIS_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: context, cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
  if (summary) blocks.push({ type: "text", text: `Earlier in this conversation (memory):\n${wrapUntrusted("memory", summary)}` });
  return blocks;
}

/** Everything the request carries but the messages: one shape for the answer, the specialists and the pre-warm. */
export function requestBase(system: Anthropic.Beta.BetaTextBlockParam[], tools: Anthropic.Beta.BetaTool[], effort: Effort): LoopOptions["base"] {
  const perMessage = featureOn("perMessageEffort");
  return {
    model: AXIS_MODEL,
    system,
    tools,
    thinking: THINKING,
    output_config: { effort: perMessage ? PINNED_EFFORT : effort },
    ...(perMessage ? { betas: [PER_MESSAGE_EFFORT_BETA] } : {}),
    // The growing tail of a turn (tool calls and results) caches automatically, after the two 1-hour marks.
    cache_control: { type: "ephemeral" },
  };
}

/** The student's record or the roster view, with what it's built from. */
async function loadContext(request: FastifyRequest, studentId: string | null) {
  if (studentId) {
    const c = await cachedStudentContext(request, studentId);
    return { record: c.text, roster: null, name: c.studentName, usage: { used: c.used, omitted: c.omitted } as ContextUsage, labels: c.used.map((u) => SECTION_LABELS[u.section] ?? u.section) };
  }
  const r = await buildRosterContext(request);
  return { record: null, roster: r?.text ?? null, name: null, usage: null, labels: r?.sources ?? [] };
}

/** Drops the oldest turns until the prompt fits Haiku 5.5's lower rate card. */
function fitHistory(turns: Anthropic.Beta.BetaMessageParam[], fixedChars: number): Anthropic.Beta.BetaMessageParam[] {
  const size = (m: Anthropic.Beta.BetaMessageParam) => (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length);
  let total = fixedChars + turns.reduce((n, m) => n + size(m), 0);
  const out = turns.slice();
  while (out.length && estimateTokens(total) > PROMPT_TOKEN_BUDGET) {
    total -= size(out.shift()!);
    while (out[0]?.role === "assistant") total -= size(out.shift()!);
  }
  return out;
}

const ESSAY_SCHEMA = {
  type: "object",
  properties: { bullets: { type: "array", items: { type: "string" }, description: "Two to eight bullets of advice, each at most two sentences." } },
  required: ["bullets"],
  additionalProperties: false,
} as const;

async function essayAdvice(
  request: FastifyRequest,
  studentId: string | null,
  question: string,
  record: string | null,
  o: { signal: AbortSignal; precharged: boolean }
): Promise<string> {
  const out = await structured({
    signal: o.signal,
    precharged: o.precharged,
    request,
    module: "essay-advice",
    studentId,
    system: `${NO_PROSE_SYSTEM}\n\nThe counselor asked for essay writing. Open with one bullet saying you don't write essay text, then advise.\n\n${UNTRUSTED_DATA_RULE}`,
    prompt: `${record ? `Student on file:\n${record.slice(0, 30_000)}\n\n` : ""}Counselor's request:\n${wrapUntrusted("request", question)}`,
    schema: ESSAY_SCHEMA as unknown as Record<string, unknown>,
    parse: z.object({ bullets: z.array(z.string()) }),
    effort: "low",
  });
  // The guardrail in code, after the model: anything that reads like prose is dropped.
  const bullets = enforceNoProse(out?.bullets ?? []).slice(0, 8);
  return bullets.length
    ? bullets.map((b) => `- ${b}`).join("\n")
    : "- I don't write essay text. Tell me which part of the draft worries you and I'll point at what to change.";
}

export async function runAxisTurn(opts: {
  request: FastifyRequest;
  conversationId: string;
  studentId: string | null;
  content: string;
  emit: Emit;
  signal: AbortSignal;
  api?: MessagesApi;
  /**
   * Model calls already charged against the daily quota. The route charges the
   * first before the stream opens, so an exhausted quota is a plain 429 the app
   * can show rather than an error mid-stream.
   */
  prepaidCalls?: number;
}): Promise<TurnResult> {
  const { request, studentId, content, emit, signal } = opts;
  let prepaid = opts.prepaidCalls ?? 0;
  const takePrepaid = () => (prepaid > 0 ? (prepaid--, true) : false);
  const startedAt = Date.now();
  emit("status", { phase: "thinking" });

  // ---- 1. Everything at once ----
  const retrievalOn = retrievalReady();
  const speculative =
    retrievalOn && content.length >= 8
      ? getRetrieval().search(request, { query: content, studentId, k: 8, signal }).catch((): RetrievedChunk[] => [])
      : Promise.resolve<RetrievedChunk[]>([]);
  const chatFacts = studentId ? studentFacts(request, studentId).catch(() => null) : undefined;
  const [roster, colleges, ctx, history, connected] = await Promise.all([
    loadRoster(request),
    loadCollegeIndex(request).catch((err): CollegeIndex | null => {
      request.log.warn({ err: errInfo(err) }, "axis college index unavailable");
      return null;
    }),
    loadContext(request, studentId),
    loadHistory(request, opts.conversationId),
    getConnectors().connected(request).catch(() => []),
  ]);
  // What the counselor confirmed, dismissed or undid since the last answer. Best effort.
  const recentActions = recentActionsText(request, opts.conversationId).catch(() => "");

  // ---- 2. Understanding ----
  const u = understand(content, { chatStudentId: studentId, roster, colleges, state: history.state });
  const chatStudent = studentId ? { id: studentId, name: roster.get(studentId)?.name ?? ctx.name ?? "" } : null;
  const state = nextState(u, history.state, chatStudent);
  const ledger = new SourceLedger();
  const trace: { label: string }[] = [];
  const sources = new Set<string>(ctx.labels);
  const step = (label: string) => {
    trace.push({ label });
    emit("reasoning", { step: label });
  };
  if (ctx.usage) emit("context", ctx.usage);

  // ---- 3. Direct answers ----
  if (u.intent !== "essay") {
    const direct = await compileDirect(u, { request, chatStudentId: studentId, roster, ledger, chatFacts }).catch((err) => {
      request.log.warn({ err: errInfo(err) }, "axis direct answer skipped");
      return null;
    });
    if (direct) {
      emit("route", { intent: u.intent, path: "direct", frame: direct.frame });
      emit("sources", { sources: direct.sources });
      for (const t of direct.trace) step(t);
      emit("status", { phase: "answering" });
      emit("delta", { text: direct.text });
      const { citations } = resolveCitations(direct.text, ledger);
      if (citations.length) emit("citations", { citations });
      request.log.info({ axis: { path: "direct", frame: direct.frame, ms: Date.now() - startedAt } }, "axis turn");
      return {
        path: "direct", text: direct.text, citations, trace, sources: direct.sources, actions: [], understanding: u, state,
        verify: { wanted: false, checks: [], material: [], ledger }, runId: null,
      };
    }
  }

  // ---- 4. Essays: guarded bullets ----
  if (u.intent === "essay") {
    emit("route", { intent: "essay", path: "essay" });
    emit("status", { phase: "answering" });
    const text = await essayAdvice(request, studentId, content, ctx.record, { signal, precharged: takePrepaid() });
    emit("delta", { text });
    return {
      path: "essay", text, citations: [], trace, sources: [...sources], actions: [], understanding: u, state,
      verify: { wanted: false, checks: [], material: [], ledger }, runId: null,
    };
  }

  // ---- 5. Evidence, in parallel ----
  const mode = u.intent as Mode;
  const profile = PROFILES[mode];
  const effort = effortFor(profile, u);
  if (sources.size) emit("sources", { sources: [...sources] });
  const evidence = await gatherEvidence({
    request, u, chatStudentId: studentId, roster, ledger, connected, retrievalReady: retrievalOn, speculative, signal, onStep: step,
  });
  for (const s of evidence.sources) sources.add(s);

  // Everything the answer may rest on, indexed for live grounding: the record, the evidence, the
  // counselor's own words this turn and earlier (figures they supplied aren't the model's to defend).
  const index = new EvidenceIndex();
  index.add(ctx.record);
  index.add(ctx.roster);
  for (const r of evidence.raw) index.add(r);
  index.add(content);
  for (const t of history.turns) if (t.role === "user" && typeof t.content === "string") index.add(t.content);

  const tools = toolList(connected, retrievalOn);
  const system = systemBlocks(ctx.record, ctx.roster, history.summary);
  const base = requestBase(system, tools, effort);
  const api = opts.api ?? messagesApi();
  const actions: (ProposedAction | OperationEvent)[] = [];
  // Outside content the planner already put in front of the model counts too: changes then wait for a click.
  // So does the text of uploaded files in the student record the system prompt carries (its documents section).
  const outside =
    ledger.all().some((p) => p.kind === "upload" || p.kind === "drive" || p.kind === "onedrive" || p.kind === "outlook" || p.kind === "gmail") ||
    readsDocuments(ctx.usage);
  const toolCtx: ToolContext = {
    request, conversationId: opts.conversationId, studentId, roster, ledger, connected, retrievalReady: retrievalOn, signal,
    memo: new Map(),
    onAction: (a) => {
      actions.push(a);
      emit("action", a);
    },
    turn: newTurnBudget(outside),
    onOperation: (e) => {
      actions.push(e);
      emit("action", e);
    },
  };
  const exec: LoopOptions["exec"] = async (c, sig) => {
    const out = await runTool(toolCtx, c.name, c.input, sig);
    index.add(out.content);
    return out;
  };
  // Specialists research; a change is only ever made by the agent answering the counselor.
  const researchOnly: LoopOptions["exec"] = (c, sig) =>
    isReadOnly(c.name) ? exec(c, sig) : Promise.resolve({ content: "Specialists only research. Leave changes to the final answer.", isError: true, fresh: false });
  const beforeCall = () => (takePrepaid() ? Promise.resolve() : chargeCall(request));
  const total: Usage = emptyUsage();
  const add = (x: Usage) => {
    total.input += x.input;
    total.output += x.output;
    total.cacheRead += x.cacheRead;
    total.cacheWrite += x.cacheWrite;
  };

  // Which kinds of passage the planner already found: a part they cover needs no specialist.
  const kinds = new Set(ledger.all().map((p) => p.kind));
  const covered = (i: string) => (i === "documents" ? kinds.has("upload") || kinds.has("drive") || kinds.has("onedrive") : i === "email" ? kinds.has("outlook") || kinds.has("gmail") : true);
  const tasks = specialistTasks(u, covered);
  const run: Run = await openRun(request, "axis", studentId, {
    intent: u.intent, confidence: Math.round(u.confidence * 100) / 100, path: tasks ? "specialists" : "agent", effort,
    evidenceSteps: evidence.trace.length, skipped: evidence.skipped.length,
  });

  try {
    // ---- 6a. Specialists for compound questions ----
    let findings = "";
    let newPassages = "";
    if (tasks) {
      emit("route", { intent: u.intent, path: "specialists", parts: tasks.map((t) => t.intent), effort });
      const before = ledger.size;
      const res = await runSpecialists({
        tasks, question: content, api, base: requestBase(system, tools, "low"), evidence: evidence.text, effort: "low", signal, exec: researchOnly, readOnly: isReadOnly, beforeCall, onStep: step,
      });
      add(res.usage);
      findings = renderFindings(res.findings);
      newPassages = ledger.all().slice(before).map(renderSource).join("\n\n");
    } else {
      emit("route", { intent: u.intent, path: "agent", mode, effort });
    }

    // ---- 6b. The streamed answer ----
    const turnMode: Mode = tasks ? "synthesis" : mode;
    const turnProfile = PROFILES[turnMode];
    const turnEffort = tasks ? effortFor(turnProfile, u) : effort;
    const recent = await recentActions;
    const userParts = [
      recent,
      evidence.text ? `Evidence gathered for this question:\n${evidence.text}` : "",
      newPassages ? `Passages the specialists found (cite as [S#]):\n${newPassages}` : "",
      findings ? `Specialist findings:\n${findings}` : "",
      evidence.skipped.length ? `Not gathered in time (use a tool if you need it): ${evidence.skipped.join("; ")}.` : "",
      featureOn("systemMessages") ? "" : `(${modeLine(turnMode)})`,
      content,
    ].filter(Boolean);
    const fixedChars = system.reduce((n, b) => n + b.text.length, 0) + userParts.join("\n\n").length;
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...fitHistory(history.turns.slice(0, history.turns.at(-1)?.role === "user" ? -1 : undefined), fixedChars),
      ...(featureOn("perMessageEffort") ? [effortMessage(turnEffort)] : []),
      { role: "user", content: userParts.join("\n\n") },
      ...(featureOn("systemMessages") ? [modeMessage(modeLine(turnMode))] : []),
    ];

    const grounder = new LiveGrounder(index, ledger, (c) => emit("grounding", c));
    emit("status", { phase: "answering" });
    const res = await runLoop({
      api, base: requestBase(system, tools, turnEffort), messages, effort: turnEffort, maxCalls: turnProfile.maxCalls,
      deadline: startedAt + TURN_BUDGET_MS, signal, exec, readOnly: isReadOnly, beforeCall,
      onText: (d) => {
        emit("delta", { text: d });
        grounder.push(d);
      },
      onToolStart: (c) => {
        const label = toolLabel(c.name, c.input);
        step(label);
        emit("tool", { id: c.id, name: c.name, label, status: "running" });
        const src = TOOL_SOURCES[c.name];
        if (src) sources.add(src);
      },
      onToolEnd: (c, out) => emit("tool", { id: c.id, name: c.name, status: out.isError ? "failed" : "done" }),
    });
    add(res.usage);
    const checks = grounder.finish();

    const { citations, invalid } = resolveCitations(res.text, ledger);
    const text = dropInvalidCitations(res.text, invalid);
    if (citations.length) emit("citations", { citations });
    await closeRun(run, res.stop === "refusal" ? "blocked" : "succeeded", total, {
      stop: res.stop, refusal: res.refusalCategory, calls: res.calls, tools: res.tools, passages: ledger.size, cited: citations.length,
      invalidCitations: invalid.length, sentencesChecked: checks.length, unverified: checks.filter((c) => c.status === "unverified").length,
      ms: Date.now() - startedAt, writes: toolCtx.turn.writes, autoWrites: toolCtx.turn.autoWrites, tainted: toolCtx.turn.tainted,
    });
    await chargeOutput(request, total.output);
    return {
      path: tasks ? "specialists" : "agent", text, citations, trace, sources: [...sources].slice(0, 20), actions, understanding: u, state,
      verify: { wanted: turnProfile.verify && res.stop !== "refusal", checks, material: [ctx.record ?? "", ctx.roster ?? "", ...evidence.raw], ledger },
      runId: run.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await closeRun(run, signal.aborted ? "blocked" : "failed", total, {}, signal.aborted ? "client closed" : message);
    if (err instanceof HttpError) throw err;
    request.log.error({ err, module: "axis" }, "axis turn failed");
    throw unavailable("AxIS is unavailable right now. Try again in a few minutes.");
  }
}

/** The pre-warm's inputs: the tools and the two cached system blocks a turn about this student would send. */
export async function warmInputs(request: FastifyRequest, studentId: string | null) {
  const [ctx, connected] = await Promise.all([loadContext(request, studentId), getConnectors().connected(request).catch(() => [])]);
  return { system: systemBlocks(ctx.record, ctx.roster, null), tools: toolList(connected, retrievalReady()) };
}
