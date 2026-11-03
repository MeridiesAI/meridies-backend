import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import {
  budgetMode,
  estimatePromptTokens,
  reserve,
  resetsIn,
  setAlertSender,
  setBudgetBackend,
  setProductionForTest,
  settle,
  spendToday,
  type BudgetBackend,
  type CeilingAlert,
  type ReserveLine,
  type ReserveResult,
  type SettleLine,
} from "../../src/lib/aiBudget.js";
import { HttpError } from "../../src/lib/errors.js";

const PRICES = [
  { model: "claude-haiku-5-5", input_usd: "0.1000", output_usd: "0.5000", read_mult: "0.1000", write_5m_mult: "1.2500", write_1h_mult: "2.0000", long_above: 100000, long_mult: "5.00", web_search_usd: "0.0100" },
  { model: "claude-opus-5-5", input_usd: 4, output_usd: 20, read_mult: 0.05, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 },
];
const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const EST = { model: "claude-haiku-5-5", maxOutputTokens: 8_000, promptTokens: 20_000 };
const DAILY = /^You've hit today's AI limit\. It resets (in \d+ hours?|in under an hour)\.$/;

class FakeBackend implements BudgetBackend {
  rows = new Map<string, number>();
  reserves: ReserveLine[][] = [];
  settles: SettleLine[][] = [];
  probeError: unknown = null;
  reserveError: unknown = null;
  settleError: unknown = null;
  pricesError: unknown = null;
  hang = false;
  priceReads = 0;
  key = (subject: string, metric: string, period: string, start: string) => `${subject}|${metric}|${period}|${start}`;
  set(subject: string, metric: string, period: string, start: string, amount: number) {
    this.rows.set(this.key(subject, metric, period, start), amount);
  }
  async probe() {
    if (this.probeError) throw this.probeError;
  }
  async prices() {
    this.priceReads++;
    if (this.pricesError) throw this.pricesError;
    return PRICES;
  }
  async reserve(lines: ReserveLine[]): Promise<ReserveResult> {
    if (this.hang) return new Promise(() => undefined);
    if (this.reserveError) throw this.reserveError;
    this.reserves.push(lines);
    for (const l of lines) {
      if ((this.rows.get(this.key(l.subject, l.metric, l.period, l.period_start)) ?? 0) + l.amount > l.limit) {
        return { ok: false, subject: l.subject, metric: l.metric, period: l.period };
      }
    }
    const totals: Record<string, number> = {};
    for (const l of lines) {
      const k = this.key(l.subject, l.metric, l.period, l.period_start);
      this.rows.set(k, (this.rows.get(k) ?? 0) + l.amount);
      totals[`${l.subject}|${l.metric}|${l.period}`] = this.rows.get(k)!;
    }
    return { ok: true, totals };
  }
  async settle(lines: SettleLine[]) {
    if (this.settleError) throw this.settleError;
    this.settles.push(lines);
    for (const l of lines) {
      const k = this.key(l.subject, l.metric, l.period, l.period_start);
      if (this.rows.has(k)) this.rows.set(k, Math.max(0, this.rows.get(k)! + l.delta));
    }
  }
  async total(subject: string, metric: string, period: string, start: string) {
    return this.rows.get(this.key(subject, metric, period, start)) ?? 0;
  }
}

function logger() {
  const warns: string[] = [];
  const errors: string[] = [];
  const pick = (a: unknown, b?: unknown) => String(typeof a === "string" ? a : b ?? "");
  const log = {
    warn: (a: unknown, b?: unknown) => warns.push(pick(a, b)),
    error: (a: unknown, b?: unknown) => errors.push(pick(a, b)),
    info: () => undefined,
    debug: () => undefined,
  } as unknown as FastifyBaseLogger;
  return { log, warns, errors };
}

function setup(at = "2026-11-02T15:00:00Z") {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(at).getTime() });
  const b = new FakeBackend();
  setBudgetBackend(b);
  const alerts: CeilingAlert[] = [];
  setAlertSender(async (a) => void alerts.push(a));
  return { b, alerts, ...logger() };
}
const flush = () => new Promise((r) => setImmediate(r));
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a refusal");
}

