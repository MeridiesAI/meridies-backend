// Time saved: firm totals for owners/admins, only with 3+ active consultants, never per person.
import { check, call, sql, user } from "./harness.mjs";
import { firmWith } from "./imports-helpers.mjs";

const ins = (who, firm, key, saved, rate, month = "2026-09-01") =>
  sql(`insert into public.kpi_completions (counselor_id, firm_id, task_type, dedupe_key, month, manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate)
       values ('${who.id}', '${firm}', 'family_report', '${key}', '${month}', 60, false, 600, 10, 'active', ${saved}, ${rate}, false)`);

// ---- Two consultants: nothing ----------------------------------------------------------
const o2 = await user("kpi-firm2-owner");
const m2 = await user("kpi-firm2-member");
const f2 = await firmWith(o2, [m2]);
await ins(o2, f2, "a", 60, 100);
await ins(m2, f2, "b", 120, 200);
const r2 = await call(o2.token, "GET", "/kpi/firm?month=2026-09");
check("a 2-consultant firm's admin gets no firm totals", r2.status === 200 && r2.body.available === false && r2.body.reason === undefined && r2.body.hoursSaved === undefined, JSON.stringify(r2.body));

// ---- Three consultants: totals, no per-person fields -----------------------------------
const o3 = await user("kpi-firm3-owner");
const a3 = await user("kpi-firm3-admin");
const m3 = await user("kpi-firm3-member");
const left = await user("kpi-firm3-left");
const f3 = await firmWith(o3, [a3, m3, left]);
await sql(`update public.firm_members set seat_role = 'admin' where firm_id = '${f3}' and profile_id = '${a3.id}'`);
await ins(o3, f3, "c", 60, 100);
await ins(a3, f3, "d", 60, 100);
await ins(left, f3, "e", 120, 200);
// The consultant leaves the firm mid-month; their completion keeps its snapshotted firm.
await sql(`delete from public.firm_members where profile_id = '${left.id}'; update public.profiles set firm_id = null where id = '${left.id}'`);
const r3 = await call(o3.token, "GET", "/kpi/firm?month=2026-09");
check("3 consultants → totals", r3.status === 200 && r3.body.available === true && r3.body.hoursSaved === 4 && r3.body.valueOfTime === 600, JSON.stringify(r3.body));
check("a consultant who left mid-month still counts that month", r3.body.completions === 3, JSON.stringify(r3.body));
check("no per-person keys", !JSON.stringify(r3.body).match(/counselor|consultant_id|rate|o3|"by/i) && !JSON.stringify(r3.body).includes(o3.id), JSON.stringify(r3.body));
const ra = await call(a3.token, "GET", "/kpi/firm?month=2026-09");
check("an admin seat sees them too", ra.status === 200 && ra.body.available === true);
const rm = await call(m3.token, "GET", "/kpi/firm?month=2026-09");
check("a plain member gets 403", rm.status === 403, `status ${rm.status}`);
const solo = await user("kpi-firm-solo");
const rs = await call(solo.token, "GET", "/kpi/firm?month=2026-09");
check("a solo consultant has no firm view", rs.status === 404 || rs.status === 403, `status ${rs.status}`);
const direct = await sql(`select count(*) from information_schema.routine_privileges where routine_name = 'kpi_firm_month' and grantee = 'anon'`);
check("anon can't call the firm function", direct === "0");

// ---- The current month is never shown (deltas between polls would reveal one person's rate) ----
{
  const cur = await sql(`select to_char(date_trunc('month', now()), 'YYYY-MM-DD')`);
  for (const [u, k] of [[o3, "cur1"], [a3, "cur2"], [m3, "cur3"]]) await ins(u, f3, k, 60, 100, cur);
  const now = await call(o3.token, "GET", `/kpi/firm?month=${cur.slice(0, 7)}`);
  check("the current month's firm totals are withheld", now.status === 200 && now.body.available === false && now.body.reason === "month-open", JSON.stringify(now.body));
  const dflt = await call(o3.token, "GET", "/kpi/firm");
  const last = await sql(`select to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM')`);
  check("with no month the route reads last month", dflt.body.month === last, JSON.stringify(dflt.body));
}
