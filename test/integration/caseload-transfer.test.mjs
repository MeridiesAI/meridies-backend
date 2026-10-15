// Caseload transfer (spec 2026-10-15-caseload-transfer-design.md), as real
// accounts on a local Supabase against a running API (see harness.mjs).
//
//   owner A, admin Ad, consultants B C D F G H, pending P (all in one firm),
//   solo E, and students. B's whole caseload goes to C and B is removed;
//   F's is split across C and D and partly kept; G has only archived
//   students; H is revoked. Every per-student table is checked to follow.
import { API, ANON, CLIENT, SB, call, check, rest, sql, user } from "./harness.mjs";
import { addChange, addItem, q } from "./imports-helpers.mjs";

const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tag = Date.now();
const one = async (query) => sql(query);
const count = async (query) => Number(await sql(query));

async function joinFirm(firmId, u, seat = "counselor") {
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${u.id}', '${seat}') on conflict do nothing`);
  await sql(`update public.profiles set firm_id = '${firmId}' where id = '${u.id}'`);
}

async function inviteAndAccept(counselor, student, extra = {}) {
  const r = await call(counselor.token, "POST", "/invites", { email: student.email, fullName: student.name ?? "Student", ...extra });
  if (r.status !== 201) throw new Error(`invite ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.invitation?.id ?? r.body.id;
  const token = await sql(`select token from public.invitations where id = '${id}'`);
  const acc = await rest(student.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: token });
  if (acc.status !== 200) throw new Error(`accept ${acc.status} ${JSON.stringify(acc.body)}`);
  return id;
}

const slug = (name) => "ct-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function studentOf(counselor, name) {
  const s = await user(slug(name), "student");
  await sql(`update public.profiles set counselor_id = '${counselor.id}', full_name = '${q(name)}' where id = '${s.id}'`);
  return { ...s, name };
}

async function namedStudent(name) {
  const s = await user(slug(name), "student");
  await sql(`update public.profiles set full_name = '${q(name)}' where id = '${s.id}'`);
  return { ...s, name };
}

const counselorOf = (s) => one(`select counselor_id from public.profiles where id = '${s.id}'`);
const hasNoEmail = (body) => !/@/.test(JSON.stringify(body));

// ---------------------------------------------------------------------------
// The firm
// ---------------------------------------------------------------------------
const A = await user("ct-owner");
const created = await call(A.token, "POST", "/firms", { name: `Transfer firm ${tag}` });
check("the owner starts a firm", created.status === 201, JSON.stringify(created.body));
const firmId = created.body.firmId;
const Ad = await user("ct-admin");
const B = await user("ct-bea");
const C = await user("ct-cal");
const D = await user("ct-dee");
const F = await user("ct-fay");
const G = await user("ct-gus");
const H = await user("ct-hal");
const P = await user("ct-pending", "counselor", { approved: false });
const E = await user("ct-solo");
for (const [u, n] of [[A, "Ann Owner"], [Ad, "Ada Admin"], [B, "Bea Brook"], [C, "Cal Cole"], [D, "Dee Dunn"], [F, "Fay Fox"], [G, "Gus Gray"], [H, "Hal Hart"], [P, "Pat Pending"], [E, "Eve Solo"]]) {
  await sql(`update public.profiles set full_name = '${n}' where id = '${u.id}'`);
  u.name = n;
}
await joinFirm(firmId, Ad, "admin");
for (const u of [B, C, D, F, G, H, P]) await joinFirm(firmId, u);
const St = await namedStudent("Stu Dent");

// ---------------------------------------------------------------------------
// B's caseload and everything about it
// ---------------------------------------------------------------------------
const S1 = await namedStudent("Sam One");
const S3 = await namedStudent("Sid Three");
await inviteAndAccept(B, S1);
const s3Invite = await inviteAndAccept(B, S3, { source: "intake", intakeRequests: [{ id: "custom-gpa", label: "GPA" }] });
const S2 = await studentOf(B, "Sue Two");
const S4 = await studentOf(B, "Sal Four");
await sql(`update public.profiles set archived_at = now() where id = '${S4.id}'`);
const dStudent = await studentOf(D, "Dot Student");

const folderOf = (owner, s) => one(`select id from public.folders where owner_id = '${owner.id}' and student_id = '${s.id}' and kind = 'student'`);
const s1Folder = await folderOf(B, S1);
check("B has S1's student folder", !!s1Folder);
const subFolder = await one(`with f as (insert into public.folders (owner_id, parent_id, name, kind) values ('${B.id}', '${s1Folder}', 'Essays drafts', 'custom') returning id) select id from f`);
const docInSub = await one(`with d as (insert into public.documents (owner_id, student_id, folder_id, bucket, storage_path, filename, kind) values ('${B.id}', null, '${subFolder}', 'student-documents', '${B.id}/${tag}/sub.txt', 'sub.txt', 'other') returning id) select id from d`);
const docS1 = await one(`with d as (insert into public.documents (owner_id, student_id, folder_id, bucket, storage_path, filename, kind) values ('${B.id}', '${S1.id}', '${s1Folder}', 'student-documents', '${B.id}/${tag}/transcript.pdf', 'transcript.pdf', 'transcript') returning id) select id from d`);
const docDrive = await one(`with d as (insert into public.documents (owner_id, student_id, bucket, storage_path, filename, kind, source, external_provider, external_file_id) values ('${B.id}', '${S1.id}', 'student-documents', '${B.id}/${tag}/drive.txt', 'drive.txt', 'resume', 'integration', 'google', 'file${tag}') returning id) select id from d`);
await sql(`insert into public.document_links (owner_id, student_id, url, title) values ('${B.id}', '${S1.id}', 'https://example.com/a', 'A link')`);

const pastMeeting = await one(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at, status) values ('${S1.id}', '${B.id}', 'Intro', now() - interval '10 days', 'held') returning id) select id from m`);
const futureMeeting = await one(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at, calendar_provider, calendar_event_id, join_url) values ('${S1.id}', '${B.id}', 'Essay review', now() + interval '5 days', 'google', 'evt${tag}', 'https://meet.google.com/abc-defg-hij') returning id) select id from m`);
const groupB = await one(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at) values ('${S1.id}', '${B.id}', 'Group session', now() + interval '6 days') returning id) select id from m`);
await sql(`insert into public.meeting_attendees (meeting_id, student_id) values ('${groupB}', '${S2.id}')`);
await sql(`insert into public.meeting_notes (student_id, counselor_id, title) values ('${S1.id}', '${B.id}', 'Kickoff notes')`);
await sql(`insert into public.family_reports (student_id, counselor_id, title) values ('${S1.id}', '${B.id}', 'October report')`);
await sql(`insert into public.student_private_notes (student_id, body) values ('${S1.id}', 'Private read')`);
await sql(`insert into public.student_status_overrides (student_id, status) values ('${S1.id}', 'at-risk')`);
const scheduledMsg = await one(`with m as (insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status, scheduled_for) values ('${S1.id}', '${B.id}', 'student', 'email', '[{"kind":"student","email":"x@test.local"}]', 'Hi', 'Hello there', 'scheduled', now() + interval '1 day') returning id) select id from m`);
const sentMsg = await one(`with m as (insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status) values ('${S1.id}', '${B.id}', 'student', 'email', '[{"kind":"student","email":"x@test.local"}]', 'Hi', 'Sent one', 'sent') returning id) select id from m`);
const alert = await one(`with a as (insert into public.parent_alerts (student_id, counselor_id, trigger, subject, body, status, copy_student) values ('${S1.id}', '${B.id}', 'manual', 'Heads up', 'Body', 'queued', true) returning id) select id from a`);
await sql(`insert into public.research_runs (student_id, counselor_id, feature, inputs_hash, brief, status, expires_at) values ('${S1.id}', '${B.id}', 'college_list', 'h${tag}', '{}', 'succeeded', now() + interval '7 days')`);
await sql(`insert into public.accountability_settings (counselor_id, student_id) values ('${B.id}', '${S1.id}')`);
const task = await one(`with t as (insert into public.consultant_tasks (firm_id, assignee_id, assigned_by, title, student_id) values ('${firmId}', '${B.id}', '${A.id}', 'Follow up with Sam', '${S1.id}') returning id) select id from t`);
const subtask = await one(`with t as (insert into public.consultant_tasks (firm_id, assignee_id, assigned_by, parent_id, title) values ('${firmId}', '${B.id}', '${A.id}', '${task}', 'Call the family') returning id) select id from t`);
const doneTask = await one(`with t as (insert into public.consultant_tasks (firm_id, assignee_id, title, student_id, done) values ('${firmId}', '${B.id}', 'Old task', '${S1.id}', true) returning id) select id from t`);
await sql(`insert into public.counselor_work_items (counselor_id, student_id, title) values ('${B.id}', '${S1.id}', 'Open item')`);
const doneItem = await one(`with w as (insert into public.counselor_work_items (counselor_id, student_id, title, done) values ('${B.id}', '${S1.id}', 'Done item', true) returning id) select id from w`);
await sql(`insert into public.calendar_events (owner_id, student_id, title, on_date) values ('${B.id}', '${S1.id}', 'Future entry', current_date + 3)`);
const pastEntry = await one(`with e as (insert into public.calendar_events (owner_id, student_id, title, on_date) values ('${B.id}', '${S1.id}', 'Past entry', current_date - 3) returning id) select id from e`);
await sql(`insert into public.consultant_student_pins (consultant_id, student_id) values ('${B.id}', '${S1.id}')`);
await sql(`insert into public.student_collaborators (student_id, counselor_id, access, granted_by) values ('${S2.id}', '${C.id}', 'read', '${B.id}')`);
await sql(`insert into public.student_collaborators (student_id, counselor_id, access, granted_by) values ('${dStudent.id}', '${B.id}', 'read', '${D.id}')`);
await sql(`insert into public.alumni_records (student_id, counselor_id, cycle) values ('${S4.id}', '${B.id}', '2025-2026')`);
const lockedOutcome = await one(`with o as (insert into public.admission_outcomes (counselor_id, firm_id, student_id, high_school_name, cycle, college_name, round, result, locked) values ('${B.id}', '${firmId}', '${S4.id}', 'Lincoln High', '2025-2026', 'Cornell', 'RD', 'admitted', true) returning id) select id from o`);
const supplement = await one(`with s as (insert into public.supplement_docs (student_id, college_name, admission_cycle, title, owner_id, external_file_id, web_url) values ('${S1.id}', 'Cornell', '2026-2027', 'Cornell supplements', '${B.id}', 'doc${tag}', 'https://docs.google.com/document/d/doc${tag}') returning id) select id from s`);

