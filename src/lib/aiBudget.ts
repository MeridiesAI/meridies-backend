/**
 * One budget gate for every model call (AxIS security PR A2; spec section 1). A call reserves before it runs and
 * settles after, always:
 *
 *   const hold = await reserve(subject, estimate, log);   // throws 429 at a cap, 503 when it can't check
 *   try { call the model } finally { await settle(hold, usage, log); }
 *
 * A user reservation is five lines, taken all or none by `ai_budget_reserve` (20261108000002): 1 call (per UTC
 * day), max output tokens and weighted input tokens (per calendar month), and the estimated spend on the user's
 * own daily line and on the company's daily ceiling. A system job reserves its monthly calls and the company line.
 * Settle swaps the reservation for what the call used; the call stays counted.
 *
 * Fail closed: once the migration is in, a check that errors or takes over 2 s refuses the call (503). Before it
 * is in, the gate counts as the API always did (the daily call quota, monthly output after the call) and says so
 * in the log. With no service client, production refuses every call; development counts in process.
 *
 * Prices come from `private.ai_prices` through `ai_budget_prices()`, read on first use and every 10 minutes.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { priceTableFrom, spendUsd, weightedInput, type CallUsage, type PriceTable } from "./aiPricing.js";
import { isSchemaMissing } from "./axis/failsafe.js";
import { fileTokens } from "./axis/fileTokens.js";
import { escapeHtml, sendEmail } from "./email.js";
import { HttpError } from "./errors.js";
import { consumeQuota, consumeRateLimit } from "./limits.js";
import { serviceClient } from "./supabase.js";

/** What the gate logs through: a request's logger, or a job's. */
export type BudgetLog = { warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };

export type SystemSubject = "events-discovery";
export const SYSTEM_CALLS_PER_MONTH: Record<SystemSubject, number> = { "events-discovery": 2000 };

export type BudgetSubject = { userId: string } | { system: SystemSubject };
export type CallEstimate = { model: string; maxOutputTokens: number; promptTokens: number; webSearches?: number; module?: string };

type Metric = "calls" | "output_tokens" | "input_weighted" | "spend_usd";
type Period = "day" | "month";
export type ReserveLine = { subject: string; metric: Metric; period: Period; period_start: string; amount: number; limit: number };
export type SettleLine = { subject: string; metric: Metric; period: Period; period_start: string; delta: number };
export type ReserveResult = { ok: true; totals: Record<string, number> } | { ok: false; subject: string; metric: string; period: string };

/** A reservation, handed back to settle. Callers don't look inside. */
export type Hold = {
  readonly subject: BudgetSubject;
  readonly model: string;
  readonly mode: "enforced" | "fallback" | "memory";
  readonly lines: readonly ReserveLine[];
  settled: boolean;
};

/** Where the counters live: the Task 1 RPCs on the service client, or a test's own. */
export type BudgetBackend = {
  probe(): Promise<void>;
  prices(): Promise<unknown[]>;
  reserve(lines: ReserveLine[]): Promise<ReserveResult>;
  settle(lines: SettleLine[]): Promise<void>;
  total(subject: string, metric: string, period: string, start: string): Promise<number>;
};

export type CeilingAlert = { pct: 50 | 80 | 100; day: string; spendUsd: number; ceilingUsd: number };

export const MIGRATION = "20261108000002_ai_budget";
const CHECK_TIMEOUT_MS = 2_000;
const MISSING_RECHECK_MS = 30_000;
const PRICES_TTL_MS = 10 * 60_000;
const FALLBACK_WARN_EVERY_MS = 60 * 60_000;

const UNAVAILABLE = "AI is unavailable right now. Try again in a few minutes.";
const MONTHLY = "Monthly AI usage limit reached.";
const SYSTEM_SPENT = "This month's system AI budget is used up.";
const unavailableError = () => new HttpError(503, UNAVAILABLE, "ai_budget_unavailable");

