/**
 * Rate limiting and spend quotas.
 *
 * Two layers, on purpose:
 *   1. @fastify/rate-limit (see plugins/rateLimit.ts) — cheap, in-process,
 *      soaks up floods before they reach a handler. Resets on deploy.
 *   2. These functions — counters in Postgres, so a limit actually holds across
 *      replicas and restarts. This is the layer that protects AI spend.
 *
 * Both need the service-role key, because the counter tables are deliberately
 * not writable by `authenticated`. Without that key we fall back to an
 * in-process map and log loudly, rather than silently enforcing nothing.
 */

import { serviceClient } from "./supabase.js";
import { hasServiceRole } from "../env.js";
import { tooManyRequests } from "./errors.js";

type Bucket = { windowStart: number; count: number };
const memory = new Map<string, Bucket>();
let warned = false;

function memoryConsume(key: string, limit: number, windowSeconds: number): boolean {
  const now = Date.now();
  const bucket = memory.get(key);
  if (!bucket || now - bucket.windowStart >= windowSeconds * 1000) {
    memory.set(key, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

// Keep the fallback map from growing without bound in a long-lived process.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, bucket] of memory) {
    if (bucket.windowStart < cutoff) memory.delete(key);
  }
}, 60 * 60 * 1000).unref();

/** Returns true when the caller is under the limit. Never throws. */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  log?: { warn: (msg: string) => void }
): Promise<boolean> {
  const svc = serviceClient();
  if (!svc) {
    if (!warned && !hasServiceRole) {
      warned = true;
      log?.warn(
        "SUPABASE_SERVICE_ROLE_KEY is unset — rate limits are per-process only " +
          "and reset on deploy. Set it before going live."
      );
    }
    return memoryConsume(key, limit, windowSeconds);
  }

  const { data, error } = await svc.rpc("consume_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  // Fail open on infrastructure errors — a limiter outage must not take the
  // whole API down — but keep the in-process limiter honest in the meantime.
  if (error) return memoryConsume(key, limit, windowSeconds);
  return data !== false;
}

export async function enforceRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  message?: string
): Promise<void> {
  const allowed = await consumeRateLimit(key, limit, windowSeconds);
  if (!allowed) throw tooManyRequests(message);
}

export type QuotaMetric =
  | "ai_calls"
  | "ai_input_tokens"
  | "ai_output_tokens"
  | "uploads"
  | "parent_alerts"
  | "scholarship_searches"
  | "invites";

/** Longer-horizon guard: daily/monthly caps per user. Returns true if allowed. */
export async function consumeQuota(
  subjectId: string,
  metric: QuotaMetric,
  period: "day" | "month",
  limit: number,
  amount = 1
): Promise<boolean> {
  const svc = serviceClient();
  if (!svc) return memoryConsume(`quota:${subjectId}:${metric}:${period}`, limit, period === "day" ? 86_400 : 2_592_000);

  const { data, error } = await svc.rpc("consume_quota", {
    p_subject: subjectId,
    p_metric: metric,
    p_period: period,
    p_limit: limit,
    p_amount: amount,
  });
  if (error) return true;
  return data !== false;
}

export async function enforceQuota(
  subjectId: string,
  metric: QuotaMetric,
  period: "day" | "month",
  limit: number,
  message: string,
  amount = 1
): Promise<void> {
  const allowed = await consumeQuota(subjectId, metric, period, limit, amount);
  if (!allowed) throw tooManyRequests(message);
}

/**
 * Per-user, per-route limiter for use as a preHandler. The key is scoped to the
 * authenticated user, so one abusive account cannot exhaust everyone's budget.
 */
export function limit(name: string, max: number, windowSeconds: number, message?: string) {
  return async (request: { auth: { userId: string } }) => {
    await enforceRateLimit(`${name}:${request.auth.userId}`, max, windowSeconds, message);
  };
}
