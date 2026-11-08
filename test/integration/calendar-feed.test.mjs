// The Calendar feed's college dates and test dates (GET /calendar/feed,
// src/lib/calendarFeed.ts): the counselor's internal deadline ("Your deadline",
// student_colleges.custom_deadline) as its own `college-custom:` item, and a
// student's planned SAT/ACT date as a `test:` milestone of pseudo-type `test`,
// skipped once taken or for a test-optional student. Shown on the counselor's
// calendar (whole, and scoped to the student) and on the student's own; never on
// another practice's.
import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const day = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const tag = `calfeed-${Date.now().toString(36)}`;

const a = await user(`${tag}-a`);
const b = await user(`${tag}-b`);
const s1 = await studentOf(a, `${tag}-s1`);
const s2 = await studentOf(a, `${tag}-s2`);
const s3 = await studentOf(a, `${tag}-s3`);
const other = await studentOf(b, `${tag}-other`);

const school = `Calfeed U ${tag}`;
const sc = await sql(`with c as (insert into public.student_colleges (student_id, name, round, deadline, custom_deadline, status)
  values ('${s1.id}', '${school}', 'EA', '${day(20)}', '${day(10)}', 'in-progress') returning id) select id from c`);
// Only the custom date inside the window; and a decided school with a custom date (never shown).
const onlyCustom = await sql(`with c as (insert into public.student_colleges (student_id, name, deadline, custom_deadline, status)
  values ('${s2.id}', 'Only Custom ${tag}', '${day(200)}', '${day(12)}', 'not-started') returning id) select id from c`);
const decided = await sql(`with c as (insert into public.student_colleges (student_id, name, deadline, custom_deadline, status)
  values ('${s2.id}', 'Decided ${tag}', '${day(15)}', '${day(9)}', 'accepted') returning id) select id from c`);
// Another practice's student with both dates.
const foreign = await sql(`with c as (insert into public.student_colleges (student_id, name, deadline, custom_deadline, status)
  values ('${other.id}', 'Foreign ${tag}', '${day(14)}', '${day(8)}', 'in-progress') returning id) select id from c`);

await sql(`insert into public.student_academics (student_id, planned_test_date, test_status) values
  ('${s1.id}', '${day(7)}', 'scheduled'),
  ('${s2.id}', '${day(7)}', 'taken'),
  ('${s3.id}', '${day(7)}', 'test-optional'),
  ('${other.id}', '${day(7)}', 'scheduled')`);

const window = `from=${day(-1)}&to=${day(30)}&tz=UTC`;
const ids = (r) => new Set((r.body?.items ?? []).map((i) => i.id));
const item = (r, id) => (r.body?.items ?? []).find((i) => i.id === id);

const whole = await call(a.token, "GET", `/calendar/feed?${window}`);
check("the counselor's feed answers 200", whole.status === 200, String(whole.status));
const w = ids(whole);
check("the school's deadline is still on it", w.has(`college:${sc}`));
check("the counselor's own date is a second item", w.has(`college-custom:${sc}`));
const custom = item(whole, `college-custom:${sc}`);
check(
  "…titled '<School>: your deadline', kind deadline, on its own date, naming the school's",
  custom?.title === `${school}: your deadline` && custom?.kind === "deadline" && custom?.type === "deadline" &&
    custom?.date === day(10) && custom?.allDay === true && custom?.studentId === s1.id && custom?.school === school &&
    /^The school's deadline is /.test(custom?.detail ?? ""),
  JSON.stringify(custom)
);
check("a row whose school date is outside the window still shows its custom date", w.has(`college-custom:${onlyCustom}`) && !w.has(`college:${onlyCustom}`));
check("a decided school shows neither date", !w.has(`college:${decided}`) && !w.has(`college-custom:${decided}`));
check("another practice's college dates are not on it", !w.has(`college:${foreign}`) && !w.has(`college-custom:${foreign}`));

const test1 = item(whole, `test:${s1.id}`);
check(
  "a planned test date is a `test:` milestone of type test",
  test1?.kind === "milestone" && test1?.type === "test" && test1?.date === day(7) && test1?.studentId === s1.id &&
    test1?.title === "Planned test date" && test1?.allDay === true,
  JSON.stringify(test1)
);
check("a test already taken is skipped", !w.has(`test:${s2.id}`));
check("a test-optional student's date is skipped", !w.has(`test:${s3.id}`));
check("another practice's student's test date is not on it", !w.has(`test:${other.id}`));

const scoped = await call(a.token, "GET", `/calendar/feed?${window}&studentId=${s1.id}`);
const sw = ids(scoped);
check("scoped to the student: both college dates and the test date", sw.has(`college:${sc}`) && sw.has(`college-custom:${sc}`) && sw.has(`test:${s1.id}`));
check("scoped to the student: nobody else's", !sw.has(`college-custom:${onlyCustom}`));

const mine = await call(s1.token, "GET", `/calendar/feed?${window}`);
const mw = ids(mine);
check("the student's own feed shows their custom deadline and test date", mine.status === 200 && mw.has(`college-custom:${sc}`) && mw.has(`test:${s1.id}`), String(mine.status));
check("…and nobody else's", !mw.has(`college-custom:${onlyCustom}`) && !mw.has(`test:${other.id}`));

const outsider = await call(b.token, "GET", `/calendar/feed?${window}`);
const ow = ids(outsider);
check("the other practice sees its own, never ours", ow.has(`college-custom:${foreign}`) && ow.has(`test:${other.id}`) && !ow.has(`college-custom:${sc}`) && !ow.has(`test:${s1.id}`));

// Clean up this suite's accounts (the stack is shared); student rows cascade with their profiles.
await sql(`delete from auth.users where email like '${tag}-%@test.local'`);
