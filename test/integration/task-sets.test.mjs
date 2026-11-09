// Saved task sets (migration 20261111000005, routes/taskSets.ts) and the firm roster (firm_roster(),
// GET /management/firm-roster). Mail goes to the local catcher only.
//
//   firm F: owner O, admin Ad, consultant C (the set's owner); another firm owned by X.
//   C's roster: c1, c2 (2027), c3 (2027, archived), c4 (2028), c5 (2027, added later). O's roster: o1. X's: x1.
import { call, check, rest, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const O = await user("tset-owner");
const Ad = await user("tset-admin");
const C = await user("tset-c");
const X = await user("tset-x");
const firm = await firmWith(O, [Ad, C]);
await sql(`update public.firm_members set seat_role = 'admin' where firm_id = '${firm}' and profile_id = '${Ad.id}'`);
const otherFirm = await firmWith(X, []);

const c1 = await studentOf(C, "tset-c1");
const c2 = await studentOf(C, "tset-c2");
const c3 = await studentOf(C, "tset-c3");
const c4 = await studentOf(C, "tset-c4");
const o1 = await studentOf(O, "tset-o1");
const x1 = await studentOf(X, "tset-x1");
await sql(`update public.profiles set grad_year = '2027' where id in ('${c1.id}', '${c2.id}', '${c3.id}')`);
await sql(`update public.profiles set grad_year = '2028' where id = '${c4.id}'`);
await sql(`update public.profiles set archived_at = now() where id = '${c3.id}'`);

const count = async (q) => Number(await sql(q));
const setRows = (setId) => count(`select count(*) from public.deliverables where task_set_id = '${setId}'`);

// ---------------------------------------------------------------------------
// CRUD and ownership
// ---------------------------------------------------------------------------
const items = [
  { title: "Brag sheet", kind: "document", instructions: "One page, bullet points", dueOffsetDays: 14 },
  {
    title: "Personal statement",
    kind: "essay",
    targetWords: 650,
    dueMonth: 11,
    dueDay: 1,
    stages: [{ name: "Brainstorm", dueOffsetDays: 7 }, { name: "Draft", dueOffsetDays: 21 }, { name: "Polish" }],
  },
];
let r = await call(C.token, "POST", "/task-sets", { name: "Junior spring", items });
check("a counselor saves a set", r.status === 201 && r.body.mine === true && r.body.shared === false && r.body.items.length === 2, JSON.stringify(r.body).slice(0, 200));
const set = r.body;
const [k0, k1] = (set.items ?? []).map((i) => i.key);
check("the server gives every item a key", typeof k0 === "string" && typeof k1 === "string" && k0 !== k1, JSON.stringify(set.items?.map((i) => i.key)));

r = await call(C.token, "POST", "/task-sets", { name: "Too many", items: Array.from({ length: 31 }, () => ({ title: "A" })) });
check("31 items are refused", r.status === 400, `${r.status}`);
r = await call(C.token, "POST", "/task-sets", { name: "Bad date", items: [{ title: "A", dueMonth: 2, dueDay: 30 }] });
check("Feb 30 is refused", r.status === 400, `${r.status}`);
r = await call(c1.token, "POST", "/task-sets", { name: "Mine", items: [{ title: "A" }] });
check("a student can't save a set", r.status === 403, `${r.status}`);

r = await call(C.token, "GET", "/task-sets");
check("the owner lists it", r.status === 200 && r.body.some((s) => s.id === set.id), JSON.stringify(r.body).slice(0, 200));
r = await call(X.token, "GET", "/task-sets");
check("another practice doesn't see it", r.status === 200 && !r.body.some((s) => s.id === set.id));
r = await call(O.token, "GET", "/task-sets");
check("the firm owner doesn't see an unshared set", r.status === 200 && !r.body.some((s) => s.id === set.id));
check("another practice can't rename it", (await call(X.token, "PATCH", `/task-sets/${set.id}`, { name: "Mine now" })).status === 404);
check("another practice can't delete it", (await call(X.token, "DELETE", `/task-sets/${set.id}`)).status === 404);
const direct = await rest(X.token, "GET", `/rest/v1/task_sets?id=eq.${set.id}&select=id`);
check("RLS hides it from another practice", direct.status === 200 && direct.body.length === 0, JSON.stringify(direct.body));

r = await call(C.token, "PATCH", `/task-sets/${set.id}`, { name: "Junior spring plan", shared: true });
check("the owner renames and shares it", r.status === 200 && r.body.name === "Junior spring plan" && r.body.shared === true, JSON.stringify(r.body).slice(0, 200));
check("the database records the firm", (await sql(`select firm_id from public.task_sets where id = '${set.id}'`)) === firm);
r = await call(O.token, "GET", "/task-sets");
const seen = Array.isArray(r.body) ? r.body.find((s) => s.id === set.id) : null;
check("a firm colleague reads a shared set", r.status === 200 && seen?.mine === false && seen?.shared === true);
check("a firm colleague can't change it", (await call(O.token, "PATCH", `/task-sets/${set.id}`, { name: "Owner's" })).status === 404);
const sneaky = await rest(O.token, "PATCH", `/rest/v1/task_sets?id=eq.${set.id}`, { name: "Owner's" }, { Prefer: "return=representation" });
check("RLS refuses a colleague's direct update", Array.isArray(sneaky.body) ? sneaky.body.length === 0 : sneaky.status >= 400, JSON.stringify(sneaky.body));
check("still C's name", (await sql(`select name from public.task_sets where id = '${set.id}'`)) === "Junior spring plan");
r = await call(X.token, "GET", "/task-sets");
check("another firm doesn't read a shared set", !r.body.some((s) => s.id === set.id));
const forged = await rest(X.token, "POST", "/rest/v1/task_sets", { counselor_id: X.id, firm_id: firm, name: "Forged", items: [{ title: "A" }] });
check("RLS refuses a set shared into a firm the writer isn't in", forged.status >= 400, `${forged.status}`);
const forgedOwner = await rest(X.token, "POST", "/rest/v1/task_sets", { counselor_id: C.id, name: "Forged", items: [{ title: "A" }] });
check("RLS refuses a set written in someone else's name", forgedOwner.status >= 400, `${forgedOwner.status}`);
const solo = await user("tset-solo");
r = await call(solo.token, "POST", "/task-sets", { name: "Shared solo", items: [{ title: "A" }], shared: true });
check("a solo counselor can't share (no firm)", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

// ---------------------------------------------------------------------------
// Apply by students: one task per item, marked; the second apply makes nothing
// ---------------------------------------------------------------------------
const before = await count(`select count(*) from public.message_deliveries where template = 'task-assigned' and student_id in ('${c1.id}', '${c2.id}')`);
r = await call(C.token, "POST", `/task-sets/${set.id}/apply`, { studentIds: [c1.id, c2.id] });
check("apply answers per student", r.status === 200 && r.body.created === 4 && r.body.alreadyAssigned === 0 && r.body.failed === 0, JSON.stringify(r.body).slice(0, 400));
const res1 = r.body.results?.[c1.id];
check("each student's result names a task and both items", Boolean(res1?.taskId) && res1.items?.length === 2 && res1.items.every((i) => i.status === "created" && i.taskId), JSON.stringify(res1));
check("4 deliverables carry the set", (await setRows(set.id)) === 4);
check("each item index once per student", (await count(`select count(distinct (student_id, task_set_item_key)) from public.deliverables where task_set_id = '${set.id}'`)) === 4);
check("the essay's stages were made", (await count(`select count(*) from public.deliverable_stages s join public.deliverables d on d.id = s.deliverable_id where d.task_set_id = '${set.id}' and d.student_id = '${c1.id}'`)) === 3);
const brag = await sql(`select due_date::text from public.deliverables where task_set_id = '${set.id}' and task_set_item_key = '${k0}' and student_id = '${c1.id}'`);
const today = new Date().toISOString().slice(0, 10);
const plus14 = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + 14)).toISOString().slice(0, 10);
const tzDay = Math.abs(Date.parse(brag) - Date.parse(plus14)) <= 86_400_000;
check("an offset is days after today", tzDay, `${brag} vs ${plus14}`);
const essayDue = await sql(`select due_date::text from public.deliverables where task_set_id = '${set.id}' and task_set_item_key = '${k1}' and student_id = '${c1.id}'`);
check("a month and day is its next occurrence", /^\d{4}-11-01$/.test(essayDue) && essayDue >= today, essayDue);
check("tasks made from a set are counselor tasks", (await count(`select count(*) from public.deliverables where task_set_id = '${set.id}' and source <> 'counselor'`)) === 0);
const emails = (await count(`select count(*) from public.message_deliveries where template = 'task-assigned' and student_id in ('${c1.id}', '${c2.id}')`)) - before;
check("one assignment email per student per apply, not one per item", emails === 2, `${emails}`);
check("every task stores the email choice the counselor made (only the send is skipped)", (await count(`select count(*) from public.deliverables where task_set_id = '${set.id}' and notify_email`)) === 4);
check("every task still gets its in-app notice", (await count(`select count(*) from public.notifications where recipient_id in ('${c1.id}', '${c2.id}') and title like 'New task:%'`)) >= 4);

