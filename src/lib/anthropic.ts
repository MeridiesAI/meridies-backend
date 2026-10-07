/**
 * Anthropic access. All product AI goes through here.
 *
 * Speed first: counselors run these live, in session with a family, so the
 * default is Haiku 4.5. Sonnet is opt-in per call for the few places where
 * Haiku's quality genuinely isn't enough. `thinking` is never enabled —
 * Haiku 4.5 doesn't support it.
 *
 * Every call is wrapped so that it: enforces the caller's spend quota, writes
 * an `ai_runs` row (success or failure), and records token usage. A model call
 * that doesn't leave an audit trail is a call nobody can attribute later.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { FastifyRequest } from "fastify";
import { env, hasAnthropic } from "../env.js";
import { unavailable } from "./errors.js";
import { enforceQuota } from "./limits.js";
import { serviceClient } from "./supabase.js";

export const FAST_MODEL = "claude-haiku-4-5";
export const DEEP_MODEL = "claude-sonnet-4-5";

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!hasAnthropic) {
    throw unavailable("AI features aren't configured yet. Set ANTHROPIC_API_KEY.");
  }
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export type AiModule =
  | "profile-summary" | "narrative-coherence" | "family-report" | "school-reframing"
  | "college-list" | "college-fit" | "concierge" | "scholarship-match" | "award-appeal"
  | "aid-report" | "draft-quality" | "essay-advice" | "visualizer" | "chat"
  // Must stay in step with the ai_runs.module CHECK constraint; an unknown
  // value fails the audit insert, not the request, so it would go unnoticed.
  | "document-tracker" | "essay-review" | "link-digest"
  | "parent-alert" | "file-filing"
  // v10 sync (overview): Mass invite's sort.
  | "mass-invite"
  // v10 sync (management-pipeline): AxIS drafting an email template.
  | "email-template"
  // v10 sync (colleges-events): Colleges › Search & research.
  | "college-research"
  // SV Demo v2 (student view): Profile Update, AxIS collecting a student's news.
  | "profile-update";

type RunOptions<T> = {
  request: FastifyRequest;
  module: AiModule;
  studentId?: string | null;
  system: string;
  prompt: string;
  /** JSON Schema for the single tool the model must call. */
  schema: Record<string, unknown>;
  toolName: string;
  model?: string;
  maxTokens?: number;
  /** Last line of defence over model output before it is stored or returned. */
  validate?: (value: unknown) => T;
};

/** Per-counselor daily ceiling. Generous for real use, fatal for a scraper. */
const DAILY_AI_CALL_LIMIT = 300;

