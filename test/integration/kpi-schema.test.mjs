// Time-saved ledger: tables exist, carry the approval gate, and only the owner reads them.
import { check, sql, user, rest } from "./harness.mjs";

const TABLES = ["kpi_baselines", "kpi_task_sessions", "kpi_completions", "kpi_completion_sources", "kpi_months", "kpi_email_sends"];

for (const t of TABLES) {
  check(`${t} exists`, (await sql(`select to_regclass('public.${t}') is not null`)) === "t");
  check(`${t} has RLS`, (await sql(`select coalesce((select rowsecurity from pg_tables where schemaname='public' and tablename='${t}'), false)`)) === "t");
  check(`${t} has the approval gate`, (await sql(`select count(*) from pg_policies where schemaname='public' and tablename='${t}' and policyname='approval_gate'`)) === "1");
}
check("meetings.notes_sent_at exists", (await sql(`select count(*) from information_schema.columns where table_schema='public' and table_name='meetings' and column_name='notes_sent_at'`)) === "1");
check("kpi-monthly heartbeat row seeded", (await sql(`select count(*) from public.job_heartbeats where job='kpi-monthly'`)) === "1");

const a = await user("kpi-a");
const b = await user("kpi-b");
await sql(`insert into public.kpi_completions (counselor_id, task_type, dedupe_key, month, manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate)
           values ('${a.id}', 'family_report', 'x-${Date.now()}', date_trunc('month', now())::date, 60, true, 0, 10, 'signup', 50, 150, true)`);

const own = await rest(a.token, "GET", `/rest/v1/kpi_completions?counselor_id=eq.${a.id}&select=id`);
check("a consultant reads their own completions", own.status === 200 && own.body.length === 1, JSON.stringify(own.body));
const other = await rest(b.token, "GET", `/rest/v1/kpi_completions?counselor_id=eq.${a.id}&select=id`);
check("another consultant reads none of them", other.status === 200 && other.body.length === 0, JSON.stringify(other.body));

const ins = await rest(a.token, "POST", "/rest/v1/kpi_completions", { counselor_id: a.id, task_type: "meeting", dedupe_key: "forged", month: "2026-10-01", manual_minutes: 999, manual_is_estimate: false, measured_seconds: 0, meridies_minutes: 0, measure_method: "signup", saved_minutes: 999, hourly_rate: 150, rate_is_estimate: false });
check("a client cannot insert a completion", ins.status >= 400, `status ${ins.status}`);
const sess = await rest(a.token, "POST", "/rest/v1/kpi_task_sessions", { counselor_id: a.id, task_type: "meeting", subject_id: a.id, active_seconds: 99999, last_active_on: "2026-10-26" });
check("a client cannot insert a session", sess.status >= 400, `status ${sess.status}`);
const sessRead = await rest(a.token, "GET", `/rest/v1/kpi_task_sessions?select=*`);
check("a client reads no sessions", sessRead.status >= 400 || sessRead.body.length === 0, JSON.stringify(sessRead.body));
const base = await rest(a.token, "POST", "/rest/v1/kpi_baselines", { counselor_id: a.id, hourly_rate: 1 });
check("a client cannot write baselines directly", base.status >= 400, `status ${base.status}`);
