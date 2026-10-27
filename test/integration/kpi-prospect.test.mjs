// Time saved: anonymized averages for marketing. Nothing below 10 consultants from 5 firms;
// only figures consultants edited. Uses a far-past month so other suites' rows don't mix in.
import { check, sql, user, API, CRON_SECRET, CLIENT } from "./harness.mjs";

const FROM = "2001-01", TO = "2001-01";
const avg = () => fetch(`${API}/internal/kpi/prospect-averages?from=${FROM}&to=${TO}`, { headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } }).then(async (r) => ({ status: r.status, body: await r.json() }));
const firm = (owner) => sql(`with f as (insert into public.firms (name, owner_id) values ('P ${Date.now()}', '${owner.id}') returning id) select id from f`);
const ins = (u, firmId, saved, edited = true) =>
  sql(`insert into public.kpi_completions (counselor_id, firm_id, task_type, dedupe_key, month, manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate)
       values ('${u.id}', ${firmId ? `'${firmId}'` : "null"}, 'college_list', 'p-${Math.random()}', '2001-01-01', 240, ${!edited}, 1800, 30, 'active', ${saved}, 150, ${!edited})`);

const noAuth = await fetch(`${API}/internal/kpi/prospect-averages?from=${FROM}&to=${TO}`, { headers: CLIENT });
check("needs the cron secret", noAuth.status === 401, `status ${noAuth.status}`);

const people = [];
for (let i = 0; i < 10; i++) people.push(await user(`kpi-p${i}`));
const firms = [];
for (let i = 0; i < 5; i++) firms.push(await firm(people[i]));

// 9 consultants (5 firms) → nothing
for (let i = 0; i < 9; i++) await ins(people[i], firms[i % 5], 120);
let r = await avg();
check("9 consultants → nothing", r.status === 200 && r.body.available === false && r.body.byTask === undefined, JSON.stringify(r.body));

// 10 consultants, but all in 4 firms → nothing
await sql(`update public.kpi_completions set firm_id = '${firms[0]}' where month = '2001-01-01' and firm_id = '${firms[4]}'`);
await ins(people[9], firms[1], 120);
r = await avg();
check("10 consultants from 4 firms → nothing", r.body.available === false, JSON.stringify(r.body));

// 10 from 5 firms → figures
await sql(`update public.kpi_completions set firm_id = '${firms[4]}' where month = '2001-01-01' and counselor_id = '${people[9].id}'`);
r = await avg();
check("10 consultants from 5 firms → figures", r.body.available === true && r.body.consultants === 10 && r.body.firms === 5, JSON.stringify(r.body));
check("median per task", r.body.byTask?.college_list?.medianSavedMinutes === 120, JSON.stringify(r.body.byTask));
check("median hours per consultant-month", r.body.medianHoursPerMonth === 2, String(r.body.medianHoursPerMonth));

// Unedited rows are excluded
for (let i = 0; i < 10; i++) await ins(people[i], null, 9999, false);
r = await avg();
check("unedited figures are left out", r.body.byTask?.college_list?.medianSavedMinutes === 120 && r.body.medianHoursPerMonth === 2, JSON.stringify(r.body));
check("no ids or names in the answer", !people.some((p) => JSON.stringify(r.body).includes(p.id)) && !firms.some((f) => JSON.stringify(r.body).includes(f)));
const grant = await sql(`select count(*) from information_schema.routine_privileges where routine_name = 'kpi_prospect_averages' and grantee in ('anon','authenticated')`);
check("only the service role can call it", grant === "0");

// ---- Every figure meets the floor on its own -----------------------------------------
{
  // One consultant's edited rate, one consultant's meeting rows: neither may surface.
  await sql(`update public.kpi_completions set rate_is_estimate = true where month = '2001-01-01'`);
  await sql(`update public.kpi_completions set rate_is_estimate = false where month = '2001-01-01' and counselor_id = '${people[0].id}'`);
  await sql(`insert into public.kpi_completions (counselor_id, firm_id, task_type, dedupe_key, month, manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate)
             values ('${people[0].id}', '${firms[0]}', 'meeting', 'p-solo-meeting', '2001-01-01', 45, false, 600, 10, 'active', 35, 150, true)`);
  const r2 = await avg();
  check("a value from one consultant's rate is left out", r2.body.available === true && r2.body.medianValuePerMonth === null, JSON.stringify(r2.body));
  check("a task type only one consultant did is left out", r2.body.byTask?.meeting === undefined && r2.body.byTask?.college_list !== undefined, JSON.stringify(r2.body.byTask));
}
