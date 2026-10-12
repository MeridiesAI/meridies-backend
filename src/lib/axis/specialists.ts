/**
 * Specialist agents for compound questions.
 *
 * "Did her mom reply about the CSS Profile, and is Cornell's ED deadline
 * realistic given what's left on her list?" is two research jobs with
 * different sources and different searches. One agent works through them
 * one tool round at a time; here each part gets its own specialist, running
 * at the same time, each a short tool loop with the specialist contract
 * (terse cited findings, what it couldn't find). The answer is then written
 * once, streamed, from their findings.
 *
 * All specialists share one ledger, so a passage two of them found has one
 * number and their citations stay valid in the final answer. They also share
 * the cached prefix: the same model, tools and system blocks as the main
 * request, and the same evidence block at the head of their turn, marked as
 * a cache breakpoint. The first specialist starts alone and the others wait
 * for its first streamed event (or 600ms), because a cache entry is readable
 * only once the request writing it starts streaming; started together they
 * would each pay for the whole prefix.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { runLoop, emptyUsage, type LoopOptions, type MessagesApi, type ToolCall, type Usage } from "./loop.js";
import { effortMessage, featureOn, type Effort } from "./models.js";
import type { Intent, Understanding } from "./nlu.js";
import { modeLine } from "./profiles.js";
import type { ToolOutput } from "./tools.js";

export type SpecialistTask = { clause: string; intent: Intent };
export type Finding = { clause: string; intent: Intent; text: string; tools: string[] };

const RESEARCH: ReadonlySet<Intent> = new Set(["documents", "email", "strategy", "colleges", "record"]);
const NEEDS_SEARCH: ReadonlySet<Intent> = new Set(["documents", "email"]);
export const SPECIALIST_BUDGET_MS = 15_000;
const STAGGER_MS = 600;

/**
 * Fan out only when it pays. The evidence planner has already searched for
 * every part it could foresee, and a single agent answering from that
 * evidence needs one model call. Specialists add a round of their own before
 * the synthesis, so they are for accuracy, not speed: they run only when two
 * or more parts still need their own searching (a documents or email part the
 * planner's search came back empty for), where one agent juggling several
 * failed searches in one context does worst. Anything that writes (action) or
 * is guarded (essay) stays with one agent.
 */
export function specialistTasks(u: Understanding, covered: (intent: Intent) => boolean = () => false): SpecialistTask[] | null {
  const parts = u.clauses.filter((c) => c.intent !== "chitchat");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !RESEARCH.has(p.intent))) return null;
  if (new Set(parts.map((p) => p.intent)).size < 2) return null;
  const open = parts.filter((p) => NEEDS_SEARCH.has(p.intent) && !covered(p.intent));
  if (open.length < 2) return null;
  return parts.map((p) => ({ clause: p.text, intent: p.intent }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSpecialists(o: {
  tasks: SpecialistTask[];
  question: string;
  api: MessagesApi;
  base: LoopOptions["base"];
  /** The gathered evidence, identical for every specialist so it is cached once. */
  evidence: string;
  /** One level for all of them: the effort message sits ahead of the shared evidence, so it has to match too. */
  effort: Effort;
  signal: AbortSignal;
  exec: (call: ToolCall, signal: AbortSignal) => Promise<ToolOutput>;
  readOnly: (name: string) => boolean;
  beforeCall: () => Promise<void>;
  onStep: (label: string) => void;
}): Promise<{ findings: Finding[]; usage: Usage }> {
  const usage = emptyUsage();
  const deadline = Date.now() + SPECIALIST_BUDGET_MS;
  const sharedHead: Anthropic.Beta.BetaTextBlockParam[] = o.evidence
    ? [{ type: "text", text: `Evidence gathered for the counselor's question:\n${o.evidence}`, cache_control: { type: "ephemeral" } }]
    : [];

  const effort = o.effort;
  const run = async (task: SpecialistTask, firstEvent?: () => void): Promise<Finding> => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...(featureOn("perMessageEffort") ? [effortMessage(effort)] : []),
      {
        role: "user",
        content: [
          ...sharedHead,
          { type: "text", text: `The counselor's whole question: ${o.question}\n\nYour part (${task.intent}): ${task.clause}` },
        ],
      },
      ...(featureOn("systemMessages") ? [{ role: "system" as const, content: `${modeLine("specialist")} Focus: ${task.intent}.` }] : []),
    ];
    const res = await runLoop({
      api: o.api,
      base: o.base,
      messages,
      effort,
      maxCalls: 3,
      deadline,
      signal: o.signal,
      exec: o.exec,
      readOnly: o.readOnly,
      beforeCall: o.beforeCall,
      onFirstEvent: firstEvent,
      onToolStart: (c) => o.onStep(`${task.intent}: ${c.name.replace(/_/g, " ")}`),
    });
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.cacheRead += res.usage.cacheRead;
    usage.cacheWrite += res.usage.cacheWrite;
    return { clause: task.clause, intent: task.intent, text: res.text.trim(), tools: res.tools };
  };

  const [first, ...rest] = o.tasks;
  if (!first) return { findings: [], usage };
  let signalFirst: () => void = () => undefined;
  const firstStreaming = new Promise<void>((r) => (signalFirst = r));
  const firstRun = run(first, () => signalFirst());
  await Promise.race([firstStreaming, sleep(STAGGER_MS), firstRun.then(() => undefined, () => undefined)]);
  const settled = await Promise.allSettled([firstRun, ...rest.map((t) => run(t))]);
  const findings = settled.map((s, i): Finding => {
    const task = o.tasks[i]!;
    return s.status === "fulfilled" ? s.value : { clause: task.clause, intent: task.intent, text: "Not found: this part couldn't be researched in time.", tools: [] };
  });
  return { findings, usage };
}

export function renderFindings(findings: Finding[]): string {
  return findings.map((f, i) => `### Specialist ${i + 1} (${f.intent}): ${f.clause}\n${f.text || "Not found: nothing came back."}`).join("\n\n");
}
