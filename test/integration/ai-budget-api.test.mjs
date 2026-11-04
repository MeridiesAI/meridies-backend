// The AI budget gate through the API (20261108000002, AxIS security PR A2). Needs the API as ci.yml starts it: no
// ANTHROPIC_API_KEY (so a call reserves, then stops before the model) and DEV_MAIL_URL at the local Mailpit. The
// ceiling emails go once per day per API process: run it against a freshly started API.
import { randomUUID } from "node:crypto";
import { API, CLIENT, CRON_SECRET, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const today = new Date().toISOString().slice(0, 10);
const notes = "Met with Maya about her fall plan. She will retake the SAT in October and finish the activities list.";
const DAILY = /^You've hit today's AI limit\. It resets (in \d+ hours?|in under an hour)\.$/;
const text = (r) => String(r.body?.message ?? r.body?.error ?? "");

const seed = (subject, metric, period, amount) =>
  sql(`insert into private.ai_budget (subject, metric, period, period_start, amount)
       values ('${subject}', '${metric}', '${period}', '${period === "month" ? `${today.slice(0, 7)}-01` : today}', ${amount})
       on conflict (subject, metric, period, period_start) do update set amount = excluded.amount`);
const companyNow = async () =>
  Number(await sql(`select coalesce((select amount from private.ai_budget where subject = 'company' and metric = 'spend_usd' and period = 'day' and period_start = '${today}'), 0)`));
const counselor = async (tag) => {
  const c = await user(tag);
  return { c, s: await studentOf(c, `${tag}-s`) };
};
const summary = (who) => call(who.c.token, "POST", "/ai/meeting-summary", { studentId: who.s.id, rawNotes: notes });
const mails = async (subject) => {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`);
  return (await r.json()).messages ?? [];
};
const forgetMails = (subject) => fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`, { method: "DELETE" });
const settleMail = () => new Promise((r) => setTimeout(r, 1500));

// The daily call cap, with the daily message and its reset in hours.
{
  const a = await counselor("budget-calls");
  await seed(`user:${a.c.id}`, "calls", "day", 300);
  const r = await summary(a);
  check("a counselor at the daily call cap gets the daily message", r.status === 429 && DAILY.test(text(r)), `${r.status} ${text(r)}`);
}

// One account's daily spend cap doesn't stop anyone else.
{
  const a = await counselor("budget-spend-a");
  const b = await counselor("budget-spend-b");
  await seed(`user:${a.c.id}`, "spend_usd", "day", 10);
  const ra = await summary(a);
  const rb = await summary(b);
  check("a counselor at the daily spend cap is refused", ra.status === 429 && DAILY.test(text(ra)), `${ra.status} ${text(ra)}`);
  check("another counselor isn't", rb.status !== 429, `${rb.status} ${text(rb)}`);
}

// Fail closed: once the migration is in, a check that errors refuses the call.
{
  const a = await counselor("budget-broken");
  await sql("revoke execute on function public.ai_budget_reserve(jsonb) from service_role");
  try {
    const r = await summary(a);
    check("a budget check that errors refuses once the migration is in", r.status === 503 && r.body?.code === "ai_budget_unavailable", `${r.status} ${JSON.stringify(r.body)}`);
  } finally {
    await sql("grant execute on function public.ai_budget_reserve(jsonb) to service_role");
  }
}

// The company ceiling pauses AI and tells the team once. Held at the ceiling for one request only.
{
  const a = await counselor("budget-paused");
  const subject = `AI paused: daily ceiling reached (${today})`;
  await forgetMails(subject);
  await sql(`delete from private.rate_limit_buckets where key like 'ai-ceiling:${today}:%'`);
  const before = await companyNow();
  let r;
  try {
    await seed("company", "spend_usd", "day", 100);
    r = await summary(a);
  } finally {
    await seed("company", "spend_usd", "day", before);
  }
  check("at the company ceiling AI pauses", r.status === 429 && r.body?.code === "ai_paused" && /^AI features are paused for today\. They come back in/.test(text(r)), `${r.status} ${JSON.stringify(r.body)}`);
  await settleMail();
  const sent = await mails(subject);
  check("and the team gets one email", sent.length === 1, `${sent.length} emails`);
}

// Crossing 50% sends the 50% email once.
{
  const a = await counselor("budget-half");
  const subject = `AI spend at 50% of the daily ceiling (${today})`;
  await forgetMails(subject);
  const before = await companyNow();
  try {
    await seed("company", "spend_usd", "day", 49.999);
    await summary(a);
    await summary(a);
  } finally {
    await seed("company", "spend_usd", "day", before);
  }
  await settleMail();
  const sent = await mails(subject);
  check("crossing 50% sends the 50% email once", sent.length === 1, `${sent.length} emails`);
  const body = sent[0] ? await (await fetch(`${MAILPIT}/api/v1/message/${sent[0].ID}`)).json() : null;
  check("the email names no one", body !== null && !/budget-half|Maya/.test(`${body.Text}${body.HTML}`) && /user:[0-9a-f-]{36}/.test(body.Text ?? ""), (body?.Text ?? "").slice(0, 200));
}

// /internal/status shows the budget.
{
  const r = await fetch(`${API}/internal/status`, { headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
  const body = await r.json();
  check("/internal/status shows the budget mode", body.aiBudget?.mode === "enforced" && body.aiBudget?.ceilingUsd === 100 && typeof body.aiBudget?.spendTodayUsd === "number", JSON.stringify(body.aiBudget));
}

// Deleting an account removes its budget rows.
{
  const gone = await user("budget-gone");
  await seed(`user:${gone.id}`, "calls", "day", 3);
  await seed(`user:${gone.id}`, "output_tokens", "month", 1000);
  const del = await call(gone.token, "DELETE", "/account", { confirm: "delete my account" });
  const left = await sql(`select count(*) from private.ai_budget where subject = 'user:${gone.id}'`);
  check("deleting an account removes its budget rows", del.status === 204 && left === "0", `status ${del.status}, ${left} rows left`);
}

// The AI hand-in check has its own per-minute limit.
{
  const c = await user("budget-handin");
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    statuses.push((await call(c.token, "POST", `/tasks/${randomUUID()}/submissions`, { documentId: randomUUID() })).status);
  }
  check("the 21st hand-in in a minute is refused", statuses.slice(0, 20).every((s) => s !== 429) && statuses[20] === 429, statuses.join(","));
}