r = await call(C.token, "POST", `/task-sets/${set.id}/apply`, { studentIds: [c1.id, c2.id] });
check("a second apply is all 'already assigned'", r.status === 200 && r.body.created === 0 && r.body.alreadyAssigned === 4, JSON.stringify(r.body).slice(0, 300));
check("... with the existing task named", r.body.results?.[c1.id]?.taskId === res1.taskId && r.body.results[c1.id].alreadyAssigned === true);
check("... and no new rows", (await setRows(set.id)) === 4);

// A race past the pre-check still lands on the unique index.
const dup = await rest(C.token, "POST", "/rest/v1/deliverables", { student_id: c1.id, kind: "custom", title: "Dup", status: "not-started", source: "counselor", created_by: C.id, task_set_id: set.id, task_set_item_key: k0 });
check("the database refuses a second task for the same item", dup.status === 409 && /23505/.test(JSON.stringify(dup.body)), `${dup.status} ${JSON.stringify(dup.body).slice(0, 120)}`);
const squat = await rest(c4.token, "POST", "/rest/v1/deliverables", { student_id: c4.id, kind: "custom", title: "Mine", status: "not-started", source: "student", created_by: c4.id, task_set_id: set.id, task_set_item_key: k0 });
check("a student's own to-do can't carry a set marker", squat.status >= 400, `${squat.status}`);