/** The time to the next 00:00 UTC, rounded up to whole hours: "in 5 hours", "in 1 hour", "in under an hour". */
export function resetsIn(now: Date): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const ms = midnight - now.getTime();
  if (ms < 3_600_000) return "in under an hour";
  const hours = Math.ceil(ms / 3_600_000);
  return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
}
const dailyError = (now: Date) => new HttpError(429, `You've hit today's AI limit. It resets ${resetsIn(now)}.`);
const pausedError = (now: Date) => new HttpError(429, `AI features are paused for today. They come back ${resetsIn(now)}.`, "ai_paused");

const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const monthOf = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const subjectKey = (s: BudgetSubject) => ("userId" in s ? `user:${s.userId}` : `system:${s.system}`);

function caps() {
  return {
    calls: env.AI_DAILY_CALLS,
    userSpend: env.AI_USER_DAILY_USD,
    output: env.AI_MONTHLY_OUTPUT_TOKENS,
    input: env.AI_MONTHLY_INPUT_TOKENS,
    ceiling: env.AI_DAILY_CEILING_USD,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("AI budget check ran out of time"));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`AI budget check took over ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ---- The backend, and test seams ----

function rpcBackend(): BudgetBackend | null {
  const svc = serviceClient();
  if (!svc) return null;
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await svc.rpc(fn, args);
    if (error) throw error;
    return data as unknown;
  };
  return {
    probe: async () => void (await rpc("ai_budget_total", { p_subject: "company", p_metric: "calls", p_period: "day", p_period_start: dayOf(new Date()) })),
    prices: async () => ((await rpc("ai_budget_prices", {})) as unknown[]) ?? [],
    reserve: async (lines) => (await rpc("ai_budget_reserve", { p_lines: lines })) as ReserveResult,
    settle: async (lines) => void (await rpc("ai_budget_settle", { p_lines: lines })),
    total: async (subject, metric, period, start) =>
      Number(await rpc("ai_budget_total", { p_subject: subject, p_metric: metric, p_period: period, p_period_start: start })) || 0,
  };
}

let backendOverride: BudgetBackend | null = null;
let alertOverride: ((a: CeilingAlert) => Promise<void>) | null = null;
let productionOverride: boolean | null = null;

let ready = false;
let missingUntil = 0;
let prices: { table: PriceTable; at: number } | null = null;
let lastFallbackWarn: number | null = null;
const memory = new Map<string, number>();
/** Ceiling alerts this process already claimed (day:pct), so a paused day doesn't cost a database call per refusal. */
const alerted = new Set<string>();
const unpriced = new Set<string>();

/** Tests: a fake backend (null: the service client's). Resets everything the gate remembers. */
export function setBudgetBackend(b: BudgetBackend | null): void {
  backendOverride = b;
  ready = false;
  missingUntil = 0;
  prices = null;
  lastFallbackWarn = null;
  memory.clear();
  alerted.clear();
  unpriced.clear();
}
/** Tests: capture ceiling alerts instead of emailing them (null: email). */
export function setAlertSender(fn: ((a: CeilingAlert) => Promise<void>) | null): void {
  alertOverride = fn;
}
/** Tests: act as production, or not (null: NODE_ENV decides). */
export function setProductionForTest(on: boolean | null): void {
  productionOverride = on;
}
const isProduction = () => productionOverride ?? env.NODE_ENV === "production";
const backend = () => backendOverride ?? rpcBackend();

/** "ready" is kept for the process; "missing" is checked again after 30 s; any other probe error throws. */
async function readiness(b: BudgetBackend, ms = CHECK_TIMEOUT_MS): Promise<"ready" | "missing"> {
  if (ready) return "ready";
  if (Date.now() < missingUntil) return "missing";
  try {
    await withTimeout(b.probe(), ms);
    ready = true;
    return "ready";
  } catch (err) {
    if (isSchemaMissing(err)) {
      missingUntil = Date.now() + MISSING_RECHECK_MS;
      return "missing";
    }
    throw err;
  }
}

async function priceTable(b: BudgetBackend, log: BudgetLog, ms = CHECK_TIMEOUT_MS): Promise<PriceTable> {
  if (prices && Date.now() - prices.at < PRICES_TTL_MS) return prices.table;
  try {
    const table = priceTableFrom(await withTimeout(b.prices(), ms));
    if (table.size === 0) throw new Error("ai_prices is empty");
    prices = { table, at: Date.now() };
    return table;
  } catch (err) {
    if (!prices) throw err;
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "AI prices not refreshed; using the last table");
    prices.at = Date.now();
    return prices.table;
  }
}

// ---- Reserve ----

function linesFor(subject: BudgetSubject, est: CallEstimate, t: PriceTable, now: Date): ReserveLine[] {
  const c = caps();
  const day = dayOf(now);
  const month = monthOf(now);
  const spend = round6(spendUsd(t, est.model, { input: est.promptTokens, output: est.maxOutputTokens, cacheRead: 0, cacheWrite: 0, webSearches: est.webSearches }));
  const company: ReserveLine = { subject: "company", metric: "spend_usd", period: "day", period_start: day, amount: spend, limit: c.ceiling };
  if ("system" in subject) {
    const key = subjectKey(subject);
    return [{ subject: key, metric: "calls", period: "month", period_start: month, amount: 1, limit: SYSTEM_CALLS_PER_MONTH[subject.system] }, company];
  }
  const user = subjectKey(subject);
  const input = round6(weightedInput(t, est.model, { input: est.promptTokens, output: 0, cacheRead: 0, cacheWrite: 0 }));
  return [
    { subject: user, metric: "calls", period: "day", period_start: day, amount: 1, limit: c.calls },
    { subject: user, metric: "output_tokens", period: "month", period_start: month, amount: est.maxOutputTokens, limit: c.output },
    { subject: user, metric: "input_weighted", period: "month", period_start: month, amount: input, limit: c.input },
    { subject: user, metric: "spend_usd", period: "day", period_start: day, amount: spend, limit: c.userSpend },
    company,
  ];
}

function refusalFor(r: { subject: string; metric: string }, now: Date): HttpError {
  if (r.subject === "company") return pausedError(now);
  if (r.subject.startsWith("system:")) return new HttpError(429, SYSTEM_SPENT);
  if (r.metric === "calls" || r.metric === "spend_usd") return dailyError(now);
  return new HttpError(429, MONTHLY);
}

/** Sends a ceiling alert once per UTC day per threshold (this process, then the database decides), never in the caller's way. */
function alertOnce(pct: CeilingAlert["pct"], day: string, spend: number | (() => Promise<number>), log: BudgetLog): void {
  const memo = `${day}:${pct}`;
  if (alerted.has(memo)) return;
  alerted.add(memo);
  const ceilingUsd = caps().ceiling;
  void (async () => {
    if (!(await consumeRateLimit(`ai-ceiling:${day}:${pct}`, 1, 172_800))) return;
    const spendUsd = typeof spend === "number" ? spend : await spend().catch(() => ceilingUsd);
    const send = alertOverride ?? ((a: CeilingAlert) => sendCeilingEmail(a, log));
    await send({ pct, day, spendUsd, ceilingUsd });
  })().catch((err) => log.error({ err: err instanceof Error ? err.message : String(err), pct }, "AI ceiling email not sent"));
}

/** What a sound `ai_budget_reserve` answer looks like; anything else is a failed check. */
function soundAnswer(r: unknown): r is ReserveResult {
  if (!r || typeof r !== "object") return false;
  const a = r as Record<string, unknown>;
  if (a.ok === true) return a.totals === undefined || (typeof a.totals === "object" && a.totals !== null);
  return a.ok === false && typeof a.subject === "string" && typeof a.metric === "string";
}

function memoryReserve(subject: BudgetSubject, est: CallEstimate, now: Date): Hold {
  const c = caps();
  const key = subjectKey(subject);
  const calls = `${key}|calls|${dayOf(now)}`;
  const output = `${key}|output|${monthOf(now)}`;
  const callLimit = "system" in subject ? SYSTEM_CALLS_PER_MONTH[subject.system] : c.calls;
  if ((memory.get(calls) ?? 0) + 1 > callLimit) throw "system" in subject ? new HttpError(429, SYSTEM_SPENT) : dailyError(now);
  if ((memory.get(output) ?? 0) + est.maxOutputTokens > c.output) throw new HttpError(429, MONTHLY);
  memory.set(calls, (memory.get(calls) ?? 0) + 1);
  memory.set(output, (memory.get(output) ?? 0) + est.maxOutputTokens);
  const lines: ReserveLine[] = [{ subject: key, metric: "output_tokens", period: "month", period_start: monthOf(now), amount: est.maxOutputTokens, limit: c.output }];
  return { subject, model: est.model, mode: "memory", lines, settled: false };
}

async function fallbackReserve(subject: BudgetSubject, est: CallEstimate, now: Date, log: BudgetLog): Promise<Hold> {
  if (lastFallbackWarn === null || Date.now() - lastFallbackWarn >= FALLBACK_WARN_EVERY_MS) {
    lastFallbackWarn = Date.now();
    log.warn(`AI budget fallback active: migration ${MIGRATION} not applied, caps not enforced`);
  }
  // As the API always counted: the daily call quota (which lets a call through when its own check errors).
  if ("userId" in subject && !(await consumeQuota(subject.userId, "ai_calls", "day", caps().calls))) throw dailyError(now);
  return { subject, model: est.model, mode: "fallback", lines: [], settled: false };
}

/** Reserves one model call for `subject`, or throws: 429 at a cap (the cap's own words), 503 when it can't check. */
export async function reserve(subject: BudgetSubject, est: CallEstimate, log: BudgetLog): Promise<Hold> {
  const now = new Date();
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  const left = () => deadline - Date.now();
  const b = backend();
  if (!b) {
    if (isProduction()) {
      log.error("AI budget: no service client in production; refusing the call");
      throw unavailableError();
    }
    return memoryReserve(subject, est, now);
  }
  let state: "ready" | "missing";
  try {
    state = await readiness(b, left());
  } catch (err) {
    log.error({ err }, "AI budget check failed; refusing the call");
    throw unavailableError();
  }
  if (state === "missing") return fallbackReserve(subject, est, now, log);

  let lines: ReserveLine[];
  let result: ReserveResult;
  try {
    const table = await priceTable(b, log, left());
    if (!table.has(est.model) && !unpriced.has(est.model)) {
      unpriced.add(est.model);
      log.warn({ model: est.model }, `AI prices: no row for ${est.model}; it is priced at the table's highest rates`);
    }
    lines = linesFor(subject, est, table, now);
    const answer: unknown = await withTimeout(b.reserve(lines), left());
    if (!soundAnswer(answer)) throw new Error(`ai_budget_reserve answered ${JSON.stringify(answer)?.slice(0, 200)}`);
    result = answer;
  } catch (err) {
    log.error({ err }, "AI budget check failed; refusing the call");
    throw unavailableError();
  }
  const day = dayOf(now);
  if (!result.ok) {
    if (result.subject === "company") alertOnce(100, day, () => b.total("company", "spend_usd", "day", day), log);
    throw refusalFor(result, now);
  }

  // Each threshold the company total has reached today, including one a settle passed between reservations.
  const company = result.totals?.["company|spend_usd|day"];
  if (typeof company === "number") {
    for (const pct of [50, 80] as const) if (company >= (caps().ceiling * pct) / 100) alertOnce(pct, day, company, log);
  }
  return { subject, model: est.model, mode: "enforced", lines, settled: false };
}