afterEach(() => {
  mock.timers.reset();
  setBudgetBackend(null);
  setAlertSender(null);
  setProductionForTest(null);
});

test("a user reservation is one call, max output, weighted input and spend twice", async () => {
  const { b, log } = setup();
  await reserve({ userId: U }, EST, log);
  const lines = b.reserves[0]!;
  const by = (subject: string, metric: string) => lines.find((l) => l.subject === subject && l.metric === metric)!;
  assert.equal(lines.length, 5);
  assert.deepEqual(by(`user:${U}`, "calls"), { subject: `user:${U}`, metric: "calls", period: "day", period_start: "2026-11-02", amount: 1, limit: 300 });
  assert.deepEqual(by(`user:${U}`, "output_tokens"), { subject: `user:${U}`, metric: "output_tokens", period: "month", period_start: "2026-11-01", amount: 8_000, limit: 5_000_000 });
  assert.deepEqual(by(`user:${U}`, "input_weighted"), { subject: `user:${U}`, metric: "input_weighted", period: "month", period_start: "2026-11-01", amount: 20_000, limit: 100_000_000 });
  // (20,000 x $0.10 + 8,000 x $0.50) / 1M = $0.006
  close(by(`user:${U}`, "spend_usd").amount, 0.006);
  assert.equal(by(`user:${U}`, "spend_usd").limit, 10);
  assert.equal(by(`user:${U}`, "spend_usd").period, "day");
  close(by("company", "spend_usd").amount, 0.006);
  assert.equal(by("company", "spend_usd").limit, 100);
});

test("a system reservation is its monthly calls and the company line", async () => {
  const { b, log } = setup();
  await reserve({ system: "events-discovery" }, { model: "claude-opus-5-5", maxOutputTokens: 1_000, promptTokens: 1_000 }, log);
  assert.deepEqual(b.reserves[0]!.map((l) => `${l.subject}|${l.metric}|${l.period}|${l.limit}`), ["system:events-discovery|calls|month|2000", "company|spend_usd|day|100"]);
});

test("over the daily calls cap: 429 with the daily message, nothing else counted", async () => {
  const { b, log } = setup();
  b.set(`user:${U}`, "calls", "day", "2026-11-02", 300);
  const err = await refusal(reserve({ userId: U }, EST, log));
  assert.equal(err.statusCode, 429);
  assert.match(err.message, DAILY);
  assert.equal(err.message, "You've hit today's AI limit. It resets in 9 hours.");
  assert.equal(b.rows.get(`company|spend_usd|day|2026-11-02`) ?? 0, 0, "nothing else counted");
});

test("over the user's daily spend cap: 429 with the daily message; another user still passes", async () => {
  const { b, log } = setup();
  b.set(`user:${U}`, "spend_usd", "day", "2026-11-02", 10);
  const err = await refusal(reserve({ userId: U }, EST, log));
  assert.equal(err.statusCode, 429);
  assert.match(err.message, DAILY);
  await reserve({ userId: V }, EST, log);
});

test("over a monthly cap: the monthly message", async () => {
  const { b, log } = setup();
  b.set(`user:${U}`, "output_tokens", "month", "2026-11-01", 4_999_000);
  const err = await refusal(reserve({ userId: U }, EST, log));
  assert.equal(err.message, "Monthly AI usage limit reached.");
  const sys = new FakeBackend();
  setBudgetBackend(sys);
  sys.set("system:events-discovery", "calls", "month", "2026-11-01", 2_000);
  const sysErr = await refusal(reserve({ system: "events-discovery" }, EST, log));
  assert.equal(sysErr.statusCode, 429);
  assert.equal(sysErr.message, "This month's system AI budget is used up.");
});

test("resetsIn gives the hours to midnight UTC", () => {
  assert.equal(resetsIn(new Date("2026-11-02T19:00:00Z")), "in 5 hours");
  assert.equal(resetsIn(new Date("2026-11-02T18:30:00Z")), "in 6 hours", "rounded up");
  assert.equal(resetsIn(new Date("2026-11-02T23:00:00Z")), "in 1 hour");
  assert.equal(resetsIn(new Date("2026-11-02T23:30:00Z")), "in under an hour");
});

