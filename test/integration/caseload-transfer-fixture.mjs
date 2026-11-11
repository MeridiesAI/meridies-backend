// A realistic firm for caseload transfer (spec 2026-10-15-caseload-transfer-design.md),
// built through the API where the app writes through the API, and through SQL where
// the app writes through PostgREST. Used by caseload-transfer-access.test.mjs, and by
// hand before driving the transfer popup in the app (see that file).
//
//   owner O, consultants A and B; A has `studentCount` students, each with guardians,
//   a private note, meeting notes, a past and an upcoming meeting (one on A's Google
//   calendar), files in Storage with documents rows in the student folder and in a
//   custom subfolder, a link, tasks with stages, a college list with recommendations
//   and results, essays with versions and marks, a scheduled and a sent message, a
//   queued parent alert, open My Work Queue items, an upcoming calendar entry and a
//   Management task. The first student also became a student from a pipeline contact
//   on a stage A set up, and A has another lead on it.
//
// Every account's address ends in @transfer-test.local, so a seeded firm is easy to find
// and `cleanupFirm` removes it.
import { createHash } from "node:crypto";
import { ANON, SB, call, rest, sql } from "./harness.mjs";

const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
export const DOMAIN = "transfer-test.local";
const q = (s) => String(s).replace(/'/g, "''");
const one = (query) => sql(query);

async function account(tag, name, role, run) {
  const email = `${tag}-${run}@${DOMAIN}`;
  const password = `pw-${Math.random().toString(36).slice(2)}-Aa1!`;
  let r = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: svc, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: name, role } }) });
  const u = await r.json();
  if (!r.ok) throw new Error("create user " + JSON.stringify(u));
  r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const t = await r.json();
  if (!r.ok) throw new Error("login " + JSON.stringify(t));
  await fetch(`${SB}/rest/v1/rpc/confirm_user_role`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_role: role }) });
  await sql(`update public.profiles set full_name = '${q(name)}', onboarding_complete = true where id = '${u.id}'`);
  if (role === "counselor") await sql(`update public.profiles set counselor_approved_at = now(), counselor_approved_via = 'team' where id = '${u.id}'`);
  return { id: u.id, email, password, token: t.access_token, name };
}

/** A fresh access token (a long run outlives the first one). */
export async function signIn(u) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.password }) });
  const t = await r.json();
  if (!r.ok) throw new Error("login " + JSON.stringify(t));
  u.token = t.access_token;
  return u;
}

/** Join the firm the real way: the owner invites, the colleague accepts with the link's token. */
async function joinFirm(owner, u) {
  const inv = await call(owner.token, "POST", "/firms/mine/invites", { email: u.email });
  if (inv.status !== 201) throw new Error(`firm invite ${inv.status} ${JSON.stringify(inv.body)}`);
  // The token only travels in the email: give the invitation one we know.
  const token = `t11-${inv.body.id}-${Math.random().toString(36).slice(2)}`;
  await sql(`update public.firm_invitations set token_hash = '${createHash("sha256").update(token).digest("hex")}' where id = '${inv.body.id}'`);
  const j = await call(u.token, "POST", "/firms/join", { token });
  if (j.status !== 200) throw new Error(`firm join ${j.status} ${JSON.stringify(j.body)}`);
}

async function inviteAndAccept(counselor, student) {
  const r = await call(counselor.token, "POST", "/invites", { email: student.email, fullName: student.name });
  if (r.status !== 201) throw new Error(`invite ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.invitation?.id ?? r.body.id;
  const token = await sql(`select token from public.invitations where id = '${id}'`);
  const acc = await rest(student.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: token });
  if (acc.status !== 200) throw new Error(`accept ${acc.status} ${JSON.stringify(acc.body)}`);
  return id;
}

/** Upload to the documents bucket as `u` (the app's path: {studentId}/{time}-{name}). */
async function upload(u, path, text) {
  const r = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${u.token}`, "Content-Type": "text/plain" },
    body: text,
  });
  if (!r.ok) throw new Error(`upload ${path} ${r.status} ${await r.text()}`);
}

