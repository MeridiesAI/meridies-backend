// The AI budget's counters and prices (20261108000002, AxIS security PR A2): reserve before a call, settle
// after, refuse at a cap. Service role only. Runs against the database; the API isn't needed.
import { randomUUID } from "node:crypto";
import { check, rest, serviceRpc, sql, user } from "./harness.mjs";

const today = new Date().toISOString().slice(0, 10);
const month = `${today.slice(0, 7)}-01`;
const line = (subject, metric, period, amount, limit) => ({ subject, metric, period, period_start: period === "month" ? month : today, amount, limit });
const reserve = (lines) => serviceRpc("ai_budget_reserve", { p_lines: lines });
const settle = (lines) => serviceRpc("ai_budget_settle", { p_lines: lines });
const total = async (subject, metric, period) =>
  Number((await serviceRpc("ai_budget_total", { p_subject: subject, p_metric: metric, p_period: period, p_period_start: period === "month" ? month : today })).body);
const u = () => `user:${randomUUID()}`;

// Every line fits: all are added, and the new totals come back.
{
  const a = u();
  const before = await total("company", "spend_usd", "day");
  const r = await reserve([line(a, "calls", "day", 1, 300), line(a, "spend_usd", "day", 0.5, 10), line("company", "spend_usd", "day", 0.5, 1e9)]);
  check("reserve adds every line when all fit", r.status === 200 && r.body?.ok === true, JSON.stringify(r.body));
  check("and returns the new totals", Math.abs(r.body?.totals?.["company|spend_usd|day"] - (before + 0.5)) < 1e-9 && r.body?.totals?.[`${a}|calls|day`] === 1, JSON.stringify(r.body?.totals));
  await settle([{ subject: "company", metric: "spend_usd", period: "day", period_start: today, delta: -0.5 }]);
}

// One line over its cap: nothing changes, and the refusal names that line.
{
  const b = u();
  await reserve([line(b, "calls", "day", 1, 1)]);
  const r = await reserve([line(b, "output_tokens", "month", 500, 1e9), line(b, "calls", "day", 1, 1)]);
  check("reserve over one cap changes nothing and names it", r.body?.ok === false && r.body?.subject === b && r.body?.metric === "calls" && r.body?.period === "day", JSON.stringify(r.body));
  check("the calls total is still 1", (await total(b, "calls", "day")) === 1);
  check("the line that fit wasn't added either", (await total(b, "output_tokens", "month")) === 0);
}

// Two replicas at the edge of a cap (Review Focus 3).
{
  const c = u();
  const results = await Promise.all(Array.from({ length: 20 }, () => reserve([line(c, "calls", "day", 1, 10)])));
  const passed = results.filter((r) => r.body?.ok === true).length;
  check("parallel reserves never pass the cap", passed === 10, `${passed} passed`);
  check("and the total is the cap", (await total(c, "calls", "day")) === 10);
}

// A user's own daily spend cap doesn't stop anyone else.
{
  const a = u();
  const b = u();
  await reserve([line(a, "spend_usd", "day", 10, 10)]);
  const ra = await reserve([line(a, "spend_usd", "day", 0.01, 10), line("company", "spend_usd", "day", 0.01, 1e9)]);
  const rb = await reserve([line(b, "spend_usd", "day", 0.01, 10), line("company", "spend_usd", "day", 0.01, 1e9)]);
  check("a user at their daily spend cap is refused", ra.body?.ok === false && ra.body?.metric === "spend_usd" && ra.body?.subject === a, JSON.stringify(ra.body));
  check("while another user proceeds", rb.body?.ok === true, JSON.stringify(rb.body));
  await settle([{ subject: "company", metric: "spend_usd", period: "day", period_start: today, delta: -0.01 }]);
}

// Settle moves a total by a delta and never below zero; a missing row is skipped.
{
  const d = u();
  await reserve([line(d, "output_tokens", "month", 100, 1e9)]);
  const s = await settle([{ subject: d, metric: "output_tokens", period: "month", period_start: month, delta: -150 }, { subject: u(), metric: "calls", period: "day", period_start: today, delta: 5 }]);
  check("settle applies a delta and floors at zero", s.status === 204 || s.status === 200, `status ${s.status} ${JSON.stringify(s.body)}`);
  check("the total is 0", (await total(d, "output_tokens", "month")) === 0);
}