// ---- Settle ----

/**
 * Swaps the reservation for what the call used; the call stays counted. Never throws.
 * - usage: what the API reported.
 * - "unused": the call never reached the model (a connection error, a refusal before the stream): tokens and spend
 *   are released.
 * - null: not known (the stream was stopped or failed after it started, which Anthropic may still bill): the whole
 *   reservation stays, over-counted rather than under.
 */
export async function settle(hold: Hold, actual: CallUsage | "unused" | null, log: BudgetLog): Promise<void> {
  if (hold.settled) return;
  hold.settled = true;
  if (actual === null) return;
  const usage = actual === "unused" ? null : actual;
  try {
    if (hold.mode === "fallback") {
      if ("userId" in hold.subject && usage && usage.output > 0) {
        await consumeQuota(hold.subject.userId, "ai_output_tokens", "month", caps().output, usage.output).catch(() => undefined);
      }
      return;
    }
    if (hold.mode === "memory") {
      const line = hold.lines[0];
      if (!line) return;
      const key = `${line.subject}|output|${line.period_start}`;
      memory.set(key, Math.max(0, (memory.get(key) ?? 0) - line.amount + (usage?.output ?? 0)));
      return;
    }
    const b = backend();
    const table = prices?.table;
    if (!b || !table) throw new Error("no backend or price table to settle against");
    const used = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const actualOf = (m: Metric): number | null =>
      m === "output_tokens" ? used.output : m === "input_weighted" ? weightedInput(table, hold.model, used) : m === "spend_usd" ? (usage ? spendUsd(table, hold.model, used) : 0) : null;
    const lines: SettleLine[] = [];
    for (const l of hold.lines) {
      const a = actualOf(l.metric);
      if (a === null) continue;
      const delta = round6(a - l.amount);
      if (delta !== 0) lines.push({ subject: l.subject, metric: l.metric, period: l.period, period_start: l.period_start, delta });
    }
    if (lines.length) await withTimeout(b.settle(lines), CHECK_TIMEOUT_MS);
  } catch (err) {
    // The reservation stays: it over-counts, which is the safe side.
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "AI budget not settled; the reservation stays");
  }
}

