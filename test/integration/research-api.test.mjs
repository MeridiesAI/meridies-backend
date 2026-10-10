// Research Task 10, with RESEARCH_FAKE=fixture: no model or web calls.
import { check, call, user, sql } from "./harness.mjs";
import { studentOf, firmWith } from "./imports-helpers.mjs";
import { seedStudent } from "../fixtures/context/students.mjs";

const c = await user("res-api");
const { student: s } = await seedStudent(c, "full");
const r1 = await call(c.token, "POST", `/students/${s.id}/research/activities`, {});
check("research runs", r1.status === 200 && r1.body.recommendations.length > 0, JSON.stringify(r1.body).slice(0, 300));
check("every recommendation cites a checked source", r1.body.recommendations.every((x) => x.sources.length > 0 && x.sources.every((s) => s.url && s.checkedAt)));
check("blocked and unseen sources were dropped", !JSON.stringify(r1.body).includes("niche.com") && !JSON.stringify(r1.body).includes("invented.example"));
check("deadlines and costs are marked verify", r1.body.recommendations.every((x) => x.details.verify === true));
check("context used is reported", Array.isArray(r1.body.contextUsed.used));
const q = await sql(`select brief::text from public.research_runs where id = '${r1.body.runId}'`);
check("the stored brief has no name or email", !q.toLowerCase().includes(s.email.split("@")[0]) && !q.includes(s.email));

const r2 = await call(c.token, "POST", `/students/${s.id}/research/activities`, {});
check("a second run within 7 days is cached", r2.body.cached === true && r2.body.runId === r1.body.runId);
const r3 = await call(c.token, "POST", `/students/${s.id}/research/activities`, { refresh: true });
check("refresh forces a new run", r3.body.cached === false && r3.body.runId !== r1.body.runId);
await sql(`update public.student_personal_details set intended_majors = array['History'] where student_id = '${s.id}'`);
const r4 = await call(c.token, "POST", `/students/${s.id}/research/activities`, {});
check("changing majors invalidates the cache", r4.body.cached === false);

const rec = r4.body.recommendations[0];
const acc = await call(c.token, "POST", `/recommendations/${rec.id}/accept`, {});
check("accepting an activity creates a hidden counselor task", acc.status === 200 && acc.body.acceptedAs.type === "task");
check("the task is hidden from the student", (await sql(`select visible_to_student::text from public.deliverables where id = '${acc.body.acceptedAs.id}'`)) === "false");
const list = await call(c.token, "GET", `/students/${s.id}/recommendations?feature=activities`);
check("the acceptance link is stored", list.body.some((x) => x.id === rec.id && x.status === "accepted" && x.acceptedAs?.id === acc.body.acceptedAs.id));

const col = await call(c.token, "POST", `/students/${s.id}/research/college-list`, {});
check("college research runs", col.status === 200 && col.body.recommendations.length > 0);
const accC = await call(c.token, "POST", `/recommendations/${col.body.recommendations[0].id}/accept`, {});
check("accepting a college adds it to the list", accC.status === 200 && accC.body.acceptedAs.type === "student_college");
const dis = await call(c.token, "POST", `/recommendations/${col.body.recommendations[1]?.id ?? col.body.recommendations[0].id}/dismiss`, {});
check("dismiss works", dis.status === 200 || dis.status === 409);

const owner = await user("res-api-owner"); const other = await user("res-api-other");
await firmWith(owner, [c, other]);
check("a same-firm counselor without access gets 404", (await call(other.token, "POST", `/students/${s.id}/research/activities`, {})).status === 404);
check("…and sees no recommendations", (await call(other.token, "GET", `/students/${s.id}/recommendations`)).status === 404);
check("a student gets 403", (await call(s.token, "POST", `/students/${s.id}/research/activities`, {})).status === 403);

// A focus that names the student is refused before anything is created or spent.
const c2 = await user("res-api-2");
const { student: s2 } = await seedStudent(c2, "full");
const runsBefore = await sql(`select count(*) from public.research_runs where student_id = '${s2.id}'`);
const bad = await call(c2.token, "POST", `/students/${s2.id}/research/activities`, { focus: "programs like the one Maya did" });
check("a focus naming the student is refused with 400", bad.status === 400 && /focus/i.test(bad.body.error ?? bad.body.message ?? JSON.stringify(bad.body)), JSON.stringify(bad.body).slice(0, 200));
check("…and no run row was created", (await sql(`select count(*) from public.research_runs where student_id = '${s2.id}'`)) === runsBefore);
check("an unknown body field is refused", (await call(c2.token, "POST", `/students/${s2.id}/research/activities`, { studentName: "x" })).status === 400);
check("a bad feature is refused", (await call(c2.token, "POST", `/students/${s2.id}/research/essays`, {})).status === 400);

// Cached answers keep the original check date; runs are stored succeeded with an expiry a week out.
check("a cached answer keeps the original checkedAt", r2.body.checkedAt === r1.body.checkedAt);
check("the run is stored as succeeded, expiring in about 7 days", (await sql(`select (status = 'succeeded' and expires_at > now() + interval '6 days 23 hours' and expires_at < now() + interval '7 days 1 hour')::text from public.research_runs where id = '${r1.body.runId}'`)) === "true");

// Two accepts of one recommendation: one wins, one is told 409, one task exists.
const run2 = await call(c2.token, "POST", `/students/${s2.id}/research/activities`, {});
const target = run2.body.recommendations[0];
const tasksBefore = await sql(`select count(*) from public.deliverables where student_id = '${s2.id}'`);
const [a1, a2] = await Promise.all([
  call(c2.token, "POST", `/recommendations/${target.id}/accept`, {}),
  call(c2.token, "POST", `/recommendations/${target.id}/accept`, {}),
]);
check("two accepts give one 200 and one 409", [a1.status, a2.status].sort().join() === "200,409", `${a1.status}/${a2.status}`);
check("…and exactly one task", (await sql(`select count(*) from public.deliverables where student_id = '${s2.id}'`)) === String(Number(tasksBefore) + 1));
check("a dismissed or accepted recommendation can't be dismissed again", (await call(c2.token, "POST", `/recommendations/${target.id}/dismiss`, {})).status === 409);
check("the task is a plain hidden counselor task with no student notification", (await sql(`select (source = 'counselor' and visible_to_student = false and kind = 'custom')::text from public.deliverables where id = '${(a1.body.acceptedAs ?? a2.body.acceptedAs).id}'`)) === "true");
check("no message was sent to the student for it", (await sql(`select count(*) from public.message_deliveries where student_id = '${s2.id}'`)) === "0");

// Who can reach what.
check("a counselor without access can't accept", (await call(other.token, "POST", `/recommendations/${rec.id}/accept`, {})).status === 404);
check("…or dismiss", (await call(other.token, "POST", `/recommendations/${rec.id}/dismiss`, {})).status === 404);
check("a student can't list recommendations", (await call(s.token, "GET", `/students/${s.id}/recommendations`)).status === 403);
check("a student can't accept", (await call(s.token, "POST", `/recommendations/${rec.id}/accept`, {})).status === 403);
check("a student's task list doesn't show the accepted activity", !JSON.stringify((await call(s.token, "GET", "/tasks")).body).includes(rec.title));
check("an unknown recommendation id is 404", (await call(c.token, "POST", `/recommendations/00000000-0000-4000-8000-000000000001/accept`, {})).status === 404);

let limited = false;
for (let i = 0; i < 6; i++) { const r = await call(c.token, "POST", `/students/${s.id}/research/activities`, { refresh: true }); if (r.status === 429) limited = true; }
check("more than 5 research runs a minute is refused", limited);