async function addFile(u, studentId, name, { folderId, kind = "other", forStudent = true } = {}) {
  const path = `${studentId}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${name}`;
  await upload(u, path, `${name} for ${studentId}`);
  const r = await call(u.token, "POST", "/files/documents", {
    bucket: "student-documents",
    storagePath: path,
    filename: name,
    mimeType: "text/plain",
    sizeBytes: 40,
    kind,
    ...(forStudent ? { studentId } : {}),
    ...(folderId ? { folderId } : {}),
  });
  if (r.status !== 201) throw new Error(`register ${name} ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id, path };
}

const FIRST = ["Maya", "Leo", "Priya", "Sam", "Ava", "Noah", "Zoe", "Eli", "Ivy", "Omar", "Ruth", "Kai"];
const LAST = ["Chen", "Okafor", "Raman", "Lopez", "Kim", "Brooks", "Haddad", "Nguyen", "Silva", "Patel", "Stein", "Moreno"];
const COLLEGES = [["Cornell University", "reach", "ED"], ["University of Michigan", "target", "EA"], ["Tufts University", "reach", "RD"]];

/**
 * The firm. Returns { run, firmId, O, A, B, students: [{ id, name, email, token, folderId, subFolderId,
 * files: [{id, path}], ownFile, ... }], ids: {...} }.
 */
export async function seedFirm({ studentCount = 10, run = `${Date.now()}` } = {}) {
  const O = await account("owner", "Olive Owner", "counselor", run);
  const A = await account("alex", "Alex Avery", "counselor", run);
  const B = await account("blair", "Blair Bishop", "counselor", run);
  const created = await call(O.token, "POST", "/firms", { name: `Transfer Test Firm ${run}` });
  if (created.status !== 201) throw new Error(`firm ${created.status} ${JSON.stringify(created.body)}`);
  const firmId = created.body.firmId;
  await joinFirm(O, A);
  await joinFirm(O, B);

  // B already has a student of their own (a receiver is rarely empty).
  const bOwn = await account("blair-student", "Bea Own", "student", run);
  await inviteAndAccept(B, bOwn);

  const students = [];
  for (let i = 0; i < studentCount; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
    const s = await account(`stu${i}`, name, "student", run);
    await inviteAndAccept(A, s);
    await sql(`update public.profiles set grad_year = ${2027 + (i % 2)} where id = '${s.id}'`);
    const folderId = await one(`select id from public.folders where owner_id = '${A.id}' and student_id = '${s.id}' and kind = 'student'`);
    // A custom subfolder in the student folder, with an unattached draft in it.
    const sub = await call(A.token, "POST", "/files/folders", { name: "Essay drafts", parentId: folderId });
    if (sub.status !== 201) throw new Error(`subfolder ${sub.status} ${JSON.stringify(sub.body)}`);
    const files = [
      await addFile(A, s.id, "transcript.txt", { kind: "transcript" }),
      await addFile(A, s.id, "rec-letter.txt", { kind: "recommendation-letter" }),
      await addFile(A, s.id, "draft-notes.txt", { folderId: sub.body.id, forStudent: false }),
    ];
    // The student's own upload (theirs; B must still read it).
    const ownFile = await addFile(s, s.id, "my-resume.txt", { kind: "resume" });
    await sql(`insert into public.document_links (owner_id, student_id, folder_id, url, title) values ('${A.id}', '${s.id}', '${folderId}', 'https://example.com/${run}/${i}', 'Common App portal')`);

    await sql(`insert into public.guardians (student_id, full_name, email, relationship, is_primary) values
      ('${s.id}', 'Parent One ${i}', 'parent1-${i}-${run}@${DOMAIN}', 'mother', true),
      ('${s.id}', 'Parent Two ${i}', 'parent2-${i}-${run}@${DOMAIN}', 'father', false)`);
    await sql(`insert into public.student_private_notes (student_id, body, updated_by) values ('${s.id}', 'Private: anxious about essays (${i})', '${A.id}')
      on conflict (student_id) do update set body = excluded.body, updated_by = excluded.updated_by`);
    await sql(`insert into public.meeting_notes (student_id, counselor_id, title, body, meeting_date) values ('${s.id}', '${A.id}', 'Kickoff', 'Talked through the list', current_date - 14)`);
    await sql(`insert into public.meetings (student_id, counselor_id, title, starts_at, status) values ('${s.id}', '${A.id}', 'Intro call', now() - interval '14 days', 'held')`);
    await sql(`insert into public.meetings (student_id, counselor_id, title, starts_at, ${i === 0 ? "calendar_provider, calendar_event_id, join_url," : ""} status)
      values ('${s.id}', '${A.id}', 'Essay review', now() + interval '${3 + i} days', ${i === 0 ? `'google', 'evt-${run}', 'https://meet.google.com/abc-defg-hij',` : ""} 'scheduled')`);

    // Tasks with stages (the student's application tasks), one done stage each.
    const task = await one(`with d as (insert into public.deliverables (student_id, kind, title, status, due_date, assigned_by, created_by, source)
      values ('${s.id}', 'essay', 'Personal statement', 'in-progress', current_date + 20, '${A.id}', '${A.id}', 'counselor') returning id) select id from d`);
    await sql(`insert into public.deliverable_stages (deliverable_id, student_id, name, sequence, done, done_at, completed_by) values
      ('${task}', '${s.id}', 'Brainstorm', 1, true, now() - interval '3 days', '${A.id}'),
      ('${task}', '${s.id}', 'First draft', 2, false, null, null),
      ('${task}', '${s.id}', 'Final', 3, false, null, null)`);
    await sql(`insert into public.deliverable_documents (deliverable_id, document_id, student_id, added_by) values ('${task}', '${files[0].id}', '${s.id}', '${A.id}')`);

    // College list, recommendations and a result.
    for (const [n, fit, round] of COLLEGES) {
      await sql(`insert into public.student_colleges (student_id, name, fit, round, status, added_by) values ('${s.id}', '${q(n)}', '${fit}', '${round}', 'in-progress', '${A.id}')`);
    }
    await sql(`insert into public.student_college_recommendations (student_id, name, fit, why, recommended_by) values ('${s.id}', 'Rice University', 'target', 'Strong engineering fit', '${A.id}')`);
    await sql(`insert into public.admission_outcomes (counselor_id, firm_id, student_id, student_name, high_school_name, cycle, college_name, round, result)
      values ('${A.id}', '${firmId}', '${s.id}', '${q(name)}', 'Lincoln High', '2026-2027', 'University of Michigan', 'EA', 'admitted')`);

    // Essays with versions and a counselor mark.
    const essay = await one(`with e as (insert into public.essays (student_id, title, prompt, body, word_count, status) values ('${s.id}', 'Common App essay', 'Tell us your story', 'My grandmother taught me to fix radios.', 7, 'drafting') returning id) select id from e`);
    await sql(`insert into public.essay_versions (essay_id, student_id, body, word_count, created_by) values
      ('${essay}', '${s.id}', 'First try.', 2, '${s.id}'), ('${essay}', '${s.id}', 'My grandmother taught me to fix radios.', 7, '${A.id}')`);
    await sql(`insert into public.essay_marks (student_id, essay_id, dimension, severity, start_offset, end_offset, quoted_text, comment, created_by, author_id)
      values ('${s.id}', '${essay}', 'content', 'minor', 0, 2, 'My', 'Open stronger', 'counselor', '${A.id}')`);

    // Communication: one scheduled (cancelled by a transfer), one sent (moves); a queued parent alert (cancelled).
    await sql(`insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status, scheduled_for) values
      ('${s.id}', '${A.id}', 'student', 'email', '[{"kind":"student","email":"${s.email}"}]', 'Next week', 'See you Tuesday', 'scheduled', now() + interval '2 days'),
      ('${s.id}', '${A.id}', 'student', 'email', '[{"kind":"student","email":"${s.email}"}]', 'Welcome', 'Glad to work with you', 'sent', null)`);
    await sql(`insert into public.parent_alerts (student_id, guardian_id, counselor_id, trigger, subject, body, status)
      select '${s.id}', g.id, '${A.id}', 'manual', 'Essay deadline', 'Two weeks to go', 'queued' from public.guardians g where g.student_id = '${s.id}' and g.is_primary`);

    // Open work and calendar.
    await sql(`insert into public.counselor_work_items (counselor_id, student_id, title) values ('${A.id}', '${s.id}', 'Review essay draft')`);
    await sql(`insert into public.calendar_events (owner_id, student_id, title, on_date) values ('${A.id}', '${s.id}', 'Check-in', current_date + 5)`);
    const mt = await one(`with t as (insert into public.consultant_tasks (firm_id, assignee_id, assigned_by, title, student_id, student_name) values ('${firmId}', '${A.id}', '${O.id}', 'Call ${q(name)}''s family', '${s.id}', '${q(name)}') returning id) select id from t`);
    await sql(`insert into public.consultant_tasks (firm_id, assignee_id, assigned_by, parent_id, title) values ('${firmId}', '${A.id}', '${O.id}', '${mt}', 'Send the timeline')`);

    students.push({ ...s, folderId, subFolderId: sub.body.id, files, ownFile, taskId: task, essayId: essay });
  }

  // The first student came in through the firm's Contact Pipeline, on a stage A set up.
  const stageId = await one(`with s as (insert into public.pipeline_stages (firm_id, counselor_id, name) values ('${firmId}', '${A.id}', 'Signed') returning id) select id from s`);
  const contactId = await one(`with c as (insert into public.pipeline_contacts (firm_id, counselor_id, stage_id, owner_id, student_name, parent_email)
    values ('${firmId}', '${A.id}', '${stageId}', '${A.id}', '${q(students[0].name)}', 'lead-${run}@${DOMAIN}') returning id) select id from c`);
  await sql(`update public.pipeline_contacts set student_id = '${students[0].id}' where id = '${contactId}'`);
  // And a lead A is still working, not a student yet.
  const leadId = await one(`with c as (insert into public.pipeline_contacts (firm_id, counselor_id, stage_id, owner_id, student_name, parent_email)
    values ('${firmId}', '${A.id}', '${stageId}', '${A.id}', 'Rosa Lead', 'lead2-${run}@${DOMAIN}') returning id) select id from c`);

  return { run, firmId, O, A, B, bOwn, students, contactId, leadId, stageId };
}

/** Every row about these students, by table, that `u` can read through PostgREST (RLS). */
export const STUDENT_TABLES = [
  "profiles?id", "guardians", "student_private_notes", "meeting_notes", "meetings", "documents", "document_links",
  "folders", "deliverables", "deliverable_stages", "deliverable_documents", "student_colleges",
  "student_college_recommendations", "admission_outcomes", "essays", "essay_versions", "essay_marks",
  "student_messages", "parent_alerts", "counselor_work_items", "calendar_events", "consultant_tasks", "pipeline_contacts",
];

export async function visible(u, ids) {
  const out = {};
  const list = ids.join(",");
  for (const t of STUDENT_TABLES) {
    const [table, col = "student_id"] = t.split("?");
    const r = await rest(u.token, "GET", `/rest/v1/${table}?${col}=in.(${list})&select=${col}`);
    out[table] = Array.isArray(r.body) ? r.body.length : `error ${r.status}`;
  }
  return out;
}

/** Can `u` download / list / delete a Storage object? */
export async function storageAccess(u, path) {
  const get = await fetch(`${SB}/storage/v1/object/authenticated/student-documents/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${u.token}` } });
  const prefix = path.split("/")[0];
  const list = await fetch(`${SB}/storage/v1/object/list/student-documents`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 100 }),
  });
  const listed = list.ok ? (await list.json()).map((o) => `${prefix}/${o.name}`) : [];
  const sign = await fetch(`${SB}/storage/v1/object/sign/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  return { read: get.ok, listed: listed.includes(path), sign: sign.ok };
}

/** Remove everything the fixture made: the students, the consultants, the firm. */
export async function cleanupFirm(firm) {
  const ids = [firm.O, firm.A, firm.B, firm.bOwn, ...firm.students].map((u) => u.id);
  // Storage refuses a direct delete from its tables: remove the objects through its API.
  const names = (await sql(`select name from storage.objects where bucket_id = 'student-documents' and split_part(name, '/', 1) in (${ids.map((i) => `'${i}'`).join(",")})`).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  if (names.length) {
    await fetch(`${SB}/storage/v1/object/student-documents`, { method: "DELETE", headers: svc, body: JSON.stringify({ prefixes: names }) }).catch(() => {});
  }
  const drop = (id) => fetch(`${SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: svc }).catch(() => {});
  for (const id of ids) if (id !== firm.O.id) await drop(id);
  // The owner's account can't go while the firm is theirs.
  await sql(`delete from public.firms where id = '${firm.firmId}'`).catch(() => {});
  await drop(firm.O.id);
}
