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
import type { ContextUsage } from "./context/types.js";
import { HttpError, unavailable } from "./errors.js";
import { enforceQuota } from "./limits.js";
import { assertAiAllowed } from "./practiceSettings.js";
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

/** A working key is re-checked this often; a failing one, sooner. */
const KEY_CHECK_OK_MS = 10 * 60 * 1000;
const KEY_CHECK_FAIL_MS = 60 * 1000;
let keyCheck: { at: number; ok: boolean } | null = null;
let keyCheckInFlight: Promise<boolean> | null = null;

/**
 * Whether ANTHROPIC_API_KEY is set *and accepted*. A set-but-revoked key used
 * to read as healthy until a counselor opened AxIS; this asks Anthropic (one
 * cheap models.list call, cached) so /health and monitoring see it first.
 */
export async function anthropicKeyWorks(log?: { warn: (o: object, m: string) => void }): Promise<boolean> {
  if (!hasAnthropic) return false;
  const now = Date.now();
  if (keyCheck && now - keyCheck.at < (keyCheck.ok ? KEY_CHECK_OK_MS : KEY_CHECK_FAIL_MS)) return keyCheck.ok;
  if (!keyCheckInFlight) {
    keyCheckInFlight = anthropic()
      .models.list({ limit: 1 }, { timeout: 5000, maxRetries: 0 })
      .then(() => true)
      .catch((err: unknown) => {
        const status = err && typeof err === "object" && "status" in err ? (err as { status?: number }).status : undefined;
        log?.warn({ status }, "anthropic key check failed");
        return false;
      })
      .then((ok) => {
        keyCheck = { at: Date.now(), ok };
        return ok;
      })
      .finally(() => {
        keyCheckInFlight = null;
      });
  }
  return keyCheckInFlight;
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
  // BACKEND_TODO §5: words -> search filters, cited web research, resource
  // Q&A, list builder explanations.
  | "college-search" | "web-research" | "resource-qa" | "list-explain"
  // SV Demo v2 (student view): Profile Update, AxIS collecting a student's news.
  | "profile-update"
  // A file the student handed in against a task, checked against what was asked.
  | "submission-review"
  | "activity-research"
  | "research-match";

/**
 * A file the model reads directly: a PDF as a document block, an image as an
 * image block. Base64 of the stored bytes; the caller checks type and size.
 */
export type AiAttachment = {
  mediaType: "application/pdf" | "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  title?: string;
};

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
  /** Files the model reads alongside the prompt (see AiAttachment). */
  attachments?: AiAttachment[];
  /** Last line of defence over model output before it is stored or returned. */
  validate?: (value: unknown) => T;
  /** Which context sections the prompt carried (names only), stored on the audit row. */
  contextUsage?: ContextUsage;
};

function userContent(prompt: string, attachments: AiAttachment[] | undefined): Anthropic.MessageParam["content"] {
  if (!attachments?.length) return prompt;
  const blocks: Anthropic.ContentBlockParam[] = attachments.map((a) =>
    a.mediaType === "application/pdf"
      ? {
          type: "document" as const,
          source: { type: "base64" as const, media_type: "application/pdf" as const, data: a.data },
          ...(a.title ? { title: a.title.slice(0, 200) } : {}),
        }
      : { type: "image" as const, source: { type: "base64" as const, media_type: a.mediaType, data: a.data } }
  );
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

/** Per-counselor daily ceiling. Generous for real use, fatal for a scraper. */
const DAILY_AI_CALL_LIMIT = 300;

export async function runStructured<T>(opts: RunOptions<T>): Promise<T> {
  const { request, module, studentId } = opts;
  const actorId = request.auth.userId;

  // The practice's Data & privacy switches come before the quota is spent.
  await assertAiAllowed(request, module);

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
        input: { promptChars: opts.prompt.length, attachments: opts.attachments?.length ?? 0, context: opts.contextUsage ?? null },
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
      messages: [{ role: "user", content: userContent(opts.prompt, opts.attachments) }],
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
  /** Which context sections the prompt carried (names only), stored on the audit row. */
  contextUsage?: ContextUsage | null;
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
        input: { promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0), context: opts.contextUsage ?? null },
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
    if (err instanceof HttpError) throw err;
    throw unavailable("AxIS is unavailable right now. Try again in a few minutes.");
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

// ---- Web research with citations -----------------------------------------------------

/**
 * Research answers use the most capable current model: a counselor acts on
 * them. Everything else stays on FAST_MODEL.
 */
export const RESEARCH_MODEL = "claude-opus-5-5";

/**
 * Where research may look. Plain hostnames (subdomains included); the tools
 * take no wildcards, so a question about one school also adds that school's
 * own site (see researchDomains).
 */
export const RESEARCH_DOMAINS = [
  "collegeboard.org",
  "act.org",
  "commonapp.org",
  "universityofcalifornia.edu",
  "ucop.edu",
  "calstate.edu",
  "studentaid.gov",
  "ed.gov",
  "csac.ca.gov",
  "fairtest.org",
  "collegescorecard.ed.gov",
] as const;

/** The allow-list plus the schools' own sites, as bare hostnames (max 64). */
export function researchDomains(extraSites: (string | null | undefined)[] = []): string[] {
  const hosts = extraSites
    .map((s) => {
      try {
        return s ? new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "").toLowerCase() : null;
      } catch {
        return null;
      }
    })
    .filter((h): h is string => !!h && h.includes(".") && /^[a-z0-9.-]+$/.test(h));
  return [...new Set([...RESEARCH_DOMAINS, ...hosts])].slice(0, 64);
}