// ---------------------------------------------------------------------------
// Apply by class year: active roster only, resolved on the server
// ---------------------------------------------------------------------------
const c5 = await studentOf(C, "tset-c5");
await sql(`update public.profiles set grad_year = '2027' where id = '${c5.id}'`);
r = await call(C.token, "POST", `/task-sets/${set.id}/apply`, { classYear: "2027", notifyEmail: false });
const keys = Object.keys(r.body.results ?? {}).sort();
check("class of 2027 is c1, c2, c5 (c3 is archived, c4 is 2028)", r.status === 200 && keys.join() === [c1.id, c2.id, c5.id].sort().join(), JSON.stringify(keys));
check("only c5 got new tasks", r.body.created === 2 && r.body.alreadyAssigned === 4, JSON.stringify(r.body).slice(0, 200));
check("no archived student was assigned", (await count(`select count(*) from public.deliverables where task_set_id = '${set.id}' and student_id = '${c3.id}'`)) === 0);
check("notifyEmail false sends nothing", (await count(`select count(*) from public.message_deliveries where template = 'task-assigned' and student_id = '${c5.id}'`)) === 0);
r = await call(C.token, "POST", `/task-sets/${set.id}/apply`, { classYear: "2031" });
check("an empty class year is a 400 in words", r.status === 400, `${r.status}`);

