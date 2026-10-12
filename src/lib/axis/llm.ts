/**
 * AxIS's calls to Claude Haiku 5.5 outside the main loop, and the bookkeeping
 * every call shares with the rest of the backend: the practice's AI switches,
 * the caller's daily call quota and monthly output quota, and one ai_runs row
 * per run. A model call that leaves no audit row is one nobody can attribute
 * later.
 *
 * Structured calls use structured outputs (output_config.format), so the
 * answer is schema-valid JSON by construction and is validated again with zod
 * here; the schemas use only what structured outputs accepts (no length or
 * numeric bounds, additionalProperties false on every object).
 */
import { errInfo } from "./failsafe.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { anthropicClient, type AiModule } from "../anthropic.js";
import { enforceQuota } from "../limits.js";
import { assertAiAllowed } from "../practiceSettings.js";
import { serviceClient } from "../supabase.js";
import type { MessagesApi, StreamLike, Usage } from "./loop.js";
import { AXIS_MODEL, featureOn, MAX_TOKENS, PER_MESSAGE_EFFORT_BETA, PINNED_EFFORT, THINKING, type Effort } from "./models.js";

const DAILY_AI_CALL_LIMIT = 300;
const MONTHLY_OUTPUT_TOKENS = 5_000_000;

/** The live client behind the loop's MessagesApi seam. */
export function messagesApi(): MessagesApi {
  const client = anthropicClient();
  return { stream: (params, options) => client.beta.messages.stream(params, options) as unknown as StreamLike };
}

export async function chargeCall(request: FastifyRequest): Promise<void> {
  await enforceQuota(request.auth.userId, "ai_calls", "day", DAILY_AI_CALL_LIMIT, "You've hit today's AI limit. It resets at midnight.");
}

export async function chargeOutput(request: FastifyRequest, outputTokens: number): Promise<void> {
  if (outputTokens <= 0) return;
  await enforceQuota(request.auth.userId, "ai_output_tokens", "month", MONTHLY_OUTPUT_TOKENS, "Monthly AI usage limit reached.", outputTokens).catch(() => undefined);
}

export type Run = { id: string | null; startedAt: number };

export async function openRun(request: FastifyRequest, module: AiModule, studentId: string | null, input: Record<string, unknown>): Promise<Run> {
  const svc = serviceClient();
  const startedAt = Date.now();
  if (!svc) return { id: null, startedAt };
  const { data, error } = await svc
    .from("ai_runs")
    .insert({ actor_id: request.auth.userId, student_id: studentId, module, model: AXIS_MODEL, status: "running", input })
    .select("id")
    .single();
  // An audit row that can't be written (the axis* labels missing from ai_runs_module_check before
  // 20261018000001) must not cost the counselor their answer; it is logged so it doesn't go unnoticed.
  if (error) request.log.warn({ code: error.code, module }, "axis ai_runs row not written");
  return { id: (data?.id as string | undefined) ?? null, startedAt };
}

export async function closeRun(
  run: Run,
  status: "succeeded" | "failed" | "blocked",
  usage: Usage,
  output: Record<string, unknown>,
  error?: string
): Promise<void> {
  const svc = serviceClient();
  if (!svc || !run.id) return;
  await svc
    .from("ai_runs")
    .update({
      status,
      latency_ms: Date.now() - run.startedAt,
      completed_at: new Date().toISOString(),
      input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
      output_tokens: usage.output,
      output: { ...output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite },
      ...(error ? { error: error.slice(0, 500) } : {}),
    })
    .eq("id", run.id);
}

const usageOf = (m: Anthropic.Message): Usage => ({
  input: m.usage.input_tokens,
  output: m.usage.output_tokens,
  cacheRead: m.usage.cache_read_input_tokens ?? 0,
  cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
});

/**
 * One structured answer from Haiku 5.5, or null when the model declined, ran
 * out of room or returned something the schema check rejects. Callers treat
 * null as "no result" (the adjudicator skips, the memory keeps its old
 * summary), never as an error for the counselor.
 */
export async function structured<T>(o: {
  request: FastifyRequest;
  module: AiModule;
  studentId?: string | null;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  parse: z.ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
  /** Aborts the call (the counselor left, or the turn ran out of time); an aborted call returns null. */
  signal?: AbortSignal;
  /** The daily call was already charged for this one (the route charges a turn's first call before streaming). */
  precharged?: boolean;
}): Promise<T | null> {
  await assertAiAllowed(o.request, o.module);
  if (!o.precharged) await chargeCall(o.request);
  const effort = o.effort ?? "low";
  const run = await openRun(o.request, o.module, o.studentId ?? null, { promptChars: o.prompt.length, effort });
  try {
    const msg = await anthropicClient().messages.create({
      model: AXIS_MODEL,
      max_tokens: o.maxTokens ?? MAX_TOKENS[effort],
      thinking: { type: "adaptive" },
      output_config: { effort, format: { type: "json_schema", schema: o.schema } },
      system: o.system,
      messages: [{ role: "user", content: o.prompt }],
    }, o.signal ? { signal: o.signal } : undefined);
    const usage = usageOf(msg);
    await chargeOutput(o.request, usage.output);
    if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
      await closeRun(run, msg.stop_reason === "refusal" ? "blocked" : "failed", usage, { stop: msg.stop_reason });
      return null;
    }
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const parsed = o.parse.safeParse(JSON.parse(text));
    await closeRun(run, parsed.success ? "succeeded" : "failed", usage, { valid: parsed.success });
    return parsed.success ? parsed.data : null;
  } catch (err) {
    await closeRun(run, "failed", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, {}, err instanceof Error ? err.message : "unknown error");
    o.request.log.warn({ err: errInfo(err), module: o.module }, "axis structured call failed");
    return null;
  }
}

/**
 * Writes the cached prefix (tools, the base prompt and the student's record)
 * before the counselor's first question, with a max_tokens: 0 request: the
 * API runs prefill, writes the cache at the breakpoints and returns no
 * output. Same model, thinking, effort, tools and system blocks as the real
 * request, or the entry written is one the real request never reads.
 */
export async function prewarm(o: {
  request: FastifyRequest;
  studentId: string | null;
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaTool[];
}): Promise<{ cacheWrite: number; cacheRead: number }> {
  // The pre-warm is a billed call (it writes the cache), so it counts against the daily quota like any other.
  await chargeCall(o.request);
  const run = await openRun(o.request, "axis-warm", o.studentId, { tools: o.tools.length });
  try {
    const perMessage = featureOn("perMessageEffort");
    const msg = await anthropicClient().beta.messages.create({
      model: AXIS_MODEL,
      max_tokens: 0,
      thinking: THINKING,
      output_config: { effort: PINNED_EFFORT },
      ...(perMessage ? { betas: [PER_MESSAGE_EFFORT_BETA] } : {}),
      system: o.system,
      tools: o.tools,
      messages: [{ role: "user", content: "warmup" }],
    });
    const usage = { input: msg.usage.input_tokens, output: 0, cacheRead: msg.usage.cache_read_input_tokens ?? 0, cacheWrite: msg.usage.cache_creation_input_tokens ?? 0 };
    await closeRun(run, "succeeded", usage, {});
    return { cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead };
  } catch (err) {
    await closeRun(run, "failed", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, {}, err instanceof Error ? err.message : "unknown error");
    throw err;
  }
}
