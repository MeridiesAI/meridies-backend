// The same suggestion across research runs (lib/research/repeats.ts), with RESEARCH_FAKE=fixture: every run returns
// the same two activities and the same two colleges, so `refresh: true` stores a second copy of each.
import { check, call, user, sql } from "./harness.mjs";
import { seedStudent } from "../fixtures/context/students.mjs";

const c = await user("res-rep");
const { student: s } = await seedStudent(c, "full");
const list = async (feature) => (await call(c.token, "GET", `/students/${s.id}/recommendations?feature=${feature}`)).body;
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const taskCount = async () => Number(await sql(`select count(*) from public.deliverables where student_id = '${s.id}'`));

// Two runs: two copies of each activity.
const r1 = await call(c.token, "POST", `/students/${s.id}/research/activities`, {});
check("first run", r1.status === 200 && r1.body.recommendations.length === 2, JSON.stringify(r1.body).slice(0, 200));
check("a fresh run's rows are unmarked", r1.body.recommendations.every((r) => r.repeatOf === null));
check("rows carry createdAt", r1.body.recommendations.every((r) => typeof r.createdAt === "string" && !Number.isNaN(Date.parse(r.createdAt))));
const r2 = await call(c.token, "POST", `/students/${s.id}/research/activities`, { refresh: true });
check("second run", r2.status === 200 && r2.body.recommendations.length === 2);
check("the second run's rows lead (unmarked)", r2.body.recommendations.every((r) => r.repeatOf === null));

const [a1, b1] = r1.body.recommendations;
const a2 = r2.body.recommendations.find((r) => r.title === a1.title);
const b2 = r2.body.recommendations.find((r) => r.title === b1.title);
let rows = byId(await list("activities"));
check("the list keeps every row", rows.size === 4);
check("older copies point at the newer ones", rows.get(a1.id).repeatOf?.id === a2.id && rows.get(a1.id).repeatOf?.status === "suggested" && rows.get(b1.id).repeatOf?.id === b2.id);
check("the newer copies are unmarked", rows.get(a2.id).repeatOf === null && rows.get(b2.id).repeatOf === null);

// Accepting the newest copy dismisses the older one.
const acc = await call(c.token, "POST", `/recommendations/${a2.id}/accept`, {});
check("accept works", acc.status === 200 && acc.body.acceptedAs.type === "task");
check("…and dismisses the older copy", JSON.stringify(acc.body.alsoDismissed) === JSON.stringify([a1.id]), JSON.stringify(acc.body));
check("…in the database", (await sql(`select status from public.recommendations where id = '${a1.id}'`)) === "dismissed");
check("…and leaves the other suggestion alone", (await sql(`select status from public.recommendations where id = '${b1.id}'`)) === "suggested");

// A third run suggests the accepted activity again.
const r3 = await call(c.token, "POST", `/students/${s.id}/research/activities`, { refresh: true });
const a3 = r3.body.recommendations.find((r) => r.title === a1.title);
const b3 = r3.body.recommendations.find((r) => r.title === b1.title);
check("a suggestion accepted before is marked accepted in the run's answer", a3.repeatOf?.id === a2.id && a3.repeatOf?.status === "accepted", JSON.stringify(a3.repeatOf));
check("…and in the list", byId(await list("activities")).get(a3.id).repeatOf?.status === "accepted");
const cached = await call(c.token, "POST", `/students/${s.id}/research/activities`, {});
check("a cached answer is marked too", cached.body.cached === true && cached.body.runId === r3.body.runId && cached.body.recommendations.find((r) => r.id === a3.id)?.repeatOf?.status === "accepted", JSON.stringify(cached.body.recommendations?.map((r) => r.repeatOf)));
const before = await taskCount();
const again = await call(c.token, "POST", `/recommendations/${a3.id}/accept`, {});
check("accepting it again is refused with already_accepted", again.status === 409 && again.body.code === "already_accepted", JSON.stringify(again.body));
check("…and makes no second task", (await taskCount()) === before);
check("…and leaves it suggested", (await sql(`select status from public.recommendations where id = '${a3.id}'`)) === "suggested");

