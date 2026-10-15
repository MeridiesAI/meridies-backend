// A counselor's whole-caseload lists (GET /tasks, GET /calendar/feed) name the
// counselor's students in the query (caseloadStudentIds in src/lib/guards.ts)
// so Postgres doesn't RLS-check every practice's rows. The filter must not
// change the answer: their own students (archived included) and the students
// shared with them are in, another practice's are out, and a caseload too big
// to name falls back to RLS alone.
import { call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const day = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const a = await user("caseload-a");
const b = await user("caseload-b");
const own = await studentOf(a, "caseload-own");
const archived = await studentOf(a, "caseload-archived");
const shared = await studentOf(b, "caseload-shared");
const other = await studentOf(b, "caseload-other");
await sql(`update public.profiles set archived_at = now() where id = '${archived.id}'`);
await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${shared.id}', '${a.id}', 'read')`);
// A write collaborator sees the same as a read one.
const c = await user("caseload-c");
const writeShared = await studentOf(c, "caseload-write");
await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${writeShared.id}', '${a.id}', 'write')`);
// A firm owner (an admin) reads only what RLS gave them before the filter: their
// own and shared students, never a member's unshared ones.
const firmId = await sql(`with f as (insert into public.firms (name, owner_id, plan, seats) values ('Caseload firm', '${a.id}', 'practice', 5) returning id) select id from f`);
await sql(`update public.profiles set firm_id = '${firmId}' where id in ('${a.id}', '${b.id}')`);
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${b.id}', 'counselor')`);

const tag = Date.now().toString(36);
const titles = {};
for (const [k, s] of Object.entries({ own, archived, shared, writeShared, other })) {
  titles[k] = `Caseload ${k} ${tag}`;
  const taskId = await sql(`with d as (insert into public.deliverables (student_id, kind, title, status, due_date, source)
    values ('${s.id}', 'custom', '${titles[k]}', 'in-progress', '${day(5)}', 'counselor') returning id) select id from d`);
  await sql(`insert into public.deliverable_stages (deliverable_id, student_id, name, due_date, sequence)
    values ('${taskId}', '${s.id}', 'Step ${k} ${tag}', '${day(3)}', 1)`);
  await sql(`insert into public.deadlines (student_id, title, type, due_date) values ('${s.id}', 'Deadline ${k} ${tag}', 'application', '${day(6)}')`);
}

const tasks = await call(a.token, "GET", "/tasks");
check("GET /tasks answers 200", tasks.status === 200, String(tasks.status));
const taskTitles = new Set((Array.isArray(tasks.body) ? tasks.body : []).map((t) => t.title));
check("tasks: own student's task is listed", taskTitles.has(titles.own));
check("tasks: archived student's task is still listed", taskTitles.has(titles.archived));
check("tasks: shared student's task is listed", taskTitles.has(titles.shared));
check("tasks: write-shared student's task is listed", taskTitles.has(titles.writeShared));
check("tasks: a firm member's unshared student's task is not", !taskTitles.has(titles.other));

const feed = await call(a.token, "GET", `/calendar/feed?from=${day(-1)}&to=${day(10)}&tz=UTC`);
check("GET /calendar/feed answers 200", feed.status === 200, String(feed.status));
const feedTitles = (feed.body?.items ?? []).map((i) => i.title).join("\n");
for (const k of ["own", "archived", "shared", "writeShared"]) {
  check(`feed: ${k} student's deadline is on it`, feedTitles.includes(`Deadline ${k} ${tag}`));
  check(`feed: ${k} student's task is on it`, feedTitles.includes(titles[k]));
}
check("feed: a firm member's unshared student's deadline is not", !feedTitles.includes(`Deadline other ${tag}`));
check("feed: a firm member's unshared student's task is not", !feedTitles.includes(titles.other));

// Student and per-student reads are unchanged.
const mine = await call(own.token, "GET", "/tasks");
check("a student still reads their own tasks", mine.status === 200 && mine.body.some((t) => t.title === titles.own) && !mine.body.some((t) => t.title === titles.shared));
const one = await call(a.token, "GET", `/tasks?studentId=${own.id}`);
check("a counselor still reads one student's tasks", one.status === 200 && one.body.length === 1 && one.body[0].title === titles.own);

// Past CASELOAD_SCOPE_MAX (250) students the list runs on RLS alone, and still answers.
const big = await user("caseload-big");
const stamp = `${tag}-big`;
await sql(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'caseload-' || g || '-${stamp}@test.local', '', now(), jsonb_build_object('full_name', 'Big ' || g, 'role', 'student'), now(), now()
  from generate_series(1, 260) g`);
await sql(`update public.profiles p set counselor_id = '${big.id}', role = 'student' from auth.users u
  where u.id = p.id and u.email like 'caseload-%-${stamp}@test.local'`);
await sql(`insert into public.deliverables (student_id, kind, title, status, due_date, source)
  select id, 'custom', 'Big caseload ${tag}', 'in-progress', '${day(5)}', 'counselor' from public.profiles where counselor_id = '${big.id}' limit 3`);
const bigTasks = await call(big.token, "GET", "/tasks");
check("a 260-student caseload still lists its tasks", bigTasks.status === 200 && bigTasks.body.filter((t) => t.title === `Big caseload ${tag}`).length === 3, String(bigTasks.status));
check("…and none of anyone else's", bigTasks.status === 200 && !bigTasks.body.some((t) => Object.values(titles).includes(t.title)));
const bigFeed = await call(big.token, "GET", `/calendar/feed?from=${day(-1)}&to=${day(10)}&tz=UTC`);
check("a 260-student caseload's feed answers", bigFeed.status === 200 && (bigFeed.body?.items ?? []).filter((i) => i.title === `Big caseload ${tag}`).length === 3, String(bigFeed.status));
