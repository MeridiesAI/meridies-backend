// Student Forums (20261201000001): what the database enforces by itself (no API involved). One table,
// public.forum_posts; clients read only, the API writes with the service role. A post reaches other students only
// once approved; before that only its author and the author's ASSIGNED, approved counselor read it (never a
// collaborator, another counselor, a pending counselor or a parent).
import { ANON, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const cA = await user("forum-ca");
const cB = await user("forum-cb");
const cC = await user("forum-cc", "counselor", { approved: false });
const A1 = await studentOf(cA, "forum-a1");
const A2 = await studentOf(cA, "forum-a2");
const B1 = await studentOf(cB, "forum-b1");
const C1 = await studentOf(cC, "forum-c1");
const college = await sql(`select id from public.colleges limit 1`);
if (!college) throw new Error("no college in public.colleges to post about");

/** Insert a post as the service role would. Returns its id. */
const post = (student, status, { url } = {}) =>
  sql(`with p as (insert into public.forum_posts (student_id, college_id, kind, title, body, status, author_first, author_year, url)
    values ('${student.id}', '${college}', '${url ? "video" : "thought"}', 'Visit notes', 'The dorms are great', '${status}', 'Ana', '2027', ${url ? `'${url}'` : "null"})
    returning id) select id from p`);

const a1Pending = await post(A1, "pending");
const a1Rejected = await post(A1, "rejected");
const a1Reported = await post(A1, "reported");
const a1Approved = await post(A1, "approved", { url: "https://example.com/v" });
const a2Pending = await post(A2, "pending");
const c1Pending = await post(C1, "pending");

const ids = async (who, student) => {
  const r = await rest(who.token, "GET", `/rest/v1/forum_posts?select=id&student_id=eq.${student.id}`);
  if (r.status !== 200) return { status: r.status, ids: null };
  return { status: r.status, ids: r.body.map((x) => x.id).sort() };
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
// A refusal is PostgREST answering permission denied; a 5xx or a dropped request is not one.
const refused = (r) => r.status === 401 || r.status === 403;

// ---- The author --------------------------------------------------------------
const own = await ids(A1, A1);
check("A1 reads own pending, rejected, reported and approved rows", own.ids && same(own.ids, [a1Pending, a1Rejected, a1Reported, a1Approved]), JSON.stringify(own));

// ---- Other students: approved only, across firms ------------------------------
for (const [name, who] of [["A2 (same counselor)", A2], ["B1 (another counselor)", B1]]) {
  const r = await ids(who, A1);
  check(`${name} reads only A1's approved row`, r.ids && same(r.ids, [a1Approved]), JSON.stringify(r));
}

// ---- Counselors ---------------------------------------------------------------
const ca1 = await ids(cA, A1);
check("counselor A reads A1's pending row", ca1.ids?.includes(a1Pending), JSON.stringify(ca1));
const ca2 = await ids(cA, A2);
check("counselor A reads A2's pending row", ca2.ids?.includes(a2Pending), JSON.stringify(ca2));
const caC1 = await ids(cA, C1);
check("counselor A reads nothing of another counselor's student", caC1.ids?.length === 0, JSON.stringify(caC1));
const cb1 = await ids(cB, A1);
check("counselor B reads none of A1's rows", cb1.ids?.length === 0, JSON.stringify(cb1));
const cc1 = await ids(cC, C1);
check("pending counselor C reads none of their own student's rows", cc1.ids?.length === 0, JSON.stringify(cc1));

// ---- A read-only collaborator is not the assigned counselor --------------------
await sql(`insert into public.student_collaborators (student_id, counselor_id, access, granted_by) values ('${A1.id}', '${cB.id}', 'read', '${cA.id}')`);
check("...(B is now a collaborator on A1: can_view_student says yes)", (await sql(`select private.can_view_student('${A1.id}', '${cB.id}')`)) === "t");
const cbCollab = await ids(cB, A1);
check("a read-only collaborator (counselor B) does not read A1's pending post", cbCollab.ids !== null && !cbCollab.ids.includes(a1Pending), JSON.stringify(cbCollab));

// ---- The assigned-counselor helper ---------------------------------------------
const assigned = (s, v) => sql(`select private.forum_is_assigned_counselor('${s.id}', '${v.id}')`);
check("forum_is_assigned_counselor(A1, counselor A) is true", (await assigned(A1, cA)) === "t");
check("forum_is_assigned_counselor(A1, A1) is false (the author is not their own counselor)", (await assigned(A1, A1)) === "f");
check("forum_is_assigned_counselor(A1, counselor B) is false (collaborator)", (await assigned(A1, cB)) === "f");
check("forum_is_assigned_counselor(C1, pending counselor C) is false", (await assigned(C1, cC)) === "f");

// ---- Nobody writes from a client -----------------------------------------------
const row = (id) => sql(`select status || '|' || title || '|' || coalesce(reviewed_by::text, '-') from public.forum_posts where id = '${id}'`);
const before = await row(a1Pending);
const count = () => sql(`select count(*) from public.forum_posts where student_id = '${A1.id}'`);
const n0 = await count();
const ins = await rest(A1.token, "POST", "/rest/v1/forum_posts", { student_id: A1.id, college_id: college, kind: "thought", title: "Mine", body: "x", status: "approved", author_first: "Ana" });
check("A1 cannot insert a post", refused(ins) && (await count()) === n0, `status ${ins.status}`);
for (const [name, who] of [["A1 (author)", A1], ["counselor A", cA], ["collaborator B", cB]]) {
  const p = await rest(who.token, "PATCH", `/rest/v1/forum_posts?id=eq.${a1Pending}`, { status: "approved", reviewed_by: who.id });
  check(`${name} cannot approve A1's pending post`, refused(p) && (await row(a1Pending)) === before, `status ${p.status}`);
}
const del = await rest(A1.token, "DELETE", `/rest/v1/forum_posts?id=eq.${a1Pending}`);
check("A1 cannot delete a post", refused(del) && (await row(a1Pending)) === before, `status ${del.status}`);

// ---- Parents and anonymous -----------------------------------------------------
const parent = await user("forum-parent", "student");
const parentEmail = parent.email.toLowerCase();
// As parent_invite_redeem would: role 'parent', linked by a guardian row on A1.
await sql(`update public.profiles set role = 'parent', role_confirmed = true, onboarding_complete = true, parent_email = '${parentEmail}' where id = '${parent.id}'`);
await sql(`insert into public.guardians (student_id, full_name, email, alerts_enabled) values ('${A1.id}', 'Parent', '${parentEmail}', true)`);
const pr = await rest(parent.token, "GET", `/rest/v1/forum_posts?select=id`);
check("A1's parent reads nothing", pr.status === 200 && Array.isArray(pr.body) && pr.body.length === 0, `status ${pr.status} ${JSON.stringify(pr.body).slice(0, 120)}`);
const an = await rest(ANON, "GET", `/rest/v1/forum_posts?select=id`);
check("anonymous reads nothing", refused(an), `status ${an.status}`);

// ---- Who reported or reviewed a post is never client-readable (column grant) ------
// A post reported by B1 and then re-approved by counselor A: reported_by stays on the row as the record.
const reapproved = await post(A1, "approved");
await sql(`update public.forum_posts set reported_by = '${B1.id}', reported_at = null, reviewed_by = '${cA.id}', reviewed_at = now() where id = '${reapproved}'`);
check("...(the row keeps reported_by and reviewed_by)", (await sql(`select (reported_by = '${B1.id}') and (reviewed_by = '${cA.id}') from public.forum_posts where id = '${reapproved}'`)) === "t");
// 42501 is Postgres' permission denied; PostgREST answers it 401 (anon) or 403 (a signed-in role).
const permissionDenied = (r) => refused(r) && r.body?.code === "42501";
for (const [name, who] of [["the author", A1], ["another student", A2]]) {
  for (const cols of ["reported_by", "reviewed_by", "*"]) {
    const r = await rest(who.token, "GET", `/rest/v1/forum_posts?select=${encodeURIComponent(cols)}&id=eq.${reapproved}`);
    check(`${name}: select=${cols} is refused (permission denied)`, permissionDenied(r), `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  const ok = await rest(who.token, "GET", `/rest/v1/forum_posts?select=id,student_id,status,title,reported_at,review_note&id=eq.${reapproved}`);
  check(`${name}: the granted columns still read (so the refusals aren't an outage)`, ok.status === 200 && ok.body?.length === 1 && ok.body[0].id === reapproved, `status ${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`);
}

// ---- Check constraints -----------------------------------------------------------
const refusedBy = async (q, re) => {
  try {
    await sql(q);
    return false;
  } catch (e) {
    return re.test(String(e.stderr ?? e.message));
  }
};
const ins2 = (cols, vals) =>
  `insert into public.forum_posts (student_id, college_id, author_first, ${cols}) values ('${A1.id}', '${college}', 'Ana', ${vals})`;
const CHECK = /violates check constraint/;
check("...(baseline: a valid video post inserts)", !(await refusedBy(ins2("kind, title, url", `'video', 'Tour', 'https://example.com/t'`), /./)));
check("a video post without a url is refused", await refusedBy(ins2("kind, title", `'video', 'Tour'`), CHECK));
check("an http:// url is refused", await refusedBy(ins2("kind, title, url", `'video', 'Tour', 'http://x'`), CHECK));
check("a 2,001-character url is refused", await refusedBy(ins2("kind, title, url", `'video', 'Tour', 'https://${"a".repeat(1993)}'`), CHECK));
check("a blank title is refused", await refusedBy(ins2("kind, title, body", `'food', '   ', 'x'`), CHECK));
check("a thought with a blank body is refused", await refusedBy(ins2("kind, title, body", `'thought', 'Hi', '  '`), CHECK));
check("an unknown status is refused", await refusedBy(ins2("kind, title, body, status", `'food', 'Hi', 'x', 'live'`), CHECK));
check("a bad author_year is refused", await refusedBy(ins2("kind, title, body, author_year", `'food', 'Hi', 'x', '27'`), CHECK));

// ---- Shape -----------------------------------------------------------------------
check("RLS is on", (await sql(`select relrowsecurity from pg_class where oid = 'public.forum_posts'::regclass`)) === "t");
check("authenticated holds no table-wide privilege",
  (await sql(`select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'forum_posts' and grantee = 'authenticated'`)) === "0");
check("authenticated selects exactly the FORUM_COLUMNS columns, never reported_by / reviewed_by / reviewed_at",
  (await sql(`select string_agg(column_name || ':' || privilege_type, ',' order by column_name) from information_schema.column_privileges where table_schema = 'public' and table_name = 'forum_posts' and grantee = 'authenticated'`)) ===
    ["author_first", "author_year", "body", "college_id", "created_at", "id", "kind", "reported_at", "review_note", "status", "student_id", "title", "updated_at", "url"].map((c) => `${c}:SELECT`).join(","));
check("anon holds nothing", (await sql(`select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'forum_posts' and grantee = 'anon'`)) === "0");
const upd0 = await sql(`select updated_at from public.forum_posts where id = '${a2Pending}'`);
await sql(`update public.forum_posts set review_note = 'ok' where id = '${a2Pending}'`);
check("updated_at moves on update", (await sql(`select updated_at > '${upd0}'::timestamptz from public.forum_posts where id = '${a2Pending}'`)) === "t");