// Dismissing the newest copy of the other suggestion dismisses both older copies.
const dis = await call(c.token, "POST", `/recommendations/${b3.id}/dismiss`, {});
check("dismiss answers with the copies it dismissed", dis.status === 200 && [...dis.body.alsoDismissed].sort().join() === [b1.id, b2.id].sort().join(), JSON.stringify(dis.body));
check("…in the database", (await sql(`select count(*) from public.recommendations where id in ('${b1.id}', '${b2.id}') and status = 'dismissed'`)) === "2");
check("a decided row's 409 says so", (await call(c.token, "POST", `/recommendations/${b2.id}/accept`, {})).body.code === "recommendation_decided");

// Once the task is gone the suggestion can be accepted again.
await sql(`delete from public.deliverables where id = '${acc.body.acceptedAs.id}'`);
check("with the task deleted the copy is no longer marked", byId(await list("activities")).get(a3.id).repeatOf === null);
const reaccept = await call(c.token, "POST", `/recommendations/${a3.id}/accept`, {});
check("…and accepting it makes a new task", reaccept.status === 200 && reaccept.body.acceptedAs.type === "task", JSON.stringify(reaccept.body));

// Colleges: the same rules, keyed on the catalog id when there is one, else the title. A second counselor, because
// research runs are limited to 5 a minute per user.
const k = await user("res-rep-col");
const { student: s2 } = await seedStudent(k, "full");
const c1 = await call(k.token, "POST", `/students/${s2.id}/research/college-list`, {});
const alpha1 = c1.body.recommendations.find((r) => r.title === "Alpha Example College");
const beta1 = c1.body.recommendations.find((r) => r.title === "Beta Example University");
check("college run", c1.status === 200 && alpha1 && beta1);
const accA = await call(k.token, "POST", `/recommendations/${alpha1.id}/accept`, {});
check("accepting a college adds it to the list", accA.status === 200 && accA.body.acceptedAs.type === "student_college" && accA.body.alsoDismissed.length === 0);
const c2 = await call(k.token, "POST", `/students/${s2.id}/research/college-list`, { refresh: true });
const alpha2 = c2.body.recommendations.find((r) => r.title === alpha1.title);
check("the accepted college suggested again is marked", alpha2.repeatOf?.id === alpha1.id && alpha2.repeatOf?.status === "accepted");
const accA2 = await call(k.token, "POST", `/recommendations/${alpha2.id}/accept`, {});
check("…and accepting it again is refused", accA2.status === 409 && accA2.body.code === "already_accepted", JSON.stringify(accA2.body));

// Off the list, then added back by hand: the accepted row no longer stands, but the school is on the list.
await sql(`delete from public.student_colleges where id = '${accA.body.acceptedAs.id}'`);
const hand = await call(k.token, "POST", "/application/college-list", { studentId: s2.id, name: "Alpha Example College" });
check("the school is added back by hand", hand.status === 201, JSON.stringify(hand.body).slice(0, 200));
const accA3 = await call(k.token, "POST", `/recommendations/${alpha2.id}/accept`, {});
check("accepting a school already on the list is 409 already_on_list", accA3.status === 409 && accA3.body.code === "already_on_list", JSON.stringify(accA3.body));
check("…and the claim is released", (await sql(`select status from public.recommendations where id = '${alpha2.id}'`)) === "suggested");

// Who can see what is unchanged: another counselor reaches nothing, and a student is refused.
const other = await user("res-rep-other");
check("another counselor's list is 404", (await call(other.token, "GET", `/students/${s.id}/recommendations`)).status === 404);
check("another counselor can't dismiss", (await call(other.token, "POST", `/recommendations/${alpha2.id}/dismiss`, {})).status === 404);
check("…or accept", (await call(other.token, "POST", `/recommendations/${a3.id}/accept`, {})).status === 404);
check("a student can't list", (await call(s.token, "GET", `/students/${s.id}/recommendations`)).status === 403);
