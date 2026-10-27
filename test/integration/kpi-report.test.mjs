// Time saved: GET /kpi/report serves the caller's own month only.
import { check, call, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("kpi-rep");
const other = await user("kpi-rep-other");
const s = await studentOf(c, "kpi-rep-student");
await sql(`update public.profiles set full_name = 'Ava Report' where id = '${s.id}'`);
const ins = (who, student, key, saved, month = "2026-10-01") =>
  sql(`insert into public.kpi_completions (counselor_id, student_id, task_type, dedupe_key, month, manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate)
       values ('${who.id}', ${student ? `'${student.id}'` : "null"}, 'family_report', '${key}', '${month}', 60, false, 600, 10, 'active', ${saved}, 120, false)`);
await ins(c, s, "r1", 50);
await ins(c, s, "r2", 70);
await ins(c, s, "r-sept", 600, "2026-09-01");
await ins(other, null, "x1", 999);

await call(c.token, "PUT", "/kpi/baselines", { hoursPerStudentYear: 5, hoursEdited: true });
const r = await call(c.token, "GET", "/kpi/report?month=2026-10");
check("report serves the month", r.status === 200 && r.body.month === "2026-10" && r.body.hoursSaved === 2, JSON.stringify(r.body).slice(0, 300));
check("only the caller's rows", r.body.byTask?.[0]?.completions === 2);
check("names the caller's own students", r.body.byTask?.[0]?.lines?.[0]?.studentName === "Ava Report");
check("value uses the snapshotted rate", r.body.valueOfTime === 240, String(r.body.valueOfTime));
check("extra students read the last 12 months (12 h ÷ 5 h)", r.body.extraStudents?.upTo === 2 && r.body.extraStudents?.basedOnMonths === 2, JSON.stringify(r.body.extraStudents));
const e = await call(c.token, "GET", "/kpi/report?month=2026-01");
check("an empty month says so", e.status === 200 && e.body.empty === true);
const bad = await call(c.token, "GET", "/kpi/report?month=Oct");
check("a bad month is a 400", bad.status === 400, `status ${bad.status}`);
const d = await call(c.token, "GET", "/kpi/report");
check("no month → the current one", d.status === 200 && /^\d{4}-\d{2}$/.test(d.body.month), JSON.stringify(d.body).slice(0, 120));
