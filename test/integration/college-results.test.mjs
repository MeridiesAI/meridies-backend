// College results and scholarship tracking: a student records a decision and
// their counselor is told; one final choice (enrolled) at a time; the decision
// date; scholarship create/patch with the amount won, requirements and a
// not-awarded outcome; "applying to N"; and the Overview summaries that roll
// it all up. Real accounts on a local Supabase against a running API (see
// harness.mjs). Needs migration 20261028000001.
import { user, call, check, sql } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

const c = await user("counselor-res");
const pending = await user("counselor-res-pending", "counselor", { approved: false });
const other = await user("counselor-res-other");
const s = await studentOf(c, "student-res");
const s2 = await studentOf(c, "student-res-2");
const outsider = await user("student-res-outsider", "student");

const school = async (student, name, status = "submitted") =>
  sql(`with r as (insert into public.student_colleges (student_id, name, status) values ('${student.id}', '${name}', '${status}') returning id) select id from r`);
const mit = await school(s, "MIT");
const mich = await school(s, "Michigan");
const bu = await school(s, "Boston University");

const notifications = (studentId) =>
  sql(`select count(*) from public.notifications where student_id = '${studentId}' and kind = 'college-result'`).then(Number);

// ---- results ---------------------------------------------------------------

let r = await call(s.token, "PATCH", `/application/college-list/${mich}`, { status: "accepted", decisionDate: "2026-12-15" });
check("student records an acceptance with its date", r.status === 200 && r.body.status === "accepted" && r.body.decisionDate === "2026-12-15", JSON.stringify(r.body).slice(0, 200));
check("their counselor is told once", (await notifications(s.id)) === 1);

r = await call(s.token, "PATCH", `/application/college-list/${mit}`, { status: "enrolled" });
check("a school that hasn't accepted can't be the final choice", r.status === 409, `status ${r.status}`);

await call(s.token, "PATCH", `/application/college-list/${mit}`, { status: "accepted" });
r = await call(s.token, "PATCH", `/application/college-list/${mit}`, { status: "enrolled" });
check("an accepted school becomes the final choice", r.status === 200 && r.body.status === "enrolled");
r = await call(s.token, "PATCH", `/application/college-list/${mich}`, { status: "enrolled" });
check("picking another final choice works", r.status === 200 && r.body.status === "enrolled");
const enrolled = await sql(`select string_agg(name, ',') from public.student_colleges where student_id = '${s.id}' and status = 'enrolled'`);
check("only one is enrolled; the other drops back to accepted", enrolled === "Michigan", enrolled);
check("the earlier one is accepted again", (await sql(`select status from public.student_colleges where id = '${mit}'`)) === "accepted");
check("the date is stamped when none is given", Boolean(await sql(`select decision_date from public.student_colleges where id = '${mit}'`)));

const before = await notifications(s.id);
r = await call(c.token, "PATCH", `/application/college-list/${bu}`, { status: "denied" });
check("the counselor can edit a result too", r.status === 200 && r.body.status === "denied", `status ${r.status}`);
check("…and a counselor's change tells nobody", (await notifications(s.id)) === before);

r = await call(other.token, "PATCH", `/application/college-list/${bu}`, { status: "accepted" });
check("another counselor can't change it", r.status === 404 || r.status === 403, `status ${r.status}`);
r = await call(outsider.token, "PATCH", `/application/college-list/${bu}`, { status: "accepted" });
check("another student can't change it", r.status === 404 || r.status === 403, `status ${r.status}`);

// A pending counselor's student: no notification until the counselor is approved.
const ps = await studentOf(pending, "student-res-pending");
const pm = await school(ps, "Yale");
await call(ps.token, "PATCH", `/application/college-list/${pm}`, { status: "accepted" });
check("an unapproved counselor isn't notified", (await notifications(ps.id)) === 0);

// ---- "applying to N" -------------------------------------------------------

r = await call(s.token, "PATCH", "/me/overview", { collegesPlanned: 9 });
check("the student sets how many colleges they are applying to", r.status === 200 && r.body?.info?.collegesPlanned === 9, JSON.stringify(r.body).slice(0, 160));
r = await call(s.token, "PATCH", "/me/overview", { collegesPlanned: 100 });
check("more than 99 is refused", r.status === 400, `status ${r.status}`);
r = await call(c.token, "GET", `/student-page/${s.id}/info`);
check("their counselor reads it", r.status === 200 && r.body.collegesPlanned === 9, JSON.stringify(r.body.collegesPlanned));

