/**
 * Conversation memory, three layers:
 *
 *  - The last turns, verbatim (old citation markers removed: they pointed at
 *    another turn's passages).
 *  - A running summary of everything older, folded by Haiku 5.5 after an
 *    answer has streamed, so it never costs the counselor a second.
 *  - Dialogue state: the students and schools the conversation is about,
 *    newest first, so "what about her ED deadline?" in a roster chat resolves
 *    without a model (lib/axis/nlu.ts).
 *
 * Replayed messages are the counselor's text and AxIS's answers only (tool
 * results are never stored). Once 20261108000004 is in, an answer that quoted
 * 8+ words of free text carries those runs (`outside_quotes`, lib/axis/quotes.ts):
 * while it is among the replayed messages the chat is flagged (`History.flagged`),
 * and the fold replaces each run with "[quote from <source>]", so the summary
 * never carries the words.
 *
 * A paraphrase still gets through, so once 20261203000002 is in each answer stores whether its turn read outside
 * content (`ai_messages.read_outside`, the dialogue state's `outside`), and a fold over any such turn, a quoting
 * answer or an unchecked one marks the summary (`ai_conversations.summary_outside`, sticky: the next fold merges the
 * old summary in). While a marked summary is in use (`History.summaryOutside`) instant changes wait for Confirm.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { wrapUntrusted } from "../context/pack.js";
import { fromPostgrest } from "../errors.js";
import { flagsReady, isSchemaMissing, taintReady } from "./failsafe.js";
import { mergeRuns, quotedRuns, redactQuotes, validRuns } from "./quotes.js";
import { stripCitations } from "./ledger.js";
import { structured } from "./llm.js";
import type { DialogueState } from "./nlu.js";
import { draftHeaderSchema } from "./drafts/state.js";

/** Verbatim messages sent with each request. */
export const RECENT_MESSAGES = 12;
/** Unsummarised messages that trigger a fold. Above RECENT_MESSAGES so a fold always has something to fold. */
export const FOLD_AT = 20;

type MsgRow = { role: string; content: string; created_at: string; outside_quotes?: unknown; read_outside?: unknown };

export type History = {
  summary: string | null;
  /** Oldest first; starts with a user turn; alternates. */
  turns: Anthropic.Beta.BetaMessageParam[];
  state: DialogueState | null;
  /**
   * A replayed answer quoted free text, or was never checked for quotes (saved before 20261108000004, or by /chat):
   * the chat stays flagged (changes wait for Confirm) while it is replayed.
   */
  flagged: boolean;
  /** Those quoted words, as free text this turn can see (re-quoting them keeps the flag). */
  quoted: { source: string; text: string }[];
  /**
   * The summary in use was folded from turns that read outside content (20261203000002): it may paraphrase text
   * someone else wrote, so instant changes wait for Confirm. False with no summary, or before the migration.
   */
  summaryOutside: boolean;
  /** The conversation's updated_at as read: the route's after-`done` state write lands only if it hasn't moved. */
  version: string | null;
};

/** The columns history reads: the text, and its quote marks once 20261108000004 is in. */
const messageColumns = (flags: boolean, taint = false) => `role, content, created_at${flags ? ", outside_quotes" : ""}${taint ? ", read_outside" : ""}`;
const flagsOn = (request: FastifyRequest) => flagsReady(request.db).catch(() => false);
/** 20261203000002 is in. Any probe failure reads as not: the summary is then trusted as before. */
const taintOn = (request: FastifyRequest) => taintReady(request.db, request.log).catch(() => false);

/**
 * Whether folding these messages could carry outside content into the summary: an answer whose turn read some
 * (`read_outside`), one that quoted free text, or (once quotes are checked) one never checked. The counselor's own
 * messages never do.
 */
export function foldTainted(rows: MsgRow[], flags: boolean): boolean {
  return rows.some(
    (r) =>
      r.role === "assistant" &&
      (r.read_outside === true || validRuns(r.content, r.outside_quotes).length > 0 || (flags && !Array.isArray(r.outside_quotes)))
  );
}

/** Alternating user/assistant turns from a user turn, with old citation markers removed. */
export function toTurns(rows: MsgRow[]): Anthropic.Beta.BetaMessageParam[] {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const r of rows) {
    if (r.role !== "user" && r.role !== "assistant") continue;
    const content = r.role === "assistant" ? stripCitations(r.content) : r.content;
    if (!content.trim()) continue;
    const last = turns.at(-1);
    // Two of the same role in a row (an answer that failed left no assistant row): merge into one turn.
    if (last && last.role === r.role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role: r.role, content });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