test("over the company ceiling: 429 ai_paused and one paused email", async () => {
  const { b, log, alerts } = setup("2026-10-01T20:00:00Z");
  b.set("company", "spend_usd", "day", "2026-10-01", 100);
  for (const userId of [U, V]) {
    const err = await refusal(reserve({ userId }, EST, log));
    assert.equal(err.statusCode, 429);
    assert.equal(err.code, "ai_paused");
    assert.equal(err.message, "AI features are paused for today. They come back in 4 hours.");
  }
  await flush();
  assert.deepEqual(alerts.map((a) => a.pct), [100]);
});

test("once the migration is in, a backend error refuses with 503 ai_budget_unavailable", async () => {
  const { b, log, errors } = setup();
  b.reserveError = new Error("connection reset");
  const err = await refusal(reserve({ userId: U }, EST, log));
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "ai_budget_unavailable");
  assert.equal(err.message, "AI is unavailable right now. Try again in a few minutes.");
  assert.ok(errors.length >= 1, "logged at error level");

  const other = setup();
  other.b.probeError = { code: "XX000", message: "something else" };
  assert.equal((await refusal(reserve({ userId: U }, EST, other.log))).statusCode, 503, "a probe error that isn't a missing schema refuses");
});

test("once the migration is in, a check slower than 2 s refuses", async () => {
  const { b, log } = setup();
  await reserve({ userId: U }, EST, log); // ready, prices cached
  b.hang = true;
  const pending = refusal(reserve({ userId: U }, EST, log));
  await flush();
  mock.timers.tick(2_000);
  const err = await pending;
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "ai_budget_unavailable");
});

test("without the migration: counts as today and logs the fallback line once an hour", async () => {
  const { b, log, warns } = setup();
  b.probeError = { code: "PGRST202", message: "Could not find the function public.ai_budget_total" };
  const line = "AI budget fallback active: migration 20261104000002_ai_budget not applied, caps not enforced";
  const h1 = await reserve({ userId: U }, EST, log);
  await reserve({ userId: U }, EST, log);
  assert.equal(h1.mode, "fallback");
  assert.equal(warns.filter((w) => w === line).length, 1);
  mock.timers.tick(30 * 60_000);
  await reserve({ userId: U }, EST, log);
  assert.equal(warns.filter((w) => w === line).length, 1, "not again within the hour");
  mock.timers.tick(31 * 60_000);
  await reserve({ userId: U }, EST, log);
  assert.equal(warns.filter((w) => w === line).length, 2);
  assert.equal(b.reserves.length, 0, "the new functions aren't called");
  assert.equal(await budgetMode(log), "fallback");
});

test("in production with no service key every call is refused", async () => {
  const { log } = setup();
  setBudgetBackend(null); // the default backend: no service client in unit tests
  setProductionForTest(true);
  const err = await refusal(reserve({ userId: U }, EST, log));
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, "ai_budget_unavailable");
  setProductionForTest(false);
  const hold = await reserve({ userId: U }, EST, log);
  assert.equal(hold.mode, "memory", "development counts in process");
});

test("prices are read once per 10 minutes; a failed refresh keeps the last table", async () => {
  const { b, log, warns } = setup();
  await reserve({ userId: U }, EST, log);
  await reserve({ userId: U }, EST, log);
  assert.equal(b.priceReads, 1);
  mock.timers.tick(10 * 60_000 + 1);
  b.pricesError = new Error("timeout");
  await reserve({ userId: U }, EST, log);
  assert.equal(b.priceReads, 2);
  assert.ok(warns.length >= 1, "the failed refresh is logged");
  assert.equal(b.reserves.length, 3, "the call still went through on the last table");
});

test("no prices yet and the read fails: 503", async () => {
  const { b, log } = setup();
  b.pricesError = new Error("timeout");
  const err = await refusal(reserve({ userId: U }, EST, log));
  assert.equal(err.statusCode, 503);
  assert.equal(b.reserves.length, 0);
});