// ---------------------------------------------------------------------------
// A student not on the caseload is refused on their own line
// ---------------------------------------------------------------------------
r = await call(C.token, "POST", `/task-sets/${set.id}/apply`, { studentIds: [c4.id, x1.id], notifyEmail: false });
check("the batch still answers 200", r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
check("the stranger is refused with a reason", Boolean(r.body.results?.[x1.id]?.error) && !r.body.results[x1.id].taskId, JSON.stringify(r.body.results?.[x1.id]));
check("the caseload student is assigned", r.body.results?.[c4.id]?.items?.every((i) => i.status === "created"));
check("nothing was written for the stranger", (await count(`select count(*) from public.deliverables where student_id = '${x1.id}'`)) === 0);
check("another practice can't apply C's unshared... (X can't see the set)", (await call(X.token, "POST", `/task-sets/${set.id}/apply`, { studentIds: [x1.id] })).status === 404);

// A firm colleague applies a shared set to their own student.
r = await call(O.token, "POST", `/task-sets/${set.id}/apply`, { studentIds: [o1.id], notifyEmail: false });
check("a colleague applies a shared set to their own student", r.status === 200 && r.body.created === 2, JSON.stringify(r.body).slice(0, 200));
r = await call(O.token, "POST", `/task-sets/${set.id}/apply`, { studentIds: [c1.id], notifyEmail: false });
check("... but not to a colleague's student", r.status === 200 && Boolean(r.body.results?.[c1.id]?.error), JSON.stringify(r.body).slice(0, 200));

// ---------------------------------------------------------------------------
// The email throttle
// ---------------------------------------------------------------------------
const s2 = await call(C.token, "POST", "/task-sets", { name: "Throttle", items: [{ title: "One" }] });
const c6 = await studentOf(C, "tset-c6");
await sql(`insert into private.rate_limit_buckets (key, window_start, count) values ('task-set-email:${C.id}', now(), 200) on conflict (key) do update set window_start = now(), count = 200`);
r = await call(C.token, "POST", `/task-sets/${s2.body.id}/apply`, { studentIds: [c6.id] });
check("past the daily cap the task is made and the email skipped", r.status === 200 && r.body.created === 1 && r.body.emailThrottled === 1 && r.body.results?.[c6.id]?.emailThrottled === true, JSON.stringify(r.body).slice(0, 300));
check("no email went", (await count(`select count(*) from public.message_deliveries where template = 'task-assigned' and student_id = '${c6.id}'`)) === 0);
await sql(`delete from private.rate_limit_buckets where key = 'task-set-email:${C.id}'`);

// ---------------------------------------------------------------------------
// Editing a set after it was applied: the marker is the item's key, not its place
// ---------------------------------------------------------------------------
r = await call(C.token, "POST", "/task-sets", { name: "Editable", items: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }] });
const ed = r.body;
const [ka, kb, kc] = ed.items.map((i) => i.key);
r = await call(C.token, "POST", `/task-sets/${ed.id}/apply`, { studentIds: [c4.id], notifyEmail: false });
check("the editable set is applied once", r.status === 200 && r.body.created === 3, JSON.stringify(r.body).slice(0, 200));
// Reorder (Gamma first), insert Delta, remove Beta.
r = await call(C.token, "PATCH", `/task-sets/${ed.id}`, { items: [{ title: "Gamma", key: kc }, { title: "Delta" }, { title: "Alpha", key: ka }] });
check("PATCH keeps the keys it was sent", r.status === 200 && r.body.items[0].key === kc && r.body.items[2].key === ka, JSON.stringify(r.body.items));
const kd = r.body.items?.[1]?.key;
check("... and gives the new item a new key", typeof kd === "string" && ![ka, kb, kc].includes(kd));
r = await call(C.token, "POST", `/task-sets/${ed.id}/apply`, { studentIds: [c4.id], notifyEmail: false });
check("re-applying makes only the genuinely new item", r.status === 200 && r.body.created === 1 && r.body.alreadyAssigned === 2, JSON.stringify(r.body).slice(0, 300));
const lines = r.body.results?.[c4.id]?.items ?? [];
check("... Delta is the one made, Gamma and Alpha are already assigned", lines.map((l) => `${l.title}:${l.status}`).join() === "Gamma:already-assigned,Delta:created,Alpha:already-assigned", JSON.stringify(lines));
const titles = await sql(`select string_agg(title, ',' order by title) from public.deliverables where task_set_id = '${ed.id}' and student_id = '${c4.id}'`);
check("... nothing duplicated, nothing wrongly skipped", titles === "Alpha,Beta,Delta,Gamma", titles);
r = await call(C.token, "PATCH", `/task-sets/${ed.id}`, { items: [{ title: "X", key: ka }, { title: "Y", key: ka }] });
check("duplicate keys are refused", r.status === 400, `${r.status}`);
r = await call(C.token, "POST", "/task-sets", { name: "Dup keys", items: [{ title: "X", key: "same" }, { title: "Y", key: "same" }] });
check("... on create too", r.status === 400, `${r.status}`);