const stateSchema = z.object({
  students: z.array(z.object({ id: z.string(), name: z.string() })).max(10),
  colleges: z.array(z.object({ id: z.string(), name: z.string() })).max(10),
  at: z.string(),
  outside: z.boolean().optional(),
  short: z.boolean().optional(),
  draft: draftHeaderSchema.optional(),
  // The question the last answer asked back (lib/axis/nlu.ts PendingAsk). A malformed one is dropped, never the state.
  pending: z
    .union([
      z.object({
        kind: z.literal("student"),
        question: z.string().max(2000),
        candidates: z.array(z.object({ id: z.string(), name: z.string(), grade: z.number().int().nullable(), gradYear: z.string().nullable().optional() })).min(2).max(5),
      }),
      z.object({ kind: z.literal("date"), question: z.string().max(2000), label: z.string().max(60), mode: z.enum(["by", "during"]) }),
    ])
    .optional()
    .catch(undefined),
});

export async function loadHistory(request: FastifyRequest, conversationId: string): Promise<History> {
  const taint = await taintOn(request);
  const convCols: string = `summary, summary_through, state, updated_at${taint ? ", summary_outside" : ""}`;
  const { data: convRow, error } = await request.db
    .from("ai_conversations")
    .select(convCols)
    .eq("id", conversationId)
    .maybeSingle();
  // Before 20261018000001 the memory columns don't exist: answer from recent turns alone.
  if (error && !isSchemaMissing(error)) throw fromPostgrest(error);
  if (error) request.log.warn({ code: error.code }, "axis memory columns missing; recent turns only");
  const conv = (error ? null : convRow) as Record<string, unknown> | null;
  const flags = await flagsOn(request);
  let query = request.db
    .from("ai_messages")
    .select(messageColumns(flags))
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(RECENT_MESSAGES);
  if (conv?.summary_through) query = query.gt("created_at", conv.summary_through as string);
  const { data, error: mErr } = await query;
  if (mErr) throw fromPostgrest(mErr);
  const parsedState = stateSchema.safeParse(conv?.state);
  const rows = ((data ?? []) as unknown as MsgRow[]).slice().reverse();
  const quoted = rows
    .filter((r) => r.role === "assistant")
    .flatMap((r) => validRuns(r.content, r.outside_quotes).map((q) => ({ source: q.source, text: r.content.slice(q.start, q.end) })));
  // Under the rule every AxIS answer is stored with its runs ([] when clean); one without (null) wasn't checked.
  const unchecked = flags && rows.some((r) => r.role === "assistant" && !Array.isArray(r.outside_quotes));
  const summary = (conv?.summary as string | null) ?? null;
  return {
    summary,
    turns: toTurns(rows),
    state: parsedState.success ? parsedState.data : null,
    flagged: quoted.length > 0 || unchecked,
    quoted,
    summaryOutside: taint && !!summary && conv?.summary_outside === true,
    version: typeof conv?.updated_at === "string" ? conv.updated_at : null,
  };
}

/** The chat's files' stored text (20261108000001), for the fold's quote check. Best effort: none on any error. */
async function chatFileTexts(request: FastifyRequest, conversationId: string): Promise<{ source: string; text: string }[]> {
  const { data, error } = await request.db.from("ai_attachments").select("file_name, extracted_text").eq("conversation_id", conversationId);
  if (error) return [];
  return ((data ?? []) as { file_name?: unknown; extracted_text?: unknown }[])
    .filter((f) => typeof f.extracted_text === "string" && f.extracted_text.trim() !== "")
    .map((f) => ({ source: `attachment:${String(f.file_name ?? "file")}`, text: f.extracted_text as string }));
}

/**
 * Never throws: a turn whose state can't be saved has still been answered. With `version` (the updated_at the turn
 * read), the write lands only if nothing wrote the conversation since, so a turn that never saw an activity draft
 * can't wipe the header another turn just saved (lib/axis/drafts/state.ts); a skipped write only loses this turn's
 * pronoun memory.
 */