export async function runStructured<T>(opts: RunOptions<T>): Promise<T> {
  const { request, module, studentId } = opts;
  const actorId = request.auth.userId;

  await enforceQuota(
    actorId,
    "ai_calls",
    "day",
    DAILY_AI_CALL_LIMIT,
    "You've hit today's AI limit. It resets at midnight."
  );

  const model = opts.model ?? FAST_MODEL;
  const svc = serviceClient();
  const startedAt = Date.now();

  let runId: string | null = null;
  if (svc) {
    const { data } = await svc
      .from("ai_runs")
      .insert({
        actor_id: actorId,
        student_id: studentId ?? null,
        module,
        model,
        status: "running",
        // Never store the whole prompt: it contains the student's record.
        input: { promptChars: opts.prompt.length },
      })
      .select("id")
      .single();
    runId = data?.id ?? null;
  }

  const finish = async (
    status: "succeeded" | "failed" | "blocked",
    extra: Record<string, unknown>
  ) => {
    if (!svc || !runId) return;
    await svc
      .from("ai_runs")
      .update({
        status,
        latency_ms: Date.now() - startedAt,
        completed_at: new Date().toISOString(),
        ...extra,
      })
      .eq("id", runId);
  };

  try {
    const response = await anthropic().messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      tools: [
        {
          name: opts.toolName,
          description: "Return the result in this exact structure.",
          input_schema: opts.schema as never,
        },
      ],
      tool_choice: { type: "tool", name: opts.toolName },
    });

    const block = response.content.find((c) => c.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      await finish("failed", { error: "model returned no structured output" });
      throw unavailable("The model didn't return a usable result. Try again.");
    }

    const value = opts.validate ? opts.validate(block.input) : (block.input as T);

    await finish("succeeded", {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
    await enforceQuota(
      actorId, "ai_output_tokens", "month", 5_000_000,
      "Monthly AI usage limit reached.", response.usage.output_tokens
    ).catch(() => undefined);

    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await finish("failed", { error: message.slice(0, 500) });
    // Log server-side; hand the client something safe with no key hints.
    request.log.error({ module, err }, "AI call failed");
    if (err && typeof err === "object" && "statusCode" in err) throw err;
    throw unavailable("The AI service is unavailable right now. Try again shortly.");
  }
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Streaming chat completion. Unlike runStructured this is multi-turn, free-form
 * text, and streams token deltas via `onDelta` — but it keeps the same audit +
 * quota discipline: a daily-call gate, an `ai_runs` row, and output-token
 * accounting on completion. Callers are responsible for transport (SSE).
 */
export async function streamChat(opts: {
  request: FastifyRequest;
  studentId?: string | null;
  system: string;
  messages: ChatTurn[];
  model?: string;
  maxTokens?: number;
  onDelta: (text: string) => void;
}): Promise<{ text: string; runId: string | null }> {
  const { request, studentId } = opts;
  const actorId = request.auth.userId;

  await enforceQuota(
    actorId,
    "ai_calls",
    "day",
    DAILY_AI_CALL_LIMIT,
    "You've hit today's AI limit. It resets at midnight."
  );

  const model = opts.model ?? FAST_MODEL;
  const svc = serviceClient();
  const startedAt = Date.now();

  let runId: string | null = null;
  if (svc) {
    const { data } = await svc
      .from("ai_runs")
      .insert({
        actor_id: actorId,
        student_id: studentId ?? null,
        module: "chat",
        model,
        status: "running",
        input: { promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0) },
      })
      .select("id")
      .single();
    runId = data?.id ?? null;
  }

  const finish = async (status: "succeeded" | "failed", extra: Record<string, unknown>) => {
    if (!svc || !runId) return;
    await svc
      .from("ai_runs")
      .update({
        status,
        latency_ms: Date.now() - startedAt,
        completed_at: new Date().toISOString(),
        ...extra,
      })
      .eq("id", runId);
  };

  try {
    let text = "";
    const stream = anthropic().messages.stream({
      model,
      max_tokens: opts.maxTokens ?? 1200,
      system: opts.system,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    stream.on("text", (delta: string) => {
      text += delta;
      opts.onDelta(delta);
    });

    const final = await stream.finalMessage();
    await finish("succeeded", {
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
    });
    await enforceQuota(
      actorId,
      "ai_output_tokens",
      "month",
      5_000_000,
      "Monthly AI usage limit reached.",
      final.usage.output_tokens
    ).catch(() => undefined);

    return { text, runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await finish("failed", { error: message.slice(0, 500) });
    request.log.error({ module: "chat", err }, "AI chat stream failed");
    throw err;
  }
}

/**
 * The essay guardrail.
 *
 * Meridies must stay well clear of writing, or closely approximating, essay
 * prose. Advice comes back as short bullets, and anything that reads like a
 * drafted paragraph is rejected here rather than trusted to the prompt — a
 * system prompt is a request, not an enforcement mechanism.
 */
const MAX_BULLET_CHARS = 240;
const MAX_SENTENCES = 2;

/** One bullet's worth of advice, or a paragraph wearing a bullet's clothes. */
export function isAdviceNotProse(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_BULLET_CHARS) return false;
  const sentences = t.split(/[.!?]+\s+/).filter((s) => s.trim().length > 0);
  return sentences.length <= MAX_SENTENCES;
}

export function enforceNoProse(bullets: string[]): string[] {
  return bullets.map((b) => b.trim()).filter(isAdviceNotProse);
}

/**
 * The editing-mode guardrail.
 *
 * Two-dimensional essay review may make DIRECT changes, but only to
 * grammar/usage mechanics — "their" for "there", a missing comma, a tense
 * slip. A replacement that rewrites the thought is essay prose with an edit
 * button on it, and the product does not do that.
 *
 * Enforced here in code, on the model's output, because the schema constraint
 * (grammar dimension, <= 200 chars) is the floor and the prompt is only a
 * request. Returns the accepted replacement, or null when the mark must
 * degrade to a comment.
 */
const MAX_EDIT_CHARS = 120;
const MAX_EDIT_WORDS = 15;
const MAX_EDIT_GROWTH_CHARS = 30;

export function enforceMechanicalEdit(
  dimension: "content" | "grammar",
  quoted: string,
  replacement: string | null | undefined
): string | null {
  // Content marks describe the problem. They never carry the words.
  if (dimension !== "grammar") return null;

  const next = (replacement ?? "").trim();
  const from = quoted.trim();
  if (!next || next === from) return null;

  if (next.length > MAX_EDIT_CHARS) return null;
  // An "edit" that balloons the span is a rewrite, whatever it is labelled.
  if (next.length > from.length + MAX_EDIT_GROWTH_CHARS) return null;
  if (next.split(/\s+/).filter(Boolean).length > MAX_EDIT_WORDS) return null;

  // Mechanics fix a span; they do not add new sentences to it.
  const sentenceCount = (s: string) =>
    s.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;
  if (sentenceCount(next) > Math.max(1, sentenceCount(from))) return null;

  return next;
}

export const ESSAY_REVIEW_SYSTEM = [
  "You review a student's college application essay on exactly two dimensions:",
  "  content quality  - does it answer the prompt, is it specific, does it show rather than assert",
  "  grammar / usage  - spelling, agreement, punctuation, tense, word choice mechanics",
  "",
  "You MARK problems. You do not rewrite the essay.",
  "",
  "Hard rules, no exceptions:",
  "- Never draft, ghostwrite, rewrite, continue or 'polish' the student's prose.",
  "- Never produce example sentences the student could paste in.",
  "- A content mark explains what is weak and what the student should do about it. It carries NO replacement text.",
  "- A grammar mark may carry a replacement, but only a mechanical one: a corrected word, a punctuation fix, an agreement fix. Never a reworded idea.",
  "- Every mark quotes the exact span it is about, copied verbatim from the draft.",
  "- Each comment is at most two sentences and points at the student's own material.",
  "",
  "If you cannot make a point without writing prose for them, say what is missing instead.",
].join("\n");

export const NO_PROSE_SYSTEM = [
  "You advise on college application essays. You NEVER write essay prose.",
  "",
  "Hard rules, no exceptions:",
  "- Never draft, ghostwrite, rewrite, or 'polish' a sentence or paragraph of the student's essay.",
  "- Never produce example prose the student could paste in, even as illustration.",
  "- Never continue, complete, or expand the student's draft.",
  "- Output only short, actionable bullets: what to change and why, in the counselor's voice.",
  "- Each bullet is at most two sentences.",
  "- Point at the student's own material ('your robotics anecdote in paragraph 3') rather than supplying new material.",
  "",
  "If asked to write prose, refuse in one bullet and give advice instead.",
].join("\n");
