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
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { wrapUntrusted } from "../context/pack.js";
import { fromPostgrest } from "../errors.js";
import { stripCitations } from "./ledger.js";
import { structured } from "./llm.js";
import type { DialogueState } from "./nlu.js";

/** Verbatim messages sent with each request. */
export const RECENT_MESSAGES = 12;
/** Unsummarised messages that trigger a fold. Above RECENT_MESSAGES so a fold always has something to fold. */
export const FOLD_AT = 20;

type MsgRow = { role: string; content: string; created_at: string };

export type History = {
  summary: string | null;
  /** Oldest first; starts with a user turn; alternates. */
  turns: Anthropic.Beta.BetaMessageParam[];
  state: DialogueState | null;
};

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
});

export async function loadHistory(request: FastifyRequest, conversationId: string): Promise<History> {
  const { data: conv, error } = await request.db
    .from("ai_conversations")
    .select("summary, summary_through, state")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  let query = request.db
    .from("ai_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(RECENT_MESSAGES);
  if (conv?.summary_through) query = query.gt("created_at", conv.summary_through as string);
  const { data, error: mErr } = await query;
  if (mErr) throw fromPostgrest(mErr);
  const parsedState = stateSchema.safeParse(conv?.state);
  return {
    summary: (conv?.summary as string | null) ?? null,
    turns: toTurns(((data ?? []) as MsgRow[]).slice().reverse()),
    state: parsedState.success ? parsedState.data : null,
  };
}

export async function saveState(request: FastifyRequest, conversationId: string, state: DialogueState): Promise<void> {
  await request.db.from("ai_conversations").update({ state }).eq("id", conversationId);
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string", description: "Bullets: what the counselor asked, what was concluded, decisions, open questions, the students and schools named. No essay text." } },
  required: ["summary"],
  additionalProperties: false,
} as const;

/**
 * Folds everything but the most recent messages into the summary. Called
 * without awaiting after a turn; a failure keeps the old summary and the next
 * turn simply sends more history.
 */
export async function foldIfLong(request: FastifyRequest, conversationId: string): Promise<void> {
  const { data: conv } = await request.db
    .from("ai_conversations")
    .select("summary, summary_through, student_id")
    .eq("id", conversationId)
    .maybeSingle();
  let query = request.db
    .from("ai_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at")
    .limit(200);
  if (conv?.summary_through) query = query.gt("created_at", conv.summary_through as string);
  const { data } = await query;
  const rows = (data ?? []) as MsgRow[];
  if (rows.length < FOLD_AT) return;

  const older = rows.slice(0, rows.length - RECENT_MESSAGES);
  const through = older.at(-1)!.created_at;
  const transcript = older.map((r) => `${r.role === "user" ? "Counselor" : "AxIS"}: ${stripCitations(r.content).slice(0, 2000)}`).join("\n\n");
  const out = await structured({
    request,
    module: "axis-memory",
    studentId: (conv?.student_id as string | null) ?? null,
    system:
      "You keep a running memory of a counselor's conversation with their assistant. Merge the earlier memory and the new turns into one set of short bullets, at most about 300 words. Keep facts, conclusions and open questions; drop pleasantries.",
    prompt: `Earlier memory:\n${wrapUntrusted("memory", (conv?.summary as string | null) ?? "(none)")}\n\nNew turns:\n${wrapUntrusted("transcript", transcript)}`,
    schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    parse: z.object({ summary: z.string() }),
    effort: "low",
  });
  if (!out) return;
  // Only forward: if two folds race, the later point wins and nothing is folded twice.
  let update = request.db.from("ai_conversations").update({ summary: out.summary.slice(0, 4000), summary_through: through }).eq("id", conversationId);
  update = conv?.summary_through ? update.lt("summary_through", through) : update.is("summary_through", null);
  await update;
}