// Pipeline: a firm stage and contact, and a solo-era contact (B before the firm).
const stage = await one(`with s as (insert into public.pipeline_stages (firm_id, counselor_id, name) values ('${firmId}', '${B.id}', 'Inquiry') returning id) select id from s`);
const contact = await one(`with c as (insert into public.pipeline_contacts (firm_id, counselor_id, stage_id, owner_id, student_name) values ('${firmId}', '${B.id}', '${stage}', '${B.id}', 'Sam family') returning id) select id from c`);
await sql(`update public.pipeline_contacts set student_id = '${S1.id}' where id = '${contact}'`);
const soloStage = await one(`with s as (insert into public.pipeline_stages (firm_id, counselor_id, name) values (null, '${B.id}', 'Solo inquiry') returning id) select id from s`);
const soloContact = await one(`with c as (insert into public.pipeline_contacts (firm_id, counselor_id, stage_id, owner_id, student_name) values (null, '${B.id}', '${soloStage}', '${B.id}', 'Old family') returning id) select id from c`);
await sql(`update public.pipeline_contacts set student_id = '${S1.id}' where id = '${soloContact}'`);

// B's practice items: a pending invitation, imports (a committed one with held
// data for S2, a solo-era one with held data for S1, one in review), and
// templates (one clashing with C's).
const pendingInvite = await one(`with i as (insert into public.invitations (counselor_id, email, token, full_name) values ('${B.id}', 'pending-${tag}@test.local', 'ct-pending-${tag}', 'New Kid') returning id) select id from i`);
const tmplClash = await one(`with t as (insert into public.import_templates (counselor_id, name, fingerprint, use_count) values ('${B.id}', 'Naviance', 'fp-clash-${tag}', 3) returning id) select id from t`);
const tmplC = await one(`with t as (insert into public.import_templates (counselor_id, name, fingerprint, use_count) values ('${C.id}', 'Naviance (Cal)', 'fp-clash-${tag}', 1) returning id) select id from t`);
const tmplOwn = await one(`with t as (insert into public.import_templates (counselor_id, name, fingerprint) values ('${B.id}', 'Scoir', 'fp-own-${tag}') returning id) select id from t`);
const impCommitted = await one(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${B.id}', 'fall.csv', 'csv', 'draft') returning id) select id from i`);
await sql(`update public.roster_imports set status = 'committed', committed_at = now(), undo_until = now() + interval '30 days', template_id = '${tmplClash}' where id = '${impCommitted}'`);
const heldS2 = await addItem(impCommitted, { studentId: S2.id, status: "awaiting_counselor", name: "Sue Two" });
await sql(`update public.import_items set held_until = now() + interval '20 days' where id = '${heldS2}'`);
const heldS2Change = await addChange(impCommitted, heldS2, { target: "student_academics", field: "sat_superscore", value: 1400, oldValue: null, decision: "keep_old" });
const appliedS2 = await addItem(impCommitted, { studentId: S2.id, status: "applied", name: "Sue Two" });
// A solo-era import: firm_id null, as if B made it before joining.
const impSolo = await one(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${B.id}', 'solo.csv', 'csv', 'complete') returning id) select id from i`);
await sql(`update public.roster_imports set firm_id = null where id = '${impSolo}'`);
const heldS1 = await addItem(impSolo, { studentId: S1.id, status: "awaiting_counselor", name: "Sam One" });
await addChange(impSolo, heldS1, { target: "student_academics", field: "act_composite", value: 33, oldValue: null, decision: "keep_old" });
const impReview = await one(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${B.id}', 'review.csv', 'csv', 'draft') returning id) select id from i`);
await sql(`update public.roster_imports set status = 'review' where id = '${impReview}'`);
await sql(`insert into public.import_files (import_id, counselor_id, storage_path, filename, kind) values ('${impReview}', '${B.id}', '${B.id}/${impReview}/f-review.csv', 'review.csv', 'sheet')`);

// ---------------------------------------------------------------------------
// Refusals change nothing
// ---------------------------------------------------------------------------
const snapshot = async () =>
  [await counselorOf(S1), await counselorOf(S2), await one(`select counselor_id from public.meetings where id = '${futureMeeting}'`),
   await count(`select count(*) from public.caseload_transfers where firm_id = '${firmId}'`)].join("|");
const before = await snapshot();
const tr = (who, from, body) => call(who.token, "POST", `/management/consultants/${from.id}/transfer`, body);

let r = await call(B.token, "GET", `/management/consultants/${B.id}/transfer-preview`);
check("a plain consultant can't preview a transfer", r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
r = await tr(B, B, { mode: "one_person", toId: C.id });
check("a plain consultant can't transfer, their own students included", r.status === 403, `${r.status}`);
r = await call(St.token, "GET", `/management/consultants/${B.id}/transfer-preview`);
check("a student is refused", r.status === 403, `${r.status}`);
r = await call(P.token, "GET", `/management/consultants/${B.id}/transfer-preview`);
check("a pending counselor is refused by the approval gate", r.status === 403 && r.body.code === "account_pending", JSON.stringify(r.body));
r = await call(E.token, "GET", `/management/consultants/${B.id}/transfer-preview`);
check("a solo counselor is told to start a firm", r.status === 409 && /Start a firm/.test(r.body.error ?? r.body.message ?? ""), JSON.stringify(r.body));
r = await tr(A, E, { mode: "one_person", toId: C.id });
check("a counselor outside the firm can't be the from side", r.status === 403 && /isn't in your firm/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
r = await tr(A, B, { mode: "one_person", toId: P.id });
check("a pending counselor can't receive", r.status === 403 && /can't receive students/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
r = await tr(A, B, { mode: "one_person", toId: E.id });
check("a counselor outside the firm can't receive", r.status === 403, `${r.status}`);
r = await tr(A, B, { mode: "one_person", toId: B.id });
check("the from consultant can't receive their own students", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await tr(A, B, { mode: "one_person", toId: St.id });
check("a student account can't receive", r.status === 403, `${r.status}`);
r = await tr(A, B, { mode: "per_student", assignments: [{ studentId: S1.id, toId: C.id }], includePracticeItems: true });
check("practice items can't move with a partial transfer", r.status === 400 && /whole caseload/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
r = await tr(A, B, { mode: "per_student", assignments: [{ studentId: dStudent.id, toId: C.id }] });
check("a student on someone else's caseload refuses the call", r.status === 409 && /no longer on/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
r = await tr(Ad, A, { mode: "one_person", toId: C.id });
check("an admin can't transfer the owner's caseload", r.status === 403 && /Only the firm owner/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
r = await rest(B.token, "POST", "/rest/v1/rpc/transfer_caseload", { p_from: B.id, p_all_to: C.id });
check("…and not through PostgREST either", r.status === 403 || r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
check("nothing changed after the refusals", (await snapshot()) === before, `${before} vs ${await snapshot()}`);

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
const preview = await call(Ad.token, "GET", `/management/consultants/${B.id}/transfer-preview`);
check("an admin previews", preview.status === 200, JSON.stringify(preview.body).slice(0, 300));
const pv = preview.body;
const ids = (xs) => new Set((xs ?? []).map((x) => x.id));
const pvStudents = ids(pv.students);
check("the preview lists every student, archived included", [S1, S2, S3, S4].every((s) => pvStudents.has(s.id)) && pvStudents.size === 4, JSON.stringify(pv.students));
const pvReceivers = ids(pv.receivers);
check("receivers are the approved members except B", [A, Ad, C, D, F, G, H].every((u) => pvReceivers.has(u.id)) && !pvReceivers.has(B.id) && !pvReceivers.has(P.id) && !pvReceivers.has(E.id), JSON.stringify(pv.receivers));
check("S3 shows as onboarding, S4 as archived and alumni", pv.students.find((s) => s.id === S3.id)?.onboarding === true && pv.students.find((s) => s.id === S4.id)?.archived === true && pv.students.find((s) => s.id === S4.id)?.alumni === true);
check("counts: meetings, held data, attention", pv.counts.meetings === 3 && pv.counts.heldImportItems === 2 && pv.attention.calendarLinkedMeetings === 1 && pv.attention.scheduledMessages === 1 && pv.attention.queuedParentAlerts === 1 && pv.attention.supplementDocs === 1 && pv.attention.driveLinkedDocuments === 1, JSON.stringify({ c: pv.counts, a: pv.attention }));
check("practice items: invitation, imports, templates, pipeline (solo-era counted apart)", pv.practiceItems.pendingInvitations === 1 && pv.practiceItems.imports === 3 && pv.practiceItems.templates === 2 && pv.practiceItems.pipelineContacts === 1 && pv.practiceItems.soloPipelineContacts === 1 && pv.practiceItems.movable === true, JSON.stringify(pv.practiceItems));
check("the preview carries no email address", hasNoEmail(pv));

// ---------------------------------------------------------------------------
// one_person: everything to C, and B leaves the firm (practice items to C)
// ---------------------------------------------------------------------------
const deliveriesBefore = await count(`select count(*) from public.message_deliveries where template like 'caseload-transfer-%'`);
r = await tr(A, B, { mode: "one_person", toId: C.id, removeAfter: true });
check("the owner transfers B's whole caseload to C and removes B", r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
const res = r.body;
check("the answer: 4 students, practice items moved, removed", res.studentCount === 4 && res.practiceItemsMoved === true && res.removed === true && res.practiceTo === C.id, JSON.stringify(res).slice(0, 300));
check("the answer carries no email address", hasNoEmail(res));
for (const s of [S1, S2, S3, S4]) check(`${s.name} is now C's`, (await counselorOf(s)) === C.id);
check("B is out of the firm", (await count(`select count(*) from public.firm_members where profile_id = '${B.id}'`)) === 0 && (await one(`select coalesce(firm_id::text, 'none') from public.profiles where id = '${B.id}'`)) === "none");
check("B's grant on D's student went with the membership", (await count(`select count(*) from public.student_collaborators where counselor_id = '${B.id}'`)) === 0);

const tblCount = (t, where) => count(`select count(*) from public.${t} where ${where}`);
check("meetings, past and future, are C's", (await tblCount("meetings", `id in ('${pastMeeting}','${futureMeeting}','${groupB}') and counselor_id = '${C.id}'`)) === 3);
check("the future meeting's calendar pointer is cleared, the join link kept", (await one(`select coalesce(calendar_event_id,'none') || '|' || join_url from public.meetings where id = '${futureMeeting}'`)) === "none|https://meet.google.com/abc-defg-hij");
check("…and it is listed to rebook", (res.attention?.calendarMeetings ?? []).some((m) => m.id === futureMeeting && m.toId === C.id));
for (const [t, col] of [["meeting_notes", "counselor_id"], ["family_reports", "counselor_id"], ["student_messages", "counselor_id"], ["research_runs", "counselor_id"], ["accountability_settings", "counselor_id"], ["supplement_docs", "owner_id"]]) {
  check(`${t} followed S1`, (await tblCount(t, `student_id = '${S1.id}' and ${col} = '${B.id}'`)) === 0 && (await tblCount(t, `student_id = '${S1.id}' and ${col} = '${C.id}'`)) >= 1);
}
check("alumni record and the locked outcome followed S4", (await tblCount("alumni_records", `student_id = '${S4.id}' and counselor_id = '${C.id}'`)) === 1 && (await one(`select counselor_id::text || '|' || locked::text from public.admission_outcomes where id = '${lockedOutcome}'`)) === `${C.id}|true`);
check("the scheduled message is cancelled with a reason; a sent one isn't", (await one(`select status || '|' || (hold_reason is not null)::text from public.student_messages where id = '${scheduledMsg}'`)) === "cancelled|true" && (await one(`select status from public.student_messages where id = '${sentMsg}'`)) === "sent");
check("the queued parent alert is cancelled", (await one(`select status from public.parent_alerts where id = '${alert}'`)) === "cancelled");
check("exactly one student folder for S1, owned by C", (await tblCount("folders", `student_id = '${S1.id}' and kind = 'student'`)) === 1 && (await folderOf(C, S1)) === s1Folder);
check("the custom subfolder and its document moved with it", (await one(`select owner_id from public.folders where id = '${subFolder}'`)) === C.id && (await one(`select owner_id from public.documents where id = '${docInSub}'`)) === C.id);
check("documents and links are C's", (await one(`select owner_id from public.documents where id = '${docS1}'`)) === C.id && (await tblCount("document_links", `student_id = '${S1.id}' and owner_id = '${C.id}'`)) === 1);
check("a drive-linked document keeps its copy, loses the live pointer", (await one(`select owner_id::text || '|' || coalesce(external_provider, 'none') from public.documents where id = '${docDrive}'`)) === `${C.id}|none`);
check("the open task and its subtask are C's; the done one stays", (await one(`select assignee_id from public.consultant_tasks where id = '${task}'`)) === C.id && (await one(`select assignee_id from public.consultant_tasks where id = '${subtask}'`)) === C.id && (await one(`select assignee_id from public.consultant_tasks where id = '${doneTask}'`)) === B.id);
check("the open work item moved, the done one stayed", (await tblCount("counselor_work_items", `student_id = '${S1.id}' and counselor_id = '${C.id}' and not done`)) === 1 && (await one(`select counselor_id from public.counselor_work_items where id = '${doneItem}'`)) === B.id);
check("future calendar entries moved, past ones stayed", (await tblCount("calendar_events", `student_id = '${S1.id}' and owner_id = '${C.id}'`)) === 1 && (await one(`select owner_id from public.calendar_events where id = '${pastEntry}'`)) === B.id);
check("B's pin on S1 is gone; C's collaborator row on S2 is gone", (await tblCount("consultant_student_pins", `consultant_id = '${B.id}'`)) === 0 && (await tblCount("student_collaborators", `student_id = '${S2.id}' and counselor_id = '${C.id}'`)) === 0);
check("the firm contact's owner and creator are C; the solo-era contact is untouched", (await one(`select owner_id::text || '|' || counselor_id::text from public.pipeline_contacts where id = '${contact}'`)) === `${C.id}|${C.id}` && (await one(`select owner_id::text || '|' || counselor_id::text from public.pipeline_contacts where id = '${soloContact}'`)) === `${B.id}|${B.id}`);
check("the firm stage is C's", (await one(`select counselor_id from public.pipeline_stages where id = '${stage}'`)) === C.id);
check("private notes and status overrides carry over (C reads them)", (await rest(C.token, "GET", `/rest/v1/student_private_notes?student_id=eq.${S1.id}&select=body`)).body?.[0]?.body === "Private read" && (await rest(C.token, "GET", `/rest/v1/student_status_overrides?student_id=eq.${S1.id}&select=status`)).body?.[0]?.status === "at-risk");
const cMeetings = await rest(C.token, "GET", `/rest/v1/meetings?student_id=eq.${S1.id}&select=id`);
const bMeetings = await rest(B.token, "GET", `/rest/v1/meetings?student_id=eq.${S1.id}&select=id`);
check("C reads S1's meetings; B no longer does", cMeetings.body?.length === 3 && Array.isArray(bMeetings.body) && bMeetings.body.length === 0, `${JSON.stringify(cMeetings.body)} / ${JSON.stringify(bMeetings.body)}`);
const cDocs = await rest(C.token, "GET", `/rest/v1/documents?student_id=eq.${S1.id}&select=id`);
check("C reads S1's documents", (cDocs.body ?? []).length === 2, JSON.stringify(cDocs.body));

// Practice items went to C.
check("B's pending invitation is C's, and its preview names C", (await one(`select counselor_id from public.invitations where id = '${pendingInvite}'`)) === C.id && (await one(`select counselor_name from public.invitation_preview('ct-pending-${tag}')`)) === "Cal Cole");
check("every import of B's is C's, in the firm (the solo-era one too)", (await tblCount("roster_imports", `id in ('${impCommitted}','${impSolo}','${impReview}') and counselor_id = '${C.id}' and firm_id = '${firmId}'`)) === 3);
check("the import in review moved with its file", (await one(`select status from public.roster_imports where id = '${impReview}'`)) === "review" && (await tblCount("import_files", `import_id = '${impReview}' and counselor_id = '${C.id}'`)) === 1);
check("template clash: C's template wins and the import points at it", (await tblCount("import_templates", `id = '${tmplClash}'`)) === 0 && (await one(`select template_id from public.roster_imports where id = '${impCommitted}'`)) === tmplC && (await one(`select use_count from public.import_templates where id = '${tmplC}'`)) === "4");
check("B's other template is C's", (await one(`select counselor_id from public.import_templates where id = '${tmplOwn}'`)) === C.id);

// Held data reached C's queue through a carrier import, and C can apply it.
const carrierS2 = await one(`select import_id from public.import_items where id = '${heldS2}'`);
check("S2's held item moved into a carrier import of C's", carrierS2 !== impCommitted && (await one(`select counselor_id::text || '|' || firm_id::text || '|' || status from public.roster_imports where id = '${carrierS2}'`)) === `${C.id}|${firmId}|committed`);
check("its staged change moved with it; the applied item stayed", (await one(`select import_id from public.import_changes where id = '${heldS2Change}'`)) === carrierS2 && (await one(`select import_id from public.import_items where id = '${appliedS2}'`)) === impCommitted);
const cQueue = await rest(C.token, "POST", "/rest/v1/rpc/import_held_queue", {});
check("C's Ready to apply shows S2's and S1's held data (S1's from a solo-era import)", [heldS2, heldS1].every((id) => (cQueue.body ?? []).some((e) => e.itemId === id)), JSON.stringify(cQueue.body).slice(0, 300));
const reqApply = await rest(C.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: heldS1, p_decisions: {} });
check("C requests apply on the solo-era held item", reqApply.status === 204 || reqApply.status === 200, `${reqApply.status} ${JSON.stringify(reqApply.body)}`);
const applied = JSON.parse(await sql(`select public.apply_held_item('${heldS1}', '${C.id}')`));
check("…and it applies", applied.status === "applied" && (await one(`select act_composite from public.student_academics where student_id = '${S1.id}'`)) === "33", JSON.stringify(applied));

// Onboarding continues with C.
const building = await call(C.token, "GET", "/invites/building");
check("S3's Building profile card is C's now", (building.body ?? []).some?.((b) => b.id === s3Invite), JSON.stringify(building.body).slice(0, 200));
const s3Intake = await call(S3.token, "GET", "/me/intake");
const gpaTask = (s3Intake.body.intake?.tasks ?? []).find((t) => t.title === "GPA");
const answered = await call(S3.token, "PATCH", `/me/intake/${gpaTask?.id}`, { answer: "3.9" });
const submitted = await call(S3.token, "POST", "/me/intake/submit", {});
check("S3 can still submit their intake", answered.status === 200 && submitted.status === 200, `${answered.status} ${submitted.status} ${JSON.stringify(submitted.body).slice(0, 200)}`);

// The record.
const transferId = res.transferId;
check("one caseload.transferred row and one per student", (await tblCount("audit_log", `action = 'caseload.transferred' and entity_id = '${B.id}'`)) === 1 && (await tblCount("audit_log", `action = 'caseload.student_transferred' and metadata->>'transfer_id' = '${transferId}'`)) === 4);
check("C has a notification", (await tblCount("notifications", `recipient_id = '${C.id}' and kind = 'system' and title like '4 students from Bea Brook%'`)) === 1);
const seen = async (u) => (await rest(u.token, "GET", `/rest/v1/caseload_transfers?id=eq.${transferId}&select=id`)).body?.length ?? 0;
check("the transfer is readable by the owner, the receiver and B; not by D", (await seen(A)) === 1 && (await seen(C)) === 1 && (await seen(B)) === 1 && (await seen(D)) === 0);
check("…and never by a student", (await seen(S1)) === 0);
const history = await call(Ad.token, "GET", "/management/transfers");
check("the history lists it for an admin", history.status === 200 && history.body.some((t) => t.id === transferId && t.studentCount === 4 && t.memberRemoved === true), JSON.stringify(history.body).slice(0, 200));
const info = await call(C.token, "GET", `/student-page/${S1.id}/info`);
check("the student page says where S1 came from", info.status === 200 && info.body.transferredFrom?.name === "Bea Brook", JSON.stringify(info.body.transferredFrom));
const ownInfo = await call(S1.token, "GET", `/student-page/${S1.id}/info`);
check("a student's own card doesn't carry it", ownInfo.status === 200 && ownInfo.body.transferredFrom === null);

// Emails (sent after the response): receiver, B, and active non-alumni students only.
let mails = 0;
for (let i = 0; i < 20 && mails < 5; i++) {
  mails = (await count(`select count(*) from public.message_deliveries where template like 'caseload-transfer-%'`)) - deliveriesBefore;
  if (mails < 5) await new Promise((ok) => setTimeout(ok, 250));
}
check("emails: C, B, and S1 S2 S3 (not archived S4)", mails === 5
  && (await tblCount("message_deliveries", `template = 'caseload-transfer-receiver' and recipient_id = '${C.id}'`)) === 1
  && (await tblCount("message_deliveries", `template = 'caseload-transfer-from' and recipient_id = '${B.id}'`)) === 1
  && (await tblCount("message_deliveries", `template = 'caseload-transfer-student' and student_id = '${S4.id}'`)) === 0
  && (await tblCount("message_deliveries", `template = 'caseload-transfer-student' and student_id in ('${S1.id}','${S2.id}','${S3.id}')`)) === 3, `mails ${mails}`);
check("no email body uses an em dash", (await tblCount("message_deliveries", `template like 'caseload-transfer-%' and body like '%' || chr(8212) || '%'`)) === 0);

// B's account is deleted later: the students' history survives.
const del = await fetch(`${SB}/auth/v1/admin/users/${B.id}`, { method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
check("B's account is deleted", del.ok, `${del.status}`);
check("…and S1's meetings, notes, messages, documents, subfolder, supplement Doc and research survive",
  (await tblCount("meetings", `student_id = '${S1.id}'`)) === 3
  && (await tblCount("meeting_notes", `student_id = '${S1.id}'`)) === 1
  && (await tblCount("student_messages", `student_id = '${S1.id}'`)) === 2
  && (await tblCount("documents", `id in ('${docS1}','${docInSub}','${docDrive}')`)) === 3
  && (await tblCount("folders", `id = '${subFolder}'`)) === 1
  && (await tblCount("supplement_docs", `id = '${supplement}'`)) === 1
  && (await tblCount("research_runs", `student_id = '${S1.id}'`)) === 1
  && (await tblCount("roster_imports", `id in ('${impCommitted}','${impSolo}','${impReview}')`)) === 3);
const otherSchool = await rest(C.token, "POST", "/rest/v1/supplement_docs", {
  student_id: S1.id, college_name: "Yale", admission_cycle: "2026-2027", title: "Yale supplements",
  owner_id: C.id, external_file_id: `yale${tag}`, web_url: `https://docs.google.com/document/d/yale${tag}`,
}, { Prefer: "return=minimal" });
check("C creates a supplement Doc for another school", otherSchool.status === 201, `${otherSchool.status} ${JSON.stringify(otherSchool.body)}`);
const replaced = await rest(C.token, "DELETE", `/rest/v1/supplement_docs?id=eq.${supplement}`, undefined, { Prefer: "return=representation" });
const again = await rest(C.token, "POST", "/rest/v1/supplement_docs", {
  student_id: S1.id, college_name: "Cornell", admission_cycle: "2026-2027", title: "Cornell supplements",
  owner_id: C.id, external_file_id: `cornell${tag}`, web_url: `https://docs.google.com/document/d/cornell${tag}`,
}, { Prefer: "return=minimal" });
check("…and may replace the moved Cornell row with a Doc of their own", (replaced.body ?? []).length === 1 && again.status === 201, `${replaced.status} ${again.status}`);

// ---------------------------------------------------------------------------
// per_student: F's caseload split across C and D, one student kept
// ---------------------------------------------------------------------------
const T1 = await studentOf(F, "Tia One");
const T2 = await studentOf(F, "Tom Two");
const T3 = await studentOf(F, "Tad Three");
const soloT1 = await one(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at) values ('${T1.id}', '${F.id}', 'T1 only', now() + interval '2 days') returning id) select id from m`);
const groupF = await one(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at) values ('${T1.id}', '${F.id}', 'T1 and T2', now() + interval '3 days') returning id) select id from m`);
await sql(`insert into public.meeting_attendees (meeting_id, student_id) values ('${groupF}', '${T2.id}')`);
const fInvite = await one(`with i as (insert into public.invitations (counselor_id, email, token) values ('${F.id}', 'f-pending-${tag}@test.local', 'ct-f-${tag}') returning id) select id from i`);
const fImport = await one(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${F.id}', 'f.csv', 'csv', 'draft') returning id) select id from i`);
const fTemplate = await one(`with t as (insert into public.import_templates (counselor_id, name, fingerprint) values ('${F.id}', 'F tmpl', 'fp-f-${tag}') returning id) select id from t`);

r = await tr(Ad, F, { mode: "per_student", assignments: [{ studentId: T1.id, toId: C.id }, { studentId: T2.id, toId: D.id }], notifyStudents: false });
check("an admin splits F's caseload (T1 to C, T2 to D)", r.status === 200 && r.body.studentCount === 2 && r.body.practiceItemsMoved === false, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
check("T1 is C's, T2 is D's, T3 stays F's", (await counselorOf(T1)) === C.id && (await counselorOf(T2)) === D.id && (await counselorOf(T3)) === F.id);
check("T1's own meeting moved to C", (await one(`select counselor_id from public.meetings where id = '${soloT1}'`)) === C.id);
check("the group meeting split across receivers stays with F and is listed", (await one(`select counselor_id from public.meetings where id = '${groupF}'`)) === F.id && (r.body.attention?.groupMeetings ?? []).some((m) => m.id === groupF));
check("a partial transfer moves no practice item", (await one(`select counselor_id from public.invitations where id = '${fInvite}'`)) === F.id && (await one(`select counselor_id from public.roster_imports where id = '${fImport}'`)) === F.id && (await one(`select counselor_id from public.import_templates where id = '${fTemplate}'`)) === F.id);
check("F stays in the firm", (await tblCount("firm_members", `profile_id = '${F.id}'`)) === 1);
check("no student was emailed (switched off)", (await tblCount("message_deliveries", `template = 'caseload-transfer-student' and student_id in ('${T1.id}','${T2.id}')`)) === 0);

r = await tr(Ad, F, { mode: "per_student", assignments: [{ studentId: T3.id, toId: C.id }, { studentId: T1.id, toId: D.id }] });
check("a stale assignment (T1 already moved) refuses the whole call", r.status === 409 && /1 student is no longer on Fay Fox's caseload/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
check("…and moves neither", (await counselorOf(T3)) === F.id && (await counselorOf(T1)) === C.id);

// Removal: refused while F has a student, released only by an owner/admin.
r = await call(A.token, "DELETE", `/firms/mine/members/${F.id}`);
check("removing F with a student left is refused", r.status === 409 && r.body.code === "caseload_not_transferred", JSON.stringify(r.body));
r = await call(F.token, "DELETE", `/firms/mine/members/${F.id}`);
check("F can't leave with their students", r.status === 409 && /Ask a firm owner or admin/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
r = await call(F.token, "DELETE", `/firms/mine/members/${F.id}?releaseStudents=true`);
check("F can't release their own students", r.status === 409, `${r.status}`);
r = await call(D.token, "DELETE", `/firms/mine/members/${F.id}?releaseStudents=true`);
check("a plain consultant can't release anyone", r.status === 403, `${r.status}`);
await sql(`insert into public.student_collaborators (student_id, counselor_id, access, granted_by) values ('${T3.id}', '${D.id}', 'read', '${F.id}')`);
r = await call(A.token, "DELETE", `/firms/mine/members/${F.id}?releaseStudents=true`);
check("the owner releases: F leaves with T3", r.status === 204 && (await counselorOf(T3)) === F.id && (await tblCount("firm_members", `profile_id = '${F.id}'`)) === 0, `${r.status} ${JSON.stringify(r.body)}`);
check("the firm's grants on the released student are gone", (await tblCount("student_collaborators", `student_id = '${T3.id}'`)) === 0);
check("the removal is audited", (await one(`select metadata->>'students_released' from public.audit_log where action = 'firm.member_removed' and entity_id = '${F.id}'`)) === "1");

// ---------------------------------------------------------------------------
// per_student covering the whole caseload, with a chosen practice receiver:
// the student's held data goes to the student's receiver, the import to Ad
// ---------------------------------------------------------------------------
const J = await user("ct-jo");
await sql(`update public.profiles set full_name = 'Jo Jay' where id = '${J.id}'`);
await joinFirm(firmId, J);
const J1 = await studentOf(J, "Jen One");
const J2 = await studentOf(J, "Jem Two");
const jInvite = await one(`with i as (insert into public.invitations (counselor_id, email, token) values ('${J.id}', 'j-pending-${tag}@test.local', 'ct-j-${tag}') returning id) select id from i`);
const jImport = await one(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${J.id}', 'j.csv', 'csv', 'complete') returning id) select id from i`);
const jHeld = await addItem(jImport, { studentId: J2.id, status: "awaiting_counselor", name: "Jem Two" });
r = await tr(A, J, {
  mode: "per_student",
  assignments: [{ studentId: J1.id, toId: C.id }, { studentId: J2.id, toId: D.id }],
  practiceToId: Ad.id,
  includePracticeItems: true,
  notifyStudents: false,
});
check("a whole caseload split, with practice items to a chosen receiver", r.status === 200 && r.body.practiceItemsMoved === true && r.body.practiceTo === Ad.id && r.body.removed === false, JSON.stringify(r.body).slice(0, 300));
const jCarrier = await one(`select i.counselor_id from public.import_items it join public.roster_imports i on i.id = it.import_id where it.id = '${jHeld}'`);
check("J2's held data went to D (J2's receiver), the import to Ad", jCarrier === D.id && (await one(`select counselor_id from public.roster_imports where id = '${jImport}'`)) === Ad.id, jCarrier);
check("J's pending invitation is Ad's; J stays in the firm", (await one(`select counselor_id from public.invitations where id = '${jInvite}'`)) === Ad.id && (await tblCount("firm_members", `profile_id = '${J.id}'`)) === 1);
r = await tr(A, J, { mode: "per_student", assignments: [{ studentId: J1.id, toId: D.id }], practiceToId: P.id });
check("a practice receiver without practice items is refused", r.status === 400 || r.status === 409, `${r.status}`);

// ---------------------------------------------------------------------------
// G has only archived students: shown, refused, transferred, removed
// ---------------------------------------------------------------------------
const G1 = await studentOf(G, "Gia Archived");
await sql(`update public.profiles set archived_at = now() where id = '${G1.id}'`);
const mgmt = await call(A.token, "GET", "/management");
const gRow = (mgmt.body.consultants ?? []).find((c) => c.id === G.id);
check("Management shows G's archived student", gRow?.studentCount === 0 && gRow?.archivedCount === 1, JSON.stringify(gRow));
r = await call(A.token, "DELETE", `/firms/mine/members/${G.id}`);
check("G can't be removed with an archived student", r.status === 409 && r.body.code === "caseload_not_transferred", JSON.stringify(r.body));
r = await tr(A, G, { mode: "one_person", toId: D.id });
check("G's archived caseload transfers to D", r.status === 200 && (await counselorOf(G1)) === D.id, JSON.stringify(r.body).slice(0, 200));
r = await call(A.token, "DELETE", `/firms/mine/members/${G.id}`);
check("…then G is removed without the flag", r.status === 204, `${r.status} ${JSON.stringify(r.body)}`);
const gDelete = await call(G.token, "DELETE", "/account", { confirm: "delete my account" });
check("G (now solo, no students) may delete their account", gDelete.status === 204 || gDelete.status === 200, `${gDelete.status}`);

// A firm member with archived students can't delete their account.
const D2 = await studentOf(D, "Dan Archived");
await sql(`update public.profiles set archived_at = now() where id = '${D2.id}'`);
await sql(`update public.profiles set archived_at = now() where id in ('${dStudent.id}', '${T2.id}', '${G1.id}')`);
const dDelete = await call(D.token, "DELETE", "/account", { confirm: "delete my account" });
check("a firm member with only archived students can't delete their account", dDelete.status === 409 && /transfer them/.test(JSON.stringify(dDelete.body)), JSON.stringify(dDelete.body));

// ---------------------------------------------------------------------------
// Revoked from: H's access is revoked, the firm can still move H's students
// ---------------------------------------------------------------------------
const H1 = await studentOf(H, "Hana One");
await sql(`select private.revoke_counselor_access('${H.id}')`);
r = await tr(A, H, { mode: "one_person", toId: Ad.id });
check("a revoked consultant's students can still be transferred", r.status === 200 && (await counselorOf(H1)) === Ad.id, JSON.stringify(r.body).slice(0, 200));

// ---------------------------------------------------------------------------
// The firm setting
// ---------------------------------------------------------------------------
let pol = await call(C.token, "GET", "/firms/mine/caseload-policy");
check("any member reads the setting; default per_student", pol.status === 200 && pol.body.mode === "per_student" && pol.body.canEdit === false, JSON.stringify(pol.body));
r = await call(C.token, "PATCH", "/firms/mine/caseload-policy", { mode: "one_person" });
check("a plain consultant can't change it", r.status === 403, `${r.status}`);
r = await call(A.token, "PATCH", "/firms/mine/caseload-policy", { mode: "one_person", defaultReceiverId: P.id });
check("a pending counselor can't be the default receiver", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await call(A.token, "PATCH", "/firms/mine/caseload-policy", { mode: "one_person", defaultReceiverId: D.id });
check("the owner sets one_person with D", r.status === 200 && r.body.mode === "one_person" && r.body.defaultReceiverId === D.id, JSON.stringify(r.body));
const pv2 = await call(A.token, "GET", `/management/consultants/${C.id}/transfer-preview`);
check("the preview carries the setting", pv2.body.policy?.mode === "one_person" && pv2.body.policy?.defaultReceiverId === D.id, JSON.stringify(pv2.body.policy));
r = await call(E.token, "GET", "/firms/mine/caseload-policy");
check("a solo counselor has no firm setting", r.status === 200 && r.body.firmId === null && r.body.canEdit === false);
const direct = await rest(C.token, "PATCH", `/rest/v1/practice_settings?firm_id=eq.${firmId}`, { caseload_transfer_mode: "per_student" }, { Prefer: "return=representation" });
check("…and not through PostgREST (RLS)", Array.isArray(direct.body) ? direct.body.length === 0 : direct.status >= 400, JSON.stringify(direct.body));

// ---------------------------------------------------------------------------
// Every cascading counselor-owned student table is decided
// ---------------------------------------------------------------------------
const HANDLED = new Set([
  "meetings.counselor_id", "meeting_notes.counselor_id", "family_reports.counselor_id", "opportunity_requests.counselor_id",
  "student_messages.counselor_id", "research_runs.counselor_id", "alumni_records.counselor_id", "admission_outcomes.counselor_id",
  "referrals.counselor_id", "library_resource_pins.counselor_id", "accountability_settings.counselor_id", "folders.owner_id",
  "documents.owner_id", "document_links.owner_id", "supplement_docs.owner_id", "calendar_events.owner_id",
  "counselor_work_items.counselor_id", "consultant_tasks.assignee_id", "pipeline_contacts.counselor_id",
  "consultant_student_pins.consultant_id", "student_collaborators.counselor_id",
]);
// Deliberately stays with the counselor (spec §6.7): personal working notes and notices.
const STAYS = new Set(["ai_conversations.owner_id", "axis_actions.owner_id", "notifications.recipient_id"]);
const fks = (await sql(`
  select c.conrelid::regclass::text || '.' || a.attname
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and c.confdeltype = 'c'
     and c.connamespace = 'public'::regnamespace
     and a.attname not in ('student_id', 'from_student_id')
     and exists (select 1 from pg_attribute s where s.attrelid = c.conrelid and s.attname in ('student_id', 'from_student_id') and not s.attisdropped)
   order by 1`)).split("\n").filter(Boolean);
const undecided = fks.filter((k) => !HANDLED.has(k) && !STAYS.has(k));
check("every cascading counselor-owned column on a student table is handled or on the stays list", undecided.length === 0, undecided.join(", "));

// ---------------------------------------------------------------------------
// Before the migration: the student page still answers (transferredFrom null)
// ---------------------------------------------------------------------------
await sql(`alter table public.caseload_transfer_students rename to caseload_transfer_students_hidden; notify pgrst, 'reload schema'`);
try {
  await new Promise((ok) => setTimeout(ok, 1500));
  const degraded = await call(C.token, "GET", `/student-page/${S1.id}/info`);
  check("with the table missing the info card answers 200, transferredFrom null", degraded.status === 200 && degraded.body.transferredFrom === null, `${degraded.status} ${JSON.stringify(degraded.body.transferredFrom)}`);
  const hist = await call(A.token, "GET", "/management/transfers");
  check("…and the history answers 503 caseload_transfer_unavailable", hist.status === 503 && hist.body.code === "caseload_transfer_unavailable", `${hist.status} ${JSON.stringify(hist.body)}`);
} finally {
  await sql(`alter table public.caseload_transfer_students_hidden rename to caseload_transfer_students; notify pgrst, 'reload schema'`);
  await new Promise((ok) => setTimeout(ok, 1000));
}

void API; void ANON; void CLIENT;