// Malformed lines are refused by the database.
{
  const bad = await reserve([line("admin", "calls", "day", 1, 10)]);
  check("a subject that isn't a user, the company or a system budget is refused", bad.status >= 400, `status ${bad.status}`);
  const neg = await reserve([line(u(), "calls", "day", -5, 10)]);
  check("a negative reservation is refused", neg.status >= 400, `status ${neg.status}`);
  const mid = await reserve([{ ...line(u(), "output_tokens", "month", 1, 10), period_start: today === month ? `${today.slice(0, 7)}-02` : today }]);
  check("a month period must start on the 1st", mid.status >= 400, `status ${mid.status}`);
}

// Only the service role reaches any of it.
{
  const me = await user("ai-budget");
  const lines = [line(`user:${me.id}`, "calls", "day", -1000, 1e9)];
  const calls = [
    ["ai_budget_reserve", { p_lines: lines }],
    ["ai_budget_settle", { p_lines: [{ subject: `user:${me.id}`, metric: "calls", period: "day", period_start: today, delta: -1000 }] }],
    ["ai_budget_total", { p_subject: "company", p_metric: "spend_usd", p_period: "day", p_period_start: today }],
    ["ai_budget_prices", {}],
    ["ai_budget_forget", { p_user: me.id }],
    ["ai_budget_top", { p_period_start: today }],
  ];
  for (const [fn, args] of calls) {
    const r = await rest(me.token, "POST", `/rest/v1/rpc/${fn}`, args);
    check(`a signed-in user can't call ${fn}`, r.status === 401 || r.status === 403 || r.status === 404, `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  const anon = await rest("", "POST", "/rest/v1/rpc/ai_budget_prices", {});
  check("nor can an anonymous caller read the prices", anon.status === 401 || anon.status === 403 || anon.status === 404, `status ${anon.status}`);
}

// Prices: one table the code and the reports read.
{
  const r = await serviceRpc("ai_budget_prices", {});
  const rows = Array.isArray(r.body) ? r.body : [];
  const models = new Set(rows.map((p) => p.model));
  const used = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"];
  check("every model the code uses has a price row", used.every((m) => models.has(m)), [...models].join(","));
  const h = rows.find((p) => p.model === "claude-haiku-5-5");
  check("Haiku 5.5 is $0.10 / $0.50, reads at 0.1, 5x above 100K tokens",
    Number(h?.input_usd) === 0.1 && Number(h?.output_usd) === 0.5 && Number(h?.read_mult) === 0.1 && h?.long_above === 100000 && Number(h?.long_mult) === 5, JSON.stringify(h));
  const f = rows.find((p) => p.model === "claude-fable-5-1");
  check("Fable 5.1 is $10 / $50 with reads at 0.025 and no long tier", Number(f?.input_usd) === 10 && Number(f?.read_mult) === 0.025 && f?.long_above === null, JSON.stringify(f));
  check("the table is seeded with the plan's 14 models", rows.length === 14, String(rows.length));
  const free = await sql(`insert into private.ai_prices (model, input_usd, output_usd, read_mult, write_5m_mult) values ('claude-test-free', 1, 1, 0.1, 0)`).then(() => "inserted", () => "refused");
  check("a price row with a free cache write is refused", free === "refused", free);
}

// Forget removes only that user's rows; top lists today's biggest spenders, not the company.
{
  const e = u();
  const f = u();
  await reserve([line(e, "calls", "day", 1, 10), line(e, "spend_usd", "day", 9.5, 10)]);
  await reserve([line(f, "calls", "day", 1, 10)]);
  const top = await serviceRpc("ai_budget_top", { p_period_start: today, p_limit: 50 });
  check("top lists today's biggest spenders without the company", Array.isArray(top.body) && top.body.some((r) => r.subject === e) && !top.body.some((r) => r.subject === "company"), JSON.stringify(top.body).slice(0, 200));
  const forgot = await serviceRpc("ai_budget_forget", { p_user: e.slice(5) });
  check("forget runs", forgot.status === 204 || forgot.status === 200, `status ${forgot.status}`);
  const left = await sql(`select count(*) filter (where subject = '${e}') || '|' || count(*) filter (where subject = '${f}') from private.ai_budget`);
  check("forget removes only that user's rows", left === "0|1", left);
}
