// The federal figures on a college profile: GET /colleges/:id/extras `official`
// and GET /colleges/compare, against the Berkeley and AAMU rows the CI fixture
// load (scripts/ingest/scorecard.ts --fixture) writes. The extended columns are
// set on those rows here and put back after.
import { user, call, check, sql, API, CRON_SECRET } from "./harness.mjs";

const berkeley = await sql(`select id from colleges where unitid = 110635`);
const aamu = await sql(`select id from colleges where unitid = 100654`);
const yale = await sql(`select id from colleges where slug = 'yale'`);
check("the fixture load wrote both schools' stats", !!berkeley && !!aamu && (await sql(`select count(*) from college_stats where college_id in ('${berkeley}', '${aamu}')`)) === "2");

const original = await sql(`select source_verified_at from college_stats where college_id = '${berkeley}'`);
const extended = `
  completion_basis = 'four-year', grad_rate_on_time = 0.7612, grad_rate_150 = 0.9317,
  completion_by_race = '{"asian": 0.95, "white": 0.94, "black": 0.85}'::jsonb,
  retention_rate = 0.9672, part_time_share = 0.0251, student_faculty_ratio = 19, grad_students = 12847,
  demographics = '{"women": 0.55, "men": 0.45, "asian": 0.35, "white": 0.2}'::jsonb,
  room_board_on_campus = 21245, books_supplies = 1336, median_earnings_6yr = 71102,
  median_debt_monthly = 146, median_debt_noncompleters = 4500, carnegie_basic = 15`;
const empty = `
  completion_basis = null, grad_rate_on_time = null, grad_rate_150 = null, completion_by_race = '{}'::jsonb,
  retention_rate = null, part_time_share = null, student_faculty_ratio = null, grad_students = null,
  demographics = '{}'::jsonb, room_board_on_campus = null, books_supplies = null, median_earnings_6yr = null,
  median_debt_monthly = null, median_debt_noncompleters = null, carnegie_basic = null`;
await sql(`update college_stats set ${extended}, source_verified_at = now() where college_id = '${berkeley}'`);
// An associate's program for AAMU, so the two-year list has something to show.
await sql(`insert into college_fields_of_study (college_id, cip_code, title, credential_level, awards, source_verified_at)
           values ('${aamu}', '5201', 'Business, General', 2, 12, now()) on conflict do nothing`);