// ---------------------------------------------------------------------------
// The size guard: at most 300 NEW tasks an apply, counted after what exists
// ---------------------------------------------------------------------------
const big = await call(C.token, "POST", "/task-sets", { name: "Thirty", items: Array.from({ length: 30 }, (_, i) => ({ title: `Item ${i}` })) });
const eleven = [];
for (let i = 0; i < 11; i++) eleven.push(await studentOf(C, `tset-big${i}`));
const elevenIds = eleven.map((s) => s.id);
await sql(`update public.profiles set grad_year = '2030' where id in (${elevenIds.map((id) => `'${id}'`).join(",")})`);
r = await call(C.token, "POST", `/task-sets/${big.body.id}/apply`, { studentIds: elevenIds, notifyEmail: false });
check("11 students x 30 items is too large", r.status === 400 && r.body.code === "apply_too_large" && r.body.limit === 300 && r.body.perStudent === 30 && r.body.maxStudents === 10, JSON.stringify(r.body).slice(0, 300));
check("... and nothing was made", (await setRows(big.body.id)) === 0);
r = await call(C.token, "POST", `/task-sets/${big.body.id}/apply`, { classYear: "2030", notifyEmail: false });
check("the class-year form names the students so the app can split them", r.status === 400 && r.body.code === "apply_too_large" && r.body.maxStudents === 10 && [...(r.body.studentIds ?? [])].sort().join() === [...elevenIds].sort().join(), JSON.stringify(r.body).slice(0, 300));
// As if a first attempt made items 1..29 for everyone and then timed out.
const bigKeys = big.body.items.map((i) => i.key);
await sql(`insert into public.deliverables (student_id, kind, title, status, source, created_by, task_set_id, task_set_item_key)
  select s, 'custom', 'pre', 'not-started', 'counselor', '${C.id}', '${big.body.id}', k
  from unnest(array[${elevenIds.map((id) => `'${id}'`).join(",")}]::uuid[]) s, unnest(array[${bigKeys.slice(1).map((k) => `'${k}'`).join(",")}]::text[]) k`);
r = await call(C.token, "POST", `/task-sets/${big.body.id}/apply`, { studentIds: elevenIds, notifyEmail: false });
check("a retry where most are already made goes through", r.status === 200 && r.body.created === 11 && r.body.alreadyAssigned === 319, JSON.stringify(r.body).slice(0, 200));

// ---------------------------------------------------------------------------
// Deleting a set keeps its tasks
// ---------------------------------------------------------------------------
check("the owner deletes a set", (await call(C.token, "DELETE", `/task-sets/${s2.body.id}`)).status === 204);
check("its task stays, unmarked", (await count(`select count(*) from public.deliverables where student_id = '${c6.id}' and title = 'One' and task_set_id is null`)) === 1);