// ---- scholarships ----------------------------------------------------------

r = await call(s.token, "POST", "/aid/scholarships", {
  name: "Ithaca Rotary Club Scholarship",
  sponsor: "Ithaca Rotary Club",
  amountCents: 250000,
  deadline: "2026-12-01",
  requirements: [{ id: "r1", label: "Essay", done: false }],
});
check("a student adds a scholarship by hand", r.status === 201 && r.body.status === "saved" && r.body.scholarship_id === null, JSON.stringify(r.body).slice(0, 200));
const sch = r.body.id;

r = await call(c.token, "PATCH", `/aid/scholarships/${sch}`, { requirements: [{ id: "r1", label: "Essay", done: true }], status: "applied" });
check("the counselor can edit it and tick the checklist", r.status === 200 && r.body.requirements?.[0]?.done === true && r.body.status === "applied");

r = await call(s.token, "PATCH", `/aid/scholarships/${sch}`, { status: "awarded" });
check("winning one with no figure assumes the amount applied for", r.status === 200 && r.body.awarded_cents === 250000, JSON.stringify(r.body.awarded_cents));
r = await call(s.token, "PATCH", `/aid/scholarships/${sch}`, { awardedCents: 100000 });
check("the amount won can be corrected", r.status === 200 && r.body.awarded_cents === 100000);
r = await call(s.token, "PATCH", `/aid/scholarships/${sch}`, { status: "not-awarded" });
check("not awarded carries no winnings", r.status === 200 && r.body.status === "not-awarded" && r.body.awarded_cents === null);
r = await call(s.token, "PATCH", `/aid/scholarships/${sch}`, {});
check("an empty change is refused", r.status === 400, `status ${r.status}`);
r = await call(s.token, "PATCH", `/aid/scholarships/${sch}`, { status: "bogus" });
check("an unknown status is refused", r.status === 400);
r = await call(outsider.token, "PATCH", `/aid/scholarships/${sch}`, { status: "applying" });
check("another student can't touch it", r.status === 404 || r.status === 403, `status ${r.status}`);

// The seen-through-RLS read, the way the app lists them.
const list = await call(s.token, "GET", "/aid/scholarships");
check("the student lists their scholarships", list.status === 200 && list.body.some((x) => x.id === sch));

// ---- the caseload roll-up --------------------------------------------------

await sql(`update public.student_colleges set status = 'waitlisted' where id = '${bu}'`);
await call(s.token, "PATCH", `/aid/scholarships/${sch}`, { status: "awarded" });
await sql(`update public.profiles set grad_year = '2027' where id = '${s.id}'`);
const sum = await call(c.token, "GET", "/overview/student-summaries");
const mine = (sum.body ?? []).find((x) => x.studentId === s.id);
check("the Overview summaries carry results", sum.status === 200 && mine?.results?.accepted === 2 && mine?.results?.waitlisted === 1, JSON.stringify(mine?.results));
check("…the final choice", mine?.results?.enrolledName === "Michigan");
check("…what the student typed for 'applying to'", mine?.collegesPlanned === 9 && mine?.applying === 9);
check("…scholarship money won", mine?.scholarships?.wonCents === 250000, JSON.stringify(mine?.scholarships));
check("…and the class year to group by", mine?.gradYear === "2027");
const quiet = (sum.body ?? []).find((x) => x.studentId === s2.id);
check("a student with nothing recorded reads zeros", quiet?.results?.accepted === 0 && quiet?.scholarships?.wonCents === 0 && quiet?.collegesPlanned === null);

// ---- the database says the same --------------------------------------------

const direct = await fetch(`${SB}/rest/v1/student_colleges?id=eq.${mit}`, {
  method: "PATCH",
  headers: { apikey: ANON, Authorization: `Bearer ${outsider.token}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ status: "denied" }),
});
const changed = await direct.json();
check("RLS: another student's direct write changes nothing", Array.isArray(changed) ? changed.length === 0 : !direct.ok);