export async function saveState(request: FastifyRequest, conversationId: string, state: DialogueState, version?: string | null): Promise<void> {
  let update = request.db.from("ai_conversations").update({ state }).eq("id", conversationId);
  if (version) update = update.eq("updated_at", version);
  const { error } = await update;
  if (error) request.log.warn({ code: error.code }, "axis state not saved");
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string", description: "Bullets: what the counselor asked, what was concluded, decisions, open questions, the students and schools named. No essay text." } },
  required: ["summary"],
  additionalProperties: false,
} as const;

/**
 * The fold's transcript: each answer's quoted runs replaced by "[quote from <source>]" before anything else, the
 * stored runs and any run from the chat's files (`fileTexts`: a file attached in a turn is read after its answer,
 * so the stored runs can't include it).
 */
export function foldTranscript(rows: MsgRow[], fileTexts: { source: string; text: string }[] = []): string {
  return rows
    .map((r) => {
      const runs = r.role === "assistant" ? mergeRuns([...validRuns(r.content, r.outside_quotes), ...quotedRuns(r.content, fileTexts)]) : [];
      const text = r.role === "assistant" ? redactQuotes(r.content, runs) : r.content;
      return `${r.role === "user" ? "Counselor" : "AxIS"}: ${stripCitations(text).slice(0, 2000)}`;
    })
    .join("\n\n");
}

type Summarize = (o: { request: FastifyRequest; studentId: string | null; memory: string; transcript: string }) => Promise<{ summary: string } | null>;

/** The fold's model call (Haiku 5.5, structured). */
const summarizeWithModel: Summarize = ({ request, studentId, memory, transcript }) =>
  structured({
    request,
    module: "axis-memory",
    studentId,
    system:
      "You keep a running memory of a counselor's conversation with their assistant. Merge the earlier memory and the new turns into one set of short bullets, at most about 300 words. Keep facts, conclusions and open questions; drop pleasantries.",
    prompt: `Earlier memory:\n${wrapUntrusted("memory", memory)}\n\nNew turns:\n${wrapUntrusted("transcript", transcript)}`,
    schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    parse: z.object({ summary: z.string() }),
    effort: "low",
  });

/**
 * Folds everything but the most recent messages into the summary. Called
 * without awaiting after a turn; a failure keeps the old summary and the next
 * turn simply sends more history.
 * `deps.summarize` replaces the model call (tests).
 */
export async function foldIfLong(request: FastifyRequest, conversationId: string, deps: { summarize?: Summarize } = {}): Promise<void> {
  const taint = await taintOn(request);
  const convCols: string = `summary, summary_through, student_id${taint ? ", summary_outside" : ""}`;
  const { data: convData, error: convErr } = await request.db
    .from("ai_conversations")
    .select(convCols)
    .eq("id", conversationId)
    .maybeSingle();
  const conv = convData as Record<string, unknown> | null;
  // No memory columns (migration not applied) or no row: nothing to fold into.
  if (convErr || !conv) return;
  const flags = await flagsOn(request);
  let query = request.db
    .from("ai_messages")
    .select(messageColumns(flags, taint))
    .eq("conversation_id", conversationId)
    .order("created_at")
    .limit(200);
  if (conv?.summary_through) query = query.gt("created_at", conv.summary_through as string);
  const { data } = await query;
  const rows = (data ?? []) as unknown as MsgRow[];
  if (rows.length < FOLD_AT) return;

  const older = rows.slice(0, rows.length - RECENT_MESSAGES);
  const through = older.at(-1)!.created_at;
  const transcript = foldTranscript(older, flags ? await chatFileTexts(request, conversationId) : []);
  const out = await (deps.summarize ?? summarizeWithModel)({
    request,
    studentId: (conv?.student_id as string | null) ?? null,
    memory: (conv?.summary as string | null) ?? "(none)",
    transcript,
  });
  if (!out) return;
  // Only forward: if two folds race, the later point wins and nothing is folded twice.
  // A summary folded from outside content stays marked: the next fold merges it in, paraphrase and all.
  const outside = taint ? { summary_outside: conv?.summary_outside === true || foldTainted(older, flags) } : {};
  let update = request.db
    .from("ai_conversations")
    .update({ summary: out.summary.slice(0, 4000), summary_through: through, ...outside })
    .eq("id", conversationId);
  update = conv?.summary_through ? update.lt("summary_through", through) : update.is("summary_through", null);
  const { error: upErr } = await update;
  if (upErr) request.log.warn({ code: upErr.code }, "axis memory summary not saved");
}