export type Cited = { url: string; title: string | null; citedText: string };
export type ResearchPart = { text: string; citations: Cited[] };
export type ResearchResult = {
  /** The answer in order; a part with no citations is connective text, not a claim. */
  parts: ResearchPart[];
  /** Every distinct source cited. */
  sources: { url: string; title: string | null }[];
  runId: string | null;
  refused: boolean;
};

const RESEARCH_SYSTEM = [
  "You research US college admissions and financial aid facts for a college counselor.",
  "Use web search and web fetch, and answer only from what you find on the allowed official sites.",
  "Every factual claim must rest on a source you retrieved. If you can't find it on an allowed site, say you couldn't confirm it instead of answering from memory.",
  "Name the admission cycle or aid year a fact belongs to whenever the source does.",
  "Be brief: a few short sentences or bullets for the counselor. Never write essay prose for a student.",
].join("\n");

/**
 * One cited research answer. Same audit and quota discipline as runStructured:
 * a daily-call gate, an ai_runs row, output-token accounting. A refusal or a
 * pause is handled here; the caller gets parts with their citations.
 */
export async function runWebResearch(opts: {
  request: FastifyRequest;
  module: AiModule;
  question: string;
  /** Facts or catalog rows the answer should be read against (not instructions). */
  context?: string;
  domains: string[];
  studentId?: string | null;
  maxSearches?: number;
}): Promise<ResearchResult> {
  const { request, module } = opts;
  const actorId = request.auth.userId;
  await assertAiAllowed(request, module);
  await enforceQuota(actorId, "ai_calls", "day", DAILY_AI_CALL_LIMIT, "You've hit today's AI limit. It resets at midnight.");

  const svc = serviceClient();
  const startedAt = Date.now();
  let runId: string | null = null;
  if (svc) {
    const { data } = await svc
      .from("ai_runs")
      .insert({
        actor_id: actorId,
        student_id: opts.studentId ?? null,
        module,
        model: RESEARCH_MODEL,
        status: "running",
        input: { promptChars: opts.question.length + (opts.context?.length ?? 0), domains: opts.domains.length },
      })
      .select("id")
      .single();
    runId = data?.id ?? null;
  }
  const finish = async (status: "succeeded" | "failed" | "blocked", extra: Record<string, unknown>) => {
    if (!svc || !runId) return;
    await svc
      .from("ai_runs")
      .update({ status, latency_ms: Date.now() - startedAt, completed_at: new Date().toISOString(), ...extra })
      .eq("id", runId);
  };

  const userText = opts.context
    ? `${opts.question}\n\n<catalog_facts>\n${opts.context}\n</catalog_facts>\nThe catalog facts are what Meridies has on file; check them against the sources and say where a source disagrees.`
    : opts.question;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userText }];

  try {
    let inputTokens = 0;
    let outputTokens = 0;
    let response: Anthropic.Beta.BetaMessage | null = null;
    // Server tools can pause a long turn; resume it a few times at most.
    for (let turn = 0; turn < 4; turn++) {
      response = await anthropic().beta.messages.create(
        {
          model: RESEARCH_MODEL,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium" },
          system: RESEARCH_SYSTEM,
          // The basic tool versions on purpose: the _20260209 ones filter results
          // through code execution, and the answer then comes back with empty
          // citation lists (checked 10/7). "A link for every claim" needs the
          // per-sentence web_search_result_location citations these give.
          tools: [
            { type: "web_search_20250305", name: "web_search", allowed_domains: opts.domains, max_uses: opts.maxSearches ?? 5 },
            { type: "web_fetch_20250910", name: "web_fetch", allowed_domains: opts.domains, max_uses: 3, citations: { enabled: true }, max_content_tokens: 20000 },
          ],
          messages,
        },
        { timeout: 180_000 }
      );
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content });
    }
    if (!response) throw new Error("no response");

    if (response.stop_reason === "refusal") {
      await finish("blocked", { input_tokens: inputTokens, output_tokens: outputTokens, error: "refusal" });
      return { parts: [], sources: [], runId, refused: true };
    }

    const parts: ResearchPart[] = [];
    for (const block of response.content) {
      if (block.type !== "text" || !block.text.trim()) continue;
      const citations: Cited[] = [];
      for (const c of block.citations ?? []) {
        if (c.type === "web_search_result_location") {
          citations.push({ url: c.url, title: c.title ?? null, citedText: c.cited_text });
        } else if (c.type === "char_location" || c.type === "page_location" || c.type === "content_block_location") {
          const title = "document_title" in c ? (c.document_title ?? null) : null;
          // Fetched pages cite as documents; their URL is in the title when the API gives no other.
          if (title && /^https?:\/\//.test(title)) citations.push({ url: title, title, citedText: c.cited_text });
        }
      }
      parts.push({ text: block.text, citations });
    }
    const seen = new Map<string, string | null>();
    for (const p of parts) for (const c of p.citations) if (!seen.has(c.url)) seen.set(c.url, c.title);

    await finish("succeeded", { input_tokens: inputTokens, output_tokens: outputTokens });
    await enforceQuota(actorId, "ai_output_tokens", "month", 5_000_000, "Monthly AI usage limit reached.", outputTokens).catch(() => undefined);
    return { parts, sources: [...seen].map(([url, title]) => ({ url, title })), runId, refused: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await finish("failed", { error: message.slice(0, 500) });
    request.log.error({ module, err }, "AI research failed");
    if (err instanceof HttpError) throw err;
    throw unavailable("Research is unavailable right now. Try again shortly.");
  }
}