// ---- Helpers for the call sites ----

/** A response's usage as the gate settles it (web searches included). */
export function usageOf(m: {
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number | null } | null };
}): CallUsage {
  return {
    input: m.usage.input_tokens,
    output: m.usage.output_tokens,
    cacheRead: m.usage.cache_read_input_tokens ?? 0,
    cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
    webSearches: m.usage.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * How a call that threw settles: "unused" when the API answered nothing (an HTTP error, a lost connection), null
 * when it may have billed (stopped mid-call, aborted, an error after a stream started).
 */
export function usageAfterError(err: unknown, o: { signal?: AbortSignal; started?: boolean } = {}): "unused" | null {
  if (o.signal?.aborted || o.started) return null;
  // Our own refusal before the call (no API key configured, say) reached nobody.
  if (err instanceof HttpError) return "unused";
  return err instanceof Anthropic.APIError && !(err instanceof Anthropic.APIUserAbortError) ? "unused" : null;
}

// ---- Status, account deletion, estimates ----

export async function budgetMode(log: BudgetLog): Promise<"enforced" | "fallback"> {
  const b = backend();
  if (!b) return "fallback";
  try {
    return (await readiness(b)) === "ready" ? "enforced" : "fallback";
  } catch (err) {
    log.warn({ err }, "AI budget probe failed");
    return "enforced";
  }
}

/** Today's estimated company spend in USD, or null when it can't be read. */
export async function spendToday(): Promise<number | null> {
  const b = backend();
  if (!b) return null;
  try {
    if ((await readiness(b)) !== "ready") return null;
    return await withTimeout(b.total("company", "spend_usd", "day", dayOf(new Date())), CHECK_TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** Removes a deleted account's counters. Best effort: they hold only numbers keyed by the id. */
export async function forgetUser(userId: string): Promise<void> {
  const svc = serviceClient();
  if (!svc) return;
  const { error } = await svc.rpc("ai_budget_forget", { p_user: userId });
  if (error && !isSchemaMissing(error)) throw error;
}

/** Prompt tokens for a request: its JSON by length (base64 file data left out), plus each file's own estimate. */
export function estimatePromptTokens(p: { system?: unknown; tools?: unknown; messages: unknown }): number {
  const files: Anthropic.Messages.ContentBlockParam[] = [];
  const json = JSON.stringify({ system: p.system ?? null, tools: p.tools ?? null, messages: p.messages }, (_key, value: unknown) => {
    if (value && typeof value === "object" && "type" in value && (value.type === "document" || value.type === "image")) {
      files.push(value as Anthropic.Messages.ContentBlockParam);
      return { type: value.type };
    }
    return value;
  });
  return Math.ceil(json.length / 3) + fileTokens(files);
}

// ---- The ceiling email ----

async function sendCeilingEmail(a: CeilingAlert, log: BudgetLog): Promise<void> {
  const svc = serviceClient();
  let top: { subject: string; amount: number; role: string }[] = [];
  let modules: [string, number][] = [];
  if (svc) {
    const { data: rows } = await svc.rpc("ai_budget_top", { p_period_start: a.day, p_limit: 5 });
    const list = ((rows ?? []) as { subject: string; amount: number }[]).map((r) => ({ subject: r.subject, amount: Number(r.amount) }));
    const ids = list.map((r) => r.subject).filter((s) => s.startsWith("user:")).map((s) => s.slice(5));
    const { data: profiles } = ids.length ? await svc.from("profiles").select("id, role").in("id", ids) : { data: [] };
    const roleOf = new Map(((profiles ?? []) as { id: string; role: string | null }[]).map((p) => [p.id, p.role ?? "unknown"]));
    top = list.map((r) => ({ ...r, role: r.subject.startsWith("user:") ? roleOf.get(r.subject.slice(5)) ?? "unknown" : "system" }));
    // PostgREST answers at most 1,000 rows, so this counts today's latest 1,000 calls (and says so).
    const { data: runs } = await svc.from("ai_runs").select("module").gte("created_at", `${a.day}T00:00:00Z`).order("created_at", { ascending: false }).limit(1_000);
    const counts = new Map<string, number>();
    for (const r of (runs ?? []) as { module: string }[]) counts.set(r.module, (counts.get(r.module) ?? 0) + 1);
    modules = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);
  }
  const headline =
    a.pct === 100
      ? `AI is paused for the rest of ${a.day} (UTC): estimated spend reached the $${a.ceilingUsd} daily ceiling.`
      : `Estimated AI spend reached ${a.pct}% of the $${a.ceilingUsd} daily ceiling on ${a.day} (UTC).`;
  const lines = [
    headline,
    `Spend so far today: $${a.spendUsd.toFixed(2)}.`,
    "",
    "Top subjects by estimated spend (profile ids, no names):",
    ...(top.length ? top.map((t) => `- ${t.subject} (${t.role}): $${t.amount.toFixed(2)}`) : ["- none recorded"]),
    "",
    "Top modules among today's latest 1,000 calls:",
    ...(modules.length ? modules.map(([m, n]) => `- ${m}: ${n}`) : ["- none recorded"]),
  ];
  const sent = await sendEmail({
    to: env.COMPANY_CONTACT_EMAIL,
    recipient_kind: "counselor",
    logger: log,
    subject: a.pct === 100 ? `AI paused: daily ceiling reached (${a.day})` : `AI spend at ${a.pct}% of the daily ceiling (${a.day})`,
    text: lines.join("\n"),
    html: lines.map((l) => (l ? `<p style="margin:0 0 6px;">${escapeHtml(l)}</p>` : "<br>")).join(""),
    template: `ai-ceiling-${a.pct}`,
    idempotencyKey: `ai-ceiling:${a.day}:${a.pct}`,
  });
  if (!sent.sent) log.error({ pct: a.pct, err: sent.error }, "AI ceiling email not sent");
}