try {
  const c = await user("counselor-official");
  const s = await user("student-official", "student");
  const pending = await user("counselor-official-pending", "counselor", { approved: false });

  // ---- Profile extras -------------------------------------------------------------
  const ex = await call(c.token, "GET", `/colleges/${berkeley}/extras`);
  const o = ex.body?.official?.stats;
  check("extras serves the official block", ex.status === 200 && !!o, `status ${ex.status}`);
  check("the extended figures come through", o?.retentionRate === 0.9672 && o?.gradRate150 === 0.9317 && o?.gradRateOnTime === 0.7612 && o?.studentFacultyRatio === 19 && o?.gradStudents === 12847, JSON.stringify(o).slice(0, 200));
  check("money figures stay dollars", o?.roomBoardOnCampus === 21245 && o?.booksSupplies === 1336 && o?.medianEarnings6yr === 71102 && o?.medianDebtMonthly === 146 && o?.medianDebtNoncompleters === 4500);
  check("demographics and completion by group are shares, every key present", o?.demographics?.race?.asian === 0.35 && o?.demographics?.women === 0.55 && o?.demographics?.race?.hispanic === null && o?.completionByRace?.asian === 0.95 && Object.keys(o?.completionByRace ?? {}).length === 9);
  check("the completion basis decides the label", o?.completionBasis === "four-year" && o?.labels?.gradRate150 === "Graduated within 6 years");
  check("coded fields are labelled in the catalog's own words", o?.labels?.setting === "Small city" && o?.labels?.carnegieBasic === "Doctoral Universities: Very High Research Activity" && o?.labels?.predominantDegree === "Bachelor's", JSON.stringify(o?.labels));
  check("the consumer rate stays its own figure", o?.gradRate === 0.9428);
  check("fresh figures aren't stale", o?.stale === false && !!o?.verifiedAt);
  check("existing fields unchanged", o?.admitRate > 0 && o?.provenance === "sourced" && Array.isArray(ex.body.official.majors));

  await sql(`update college_stats set source_verified_at = '2024-01-01T00:00:00Z' where college_id = '${berkeley}'`);
  const old = await call(c.token, "GET", `/colleges/${berkeley}/extras`);
  check("figures verified over 13 months ago are flagged stale", old.body?.official?.stats?.stale === true && old.body.official.stats.verifiedAt.startsWith("2024-01-01"));

  const two = await call(c.token, "GET", `/colleges/${aamu}/extras`);
  const assoc = two.body?.official?.associateMajors ?? [];
  check("associate's programs are listed apart from bachelor's", assoc.length === 1 && assoc[0].credentialLevel === 2 && assoc[0].title === "Business, General" && two.body.official.majors.every((m) => m.credentialLevel === 3), JSON.stringify(assoc));
  check("a school whose extended columns are empty serves nulls, not zeros", two.body?.official?.stats?.retentionRate === null && two.body.official.stats.completionBasis === null && two.body.official.stats.labels.gradRate150 === null);

  const stu = await call(s.token, "GET", `/colleges/${berkeley}/extras`);
  check("a student reads the catalog's federal figures too", stu.status === 200 && stu.body?.official?.stats?.retentionRate === 0.9672, `status ${stu.status}`);

  const pend = await call(pending.token, "GET", `/colleges/${berkeley}/extras`);
  check("a pending counselor is refused", pend.status === 403 && pend.body?.code === "account_pending", `status ${pend.status}`);

  // ---- Compare --------------------------------------------------------------------
  const cmp = await call(c.token, "GET", `/colleges/compare?ids=${berkeley},${yale}`);
  const [b, y] = cmp.body ?? [];
  check("compare carries each school's official stats", cmp.status === 200 && b?.college?.id === berkeley && b?.official?.retentionRate === 0.9672 && b.official.stale === true, `status ${cmp.status}`);
  check("a school with no Scorecard row compares with official null", y?.college?.id === yale && y.official === null);
  const pcmp = await call(pending.token, "GET", `/colleges/compare?ids=${berkeley}`);
  check("compare refuses a pending counselor", pcmp.status === 403);

  // ---- A degraded Scorecard run shows in /internal/status --------------------------
  const before = await sql(`select coalesce(last_ok_at::text, ''), coalesce(last_error_at::text, ''), coalesce(last_error, '') from job_heartbeats where job = 'scorecard-ingest'`);
  try {
    await sql(`update job_heartbeats set last_ok_at = now() - interval '2 days', last_error_at = now(), last_error = 'Scorecard refused extended fields (carnegie); loaded without them' where job = 'scorecard-ingest'`);
    const st = await fetch(API + "/internal/status", { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    const sj = await st.json();
    const job = sj.jobs?.find((j) => j.job === "scorecard-ingest");
    // A fresh database has jobs that never ran, which read "overdue" first; either way it is not all-ok.
    check("a degraded monthly load is failing, not all-ok", st.status === 503 && sj.status !== "all-ok" && sj.failing.includes("scorecard-ingest") && job?.failing === true && job?.overdue === false, JSON.stringify(sj).slice(0, 300));
    check("status never carries the error text", !JSON.stringify(sj).includes("refused"));
  } finally {
    const [ok, err, msg] = before.split("|");
    const lit = (v) => (v ? `'${v.replace(/'/g, "''")}'` : "null");
    await sql(`update job_heartbeats set last_ok_at = ${lit(ok)}, last_error_at = ${lit(err)}, last_error = ${lit(msg)} where job = 'scorecard-ingest'`);
  }
} finally {
  await sql(`update college_stats set ${empty}, source_verified_at = '${original}' where college_id = '${berkeley}'`);
  await sql(`delete from college_fields_of_study where college_id = '${aamu}' and cip_code = '5201' and credential_level = 2`);
}