test("settle replaces the reservation with actual usage and keeps the call", async () => {
  const { b, log } = setup();
  const hold = await reserve({ userId: U }, EST, log);
  await settle(hold, { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, log);
  const lines = b.settles[0]!;
  const delta = (subject: string, metric: string) => lines.find((l) => l.subject === subject && l.metric === metric)?.delta;
  assert.equal(delta(`user:${U}`, "calls"), undefined, "the call stays counted");
  assert.equal(delta(`user:${U}`, "output_tokens"), -7_000);
  assert.equal(delta(`user:${U}`, "input_weighted"), -10_000);
  close(delta(`user:${U}`, "spend_usd")!, 0.0015 - 0.006);
  close(delta("company", "spend_usd")!, 0.0015 - 0.006);
  await settle(hold, { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, log);
  assert.equal(b.settles.length, 1, "a hold settles once");
});

test("settle(null) releases tokens and spend and keeps the call", async () => {
  const { b, log } = setup();
  const hold = await reserve({ userId: U }, EST, log);
  await settle(hold, null, log);
  const lines = b.settles[0]!;
  assert.deepEqual(lines.map((l) => l.metric).sort(), ["input_weighted", "output_tokens", "spend_usd", "spend_usd"]);
  assert.equal(lines.find((l) => l.metric === "output_tokens")!.delta, -8_000);
  assert.equal(b.rows.get(`user:${U}|calls|day|2026-11-02`), 1);
  close(b.rows.get("company|spend_usd|day|2026-11-02")!, 0);
});

test("settle after midnight adjusts the reserved day", async () => {
  const { b, log } = setup("2026-11-02T23:59:59Z");
  const hold = await reserve({ userId: U }, EST, log);
  mock.timers.tick(2_000);
  await settle(hold, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, log);
  const days = new Set(b.settles[0]!.filter((l) => l.period === "day").map((l) => l.period_start));
  assert.deepEqual([...days], ["2026-11-02"]);
});

test("settle never throws when the backend fails", async () => {
  const { b, log, warns } = setup();
  const hold = await reserve({ userId: U }, EST, log);
  b.settleError = new Error("gone");
  await settle(hold, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, log);
  assert.ok(warns.length >= 1);
});

test("crossing 50% and 80% sends each email once that day", async () => {
  const { b, log, alerts } = setup("2026-09-15T12:00:00Z");
  b.set("company", "spend_usd", "day", "2026-09-15", 49.999);
  await reserve({ userId: U }, EST, log);
  await reserve({ userId: U }, EST, log);
  await flush();
  assert.deepEqual(alerts.map((a) => a.pct), [50]);
  close(alerts[0]!.spendUsd, 50.005);
  assert.equal(alerts[0]!.ceilingUsd, 100);
  b.set("company", "spend_usd", "day", "2026-09-15", 79.999);
  await reserve({ userId: U }, EST, log);
  await reserve({ userId: U }, EST, log);
  await flush();
  assert.deepEqual(alerts.map((a) => a.pct), [50, 80]);
});

test("spendToday reads the company line; budgetMode says enforced", async () => {
  const { b, log } = setup();
  b.set("company", "spend_usd", "day", "2026-11-02", 12.5);
  assert.equal(await spendToday(), 12.5);
  assert.equal(await budgetMode(log), "enforced");
});

test("estimatePromptTokens counts text, PDFs and images", () => {
  const pdf = Buffer.from(`%PDF ${"<< /Type /Page >> ".repeat(3)}%%EOF`).toString("base64");
  const image = "A".repeat(30_000);
  const est = estimatePromptTokens({
    system: "s".repeat(300),
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
      { type: "text", text: "t".repeat(300) },
    ] }],
  });
  // 600 characters of text (about 200 tokens) and some JSON, plus 1,600 for the image and 7,500 for three pages;
  // the 30,000 characters of base64 are not counted as text.
  assert.ok(est >= 200 + 1_600 + 7_500, String(est));
  assert.ok(est < 200 + 1_600 + 7_500 + 200, String(est));
});