// ---------------------------------------------------------------------------
// The firm roster: names only, owners and admins only
// ---------------------------------------------------------------------------
r = await call(O.token, "GET", "/management/firm-roster");
const ids = new Set((r.body.students ?? []).map((s) => s.id));
check("the owner reads the firm roster", r.status === 200 && ids.has(c1.id) && ids.has(o1.id) && ids.has(c5.id), JSON.stringify(r.body).slice(0, 300));
check("... active students only", !ids.has(c3.id));
check("... never another firm's", !ids.has(x1.id));
const row = (r.body.students ?? []).find((s) => s.id === c1.id);
check("... as id, name, class year and counselor", row && Object.keys(row).sort().join() === "counselorId,gradYear,id,name" && row.counselorId === C.id && row.gradYear === "2027", JSON.stringify(row));
check("... with the consultants for the filter", Array.isArray(r.body.consultants) && r.body.consultants.some((c) => c.id === C.id));
check("an admin reads it too", (await call(Ad.token, "GET", "/management/firm-roster")).status === 200);
check("a plain consultant is refused", (await call(C.token, "GET", "/management/firm-roster")).status === 403);
check("a student is refused", (await call(c1.token, "GET", "/management/firm-roster")).status === 403);
check("a solo counselor is refused", (await call(solo.token, "GET", "/management/firm-roster")).status === 403);
r = await call(X.token, "GET", "/management/firm-roster");
check("another firm's owner sees only their own", r.status === 200 && !r.body.students.some((s) => s.id === c1.id) && r.body.students.some((s) => s.id === x1.id));
const rpcC = await rest(C.token, "POST", "/rest/v1/rpc/firm_roster", {});
check("the function itself refuses a plain consultant", rpcC.status >= 400 && /42501/.test(JSON.stringify(rpcC.body)), `${rpcC.status}`);
const rpcS = await rest(c1.token, "POST", "/rest/v1/rpc/firm_roster", {});
check("... and a student", rpcS.status >= 400, `${rpcS.status}`);
const rpcU = await rest(await user("tset-pending", "counselor", { approved: false }).then((u) => u.token), "POST", "/rest/v1/rpc/firm_roster", {});
check("... and an unapproved counselor", rpcU.status >= 400, `${rpcU.status}`);
// Names only: the owner still can't open a colleague's student.
r = await call(O.token, "GET", `/tasks?studentId=${c1.id}`);
check("the roster doesn't widen who can open a student", r.status === 404 || r.status === 403, `${r.status}`);
const peek = await rest(O.token, "GET", `/rest/v1/deliverables?student_id=eq.${c1.id}&select=id`);
check("RLS still hides a colleague's student's tasks", peek.status === 200 && peek.body.length === 0, JSON.stringify(peek.body).slice(0, 100));

// A pending consultant's students are not on the roster.
const P = await user("tset-pending-member", "counselor", { approved: false });
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firm}', '${P.id}', 'counselor')`);
await sql(`update public.profiles set firm_id = '${firm}' where id = '${P.id}'`);
const p1 = await studentOf(P, "tset-p1");
r = await call(O.token, "GET", "/management/firm-roster");
check("an unapproved consultant's students are left off", r.status === 200 && !r.body.students.some((s) => s.id === p1.id) && r.body.students.some((s) => s.id === c1.id));

// A shared set stops being readable when its owner leaves the firm.
const L = await user("tset-leaver");
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firm}', '${L.id}', 'counselor')`);
await sql(`update public.profiles set firm_id = '${firm}' where id = '${L.id}'`);
const ls = await call(L.token, "POST", "/task-sets", { name: "Leaver's", items: [{ title: "A" }], shared: true });
check("the colleague reads the leaver's shared set", (await call(O.token, "GET", "/task-sets")).body.some((s) => s.id === ls.body.id));
await sql(`delete from public.firm_members where firm_id = '${firm}' and profile_id = '${L.id}'`);
await sql(`update public.profiles set firm_id = null where id = '${L.id}'`);
check("... and not after the owner left the firm", !(await call(O.token, "GET", "/task-sets")).body.some((s) => s.id === ls.body.id));
const peekSet = await rest(O.token, "GET", `/rest/v1/task_sets?id=eq.${ls.body.id}&select=id`);
check("... RLS agrees", peekSet.status === 200 && peekSet.body.length === 0, JSON.stringify(peekSet.body));

// The Create task button is unchanged.
r = await call(C.token, "POST", "/tasks", { studentId: c4.id, title: "One-off", stages: [{ name: "Step", dueDate: plus14 }], notifyEmail: false });
check("POST /tasks still creates a task", r.status === 201 && r.body.title === "One-off" && r.body.stages?.length === 1, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
check("... without a set marker", (await sql(`select coalesce(task_set_id::text, 'none') from public.deliverables where id = '${r.body.id}'`)) === "none");

void otherFirm;
