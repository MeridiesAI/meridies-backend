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
check("the stored brief carries interest categories for the full fixture", Number(await sql(`select jsonb_array_length(brief->'interests') from public.research_runs where id = '${r1.body.runId}'`)) > 0, q.slice(0, 300));

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
const disId = col.body.recommendations[1].id;
const dis = await call(c.token, "POST", `/recommendations/${disId}/dismiss`, {});
check("dismiss works", dis.status === 200 && (await sql(`select status from public.recommendations where id = '${disId}'`)) === "dismissed", String(dis.status));

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

// The second layer: a search query that holds the student's school discards the run and stores nothing.
const c3 = await user("res-api-3");
const { student: s3 } = await seedStudent(c3, "full");
const leak = await call(c3.token, "POST", `/students/${s3.id}/research/activities`, { focus: "fixture:leak-query" });
check("a query holding the student's school is refused with 400", leak.status === 400, JSON.stringify(leak.body).slice(0, 200));
check("…the run is marked discarded with the identity-filter code", (await sql(`select status || ':' || error from public.research_runs where student_id = '${s3.id}'`)) === "discarded:identity-filter");
check("…and nothing was stored", (await sql(`select count(*) from public.recommendations where student_id = '${s3.id}'`)) === "0");
check("…and the 400 doesn't repeat the school", !JSON.stringify(leak.body).toLowerCase().includes("lincoln"));
// A run that found nothing is cached too.
const e1 = await call(c3.token, "POST", `/students/${s3.id}/research/activities`, { focus: "fixture:empty" });
const e2 = await call(c3.token, "POST", `/students/${s3.id}/research/activities`, { focus: "fixture:empty" });
check("a run with no fits succeeds with an empty list", e1.status === 200 && e1.body.recommendations.length === 0 && e1.body.cached === false);
check("…and the repeat is served from cache, empty", e2.status === 200 && e2.body.cached === true && e2.body.runId === e1.body.runId && e2.body.recommendations.length === 0);
check("…and refresh runs it again", (await call(c3.token, "POST", `/students/${s3.id}/research/activities`, { focus: "fixture:empty", refresh: true })).body.cached === false);

let limited = false;
for (let i = 0; i < 6; i++) { const r = await call(c.token, "POST", `/students/${s.id}/research/activities`, { refresh: true }); if (r.status === 429) limited = true; }
check("more than 5 research runs a minute is refused", limited);

// The counselor's export of the student now holds research; the student's own export holds none of it.
const cex = await call(c.token, "GET", `/account/students/${s.id}/export`);
check("the counselor's export includes recommendations and research runs", cex.status === 200 && cex.body.records.recommendations?.length > 0 && cex.body.records.research_runs?.length > 0, Object.keys(cex.body.records ?? {}).join(","));
const sex = await call(s.token, "GET", "/account/export");
check("a student's own export has neither", sex.status === 200 && !sex.body.records.recommendations && !sex.body.records.research_runs);

// A student named "Fixture Student" still gets recommendations (the old name filter dropped every one of them).
const c4 = await user("res-api-4");
const { student: s4 } = await seedStudent(c4, "full");
await sql(`update public.profiles set full_name = 'Fixture Student' where id = '${s4.id}'`);
const n1 = await call(c4.token, "POST", `/students/${s4.id}/research/activities`, {});
check("a student named Fixture Student gets recommendations", n1.status === 200 && n1.body.recommendations.length > 0, JSON.stringify(n1.body).slice(0, 200));

// A run whose candidates were all dropped downstream is not served from cache; one that found nothing still is.
const d1 = await call(c4.token, "POST", `/students/${s4.id}/research/activities`, { focus: "fixture:all-dropped" });
const d2 = await call(c4.token, "POST", `/students/${s4.id}/research/activities`, { focus: "fixture:all-dropped" });
check("candidates found but all dropped: an empty successful run", d1.status === 200 && d1.body.recommendations.length === 0 && d1.body.cached === false);
check("…the repeat runs again instead of being served from cache", d2.status === 200 && d2.body.cached === false && d2.body.runId !== d1.body.runId);

// A second identical request while one is running gets 409; a stale running row (over 10 minutes) is ignored.
const hash = await sql(`select inputs_hash from public.research_runs where id = '${n1.body.runId}'`);
const fake = await sql(`insert into public.research_runs (student_id, counselor_id, feature, inputs_hash, brief, status, expires_at)
  values ('${s4.id}', '${c4.id}', 'activities', '${hash}', '{}'::jsonb, 'running', now() + interval '7 days') returning id`);
const busy = await call(c4.token, "POST", `/students/${s4.id}/research/activities`, { refresh: true });
check("a request identical to a running one is refused with 409", busy.status === 409 && /already running/i.test(JSON.stringify(busy.body)), `${busy.status} ${JSON.stringify(busy.body).slice(0, 200)}`);
await sql(`update public.research_runs set created_at = now() - interval '11 minutes' where id = '${fake.split("\n")[0]}'`);
const stale = await call(c4.token, "POST", `/students/${s4.id}/research/activities`, { refresh: true });
check("a running row older than 10 minutes is treated as dead", stale.status === 200, String(stale.status));

// The practice's daily cap: pre-load the fixed-window counter (private.rate_limit_buckets, key research-day:<firm or counselor id>).
const c5 = await user("res-api-5");
const { student: s5 } = await seedStudent(c5, "full");
await sql(`insert into private.rate_limit_buckets (key, window_start, count) values ('research-day:${c5.id}', now(), 50)
  on conflict (key) do update set window_start = excluded.window_start, count = excluded.count`);
const capped = await call(c5.token, "POST", `/students/${s5.id}/research/activities`, { refresh: true });
check("the 51st run of the day is refused with 429 and the cap's message", capped.status === 429 && /used today's research runs/i.test(JSON.stringify(capped.body)), `${capped.status} ${JSON.stringify(capped.body).slice(0, 200)}`);
check("…and no run row was created for it", (await sql(`select count(*) from public.research_runs where student_id = '${s5.id}'`)) === "0");
