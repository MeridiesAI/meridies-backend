// AxIS deletes through the API (20261110000004, AxIS security PR B): every covered op a counselor confirms on a card
// keeps its rows in the trash, and the card's Undo (Restore) brings them back with the same ids. Proposals are written
// the way perform_action writes them (as in axis-operations.test.mjs); no model is called.
import { randomUUID } from "node:crypto";
import { SB, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const one = (q) => sql(q).then((o) => o.split("\n")[0]);
const c = await user("trash-api-c");
const s = await studentOf(c, "trash-api-s");
const conv = await call(c.token, "POST", "/chat/conversations", { studentId: s.id, tool: "axis" });
const college = await one("select id from public.colleges order by name limit 1");
const board = (await call(c.token, "GET", "/pipeline")).body;
const stageId = board?.stages?.[0]?.id;

async function propose(op, input, studentId = s.id) {
  const r = await rest(c.token, "POST", "/rest/v1/axis_actions", {
    conversation_id: conv.body.id, student_id: studentId, type: "operation", status: "pending",
    payload: { op, area: "Test", summary: `Test ${op}`, details: [], warning: null, reason: null, input },
  }, { Prefer: "return=representation" });
  if (r.status !== 201) throw new Error(`propose ${op}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}
const count = (table, where) => one(`select count(*) from public.${table} where ${where}`);
const doc = async (name = "transcript.pdf") => {
  const path = `${s.id}/trash-${randomUUID()}-${name}`;
  await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/pdf" }, body: Buffer.from("%PDF-1.4 test"),
  });
  const id = await one(`insert into public.documents (owner_id, student_id, filename, bucket, storage_path, mime_type, size_bytes, uploaded_by)
                        values ('${c.id}', '${s.id}', '${name}', 'student-documents', '${path}', 'application/pdf', 13, '${c.id}') returning id`);
  return { id, path };
};
const task = async () => (await call(c.token, "POST", "/tasks", { studentId: s.id, title: `Trash task ${randomUUID().slice(0, 6)}`, dueDate: "2026-12-01" })).body.id;

// Each covered op: how to make its target, the input, and where to look for the row.
const cases = {
  "courses.delete": async () => { const id = await one(`insert into public.courses (student_id, name) values ('${s.id}', 'AP Chemistry') returning id`); return { input: { course_id: id, student_id: s.id }, table: "courses", where: `id = '${id}'` }; },
  "test_scores.delete": async () => { const id = await one(`insert into public.test_scores (student_id, exam, kind) values ('${s.id}', 'SAT', 'sat') returning id`); return { input: { score_id: id, student_id: s.id }, table: "test_scores", where: `id = '${id}'` }; },
  "tasks.delete": async () => { const id = await task(); return { input: { task_id: id }, table: "deliverables", where: `id = '${id}'` }; },
  "tasks.delete_step": async () => { const t = await task(); const id = await one(`insert into public.deliverable_stages (deliverable_id, student_id, name, sequence) values ('${t}', '${s.id}', 'Outline', 0) returning id`); return { input: { student_id: s.id, step_id: id }, table: "deliverable_stages", where: `id = '${id}'` }; },
  "tasks.remove_handed_in_file": async () => { const t = await task(); const d = await doc("handin.pdf"); await sql(`insert into public.deliverable_documents (deliverable_id, document_id, student_id, role) values ('${t}', '${d.id}', '${s.id}', 'submission')`); return { input: { task_id: t, document_id: d.id }, table: "deliverable_documents", where: `deliverable_id = '${t}' and document_id = '${d.id}'` }; },
  "deadlines.delete": async () => { const id = (await call(c.token, "POST", "/deadlines", { studentId: s.id, title: "UC application", type: "application", dueDate: "2026-11-30" })).body.id; return { input: { deadline_id: id }, table: "deadlines", where: `id = '${id}'` }; },
  "work_queue.delete": async () => { const id = await one(`insert into public.counselor_work_items (counselor_id, student_id, title) values ('${c.id}', '${s.id}', 'Call the family') returning id`); return { input: { item_id: id }, table: "counselor_work_items", where: `id = '${id}'` }; },
  "accountability.remove_guardian": async () => { const id = await one(`insert into public.guardians (student_id, full_name, email) values ('${s.id}', 'Maria Lopez', 'maria-${randomUUID().slice(0, 8)}@families.test') returning id`); return { input: { student_id: s.id, guardian_id: id }, table: "guardians", where: `id = '${id}'` }; },
  "meetings.delete": async () => { const id = await one(`insert into public.meetings (student_id, counselor_id, title, starts_at, ends_at) values ('${s.id}', '${c.id}', 'Check-in', now() + interval '3 days', now() + interval '3 days 30 minutes') returning id`); return { input: { meeting_id: id }, table: "meetings", where: `id = '${id}'` }; },
  "calendar.delete_event_type": async () => { const id = await one(`insert into public.calendar_event_types (owner_id, name, color) values ('${c.id}', 'Office hours ${randomUUID().slice(0, 4)}', '#336699') returning id`); return { input: { event_type_id: id }, table: "calendar_event_types", where: `id = '${id}'` }; },
  "calendar.delete_event": async () => { const id = await one(`insert into public.calendar_events (owner_id, title, on_date) values ('${c.id}', 'Fair', '2026-12-05') returning id`); return { input: { event_id: id }, table: "calendar_events", where: `id = '${id}'` }; },
  "meeting_notes.delete": async () => { const id = await one(`insert into public.meeting_notes (student_id, counselor_id, title) values ('${s.id}', '${c.id}', 'Notes') returning id`); return { input: { note_id: id, student_id: s.id }, table: "meeting_notes", where: `id = '${id}'` }; },
  "college_list.remove": async () => { const id = await one(`insert into public.student_colleges (student_id, name) values ('${s.id}', 'College ${randomUUID().slice(0, 8)}') returning id`); return { input: { student_id: s.id, student_college_id: id }, table: "student_colleges", where: `id = '${id}'` }; },
  "essays.delete": async () => { const id = await one(`insert into public.essays (student_id, title, body) values ('${s.id}', 'Why us', 'A draft about the lab.') returning id`); return { input: { student_id: s.id, essay_id: id }, table: "essays", where: `id = '${id}'` }; },
  "application.delete_activity": async () => { const id = await one(`insert into public.activities (student_id, name) values ('${s.id}', 'Robotics') returning id`); return { input: { student_id: s.id, activity_id: id }, table: "activities", where: `id = '${id}'` }; },
  "application.delete_honor": async () => { const id = await one(`insert into public.awards (student_id, name) values ('${s.id}', 'Science Olympiad') returning id`); return { input: { student_id: s.id, honor_id: id }, table: "awards", where: `id = '${id}'` }; },
  "aid.delete_award_letter": async () => { const id = await one(`insert into public.award_letters (student_id, school_name) values ('${s.id}', 'Pomona College') returning id`); return { input: { award_letter_id: id, student_id: s.id }, table: "award_letters", where: `id = '${id}'` }; },
  "aid.delete_award_item": async () => { const l = await one(`insert into public.award_letters (student_id, school_name) values ('${s.id}', 'Reed College') returning id`); const id = await one(`insert into public.award_letter_items (award_letter_id, student_id, label, category) values ('${l}', '${s.id}', 'Reed Grant', 'grant') returning id`); return { input: { item_id: id, student_id: s.id }, table: "award_letter_items", where: `id = '${id}'` }; },
  "aid.delete_appeal": async () => { const id = await one(`insert into public.award_appeals (student_id, school_name) values ('${s.id}', 'Pomona College') returning id`); return { input: { appeal_id: id, student_id: s.id }, table: "award_appeals", where: `id = '${id}'` }; },
  "reports.delete": async () => { const id = await one(`insert into public.family_reports (student_id, counselor_id, title) values ('${s.id}', '${c.id}', 'Fall update') returning id`); return { input: { report_id: id }, table: "family_reports", where: `id = '${id}'` }; },
  "reports.delete_flag": async () => { const id = await one(`insert into public.narrative_flags (student_id, title) values ('${s.id}', 'Thin service story') returning id`); return { input: { flag_id: id }, table: "narrative_flags", where: `id = '${id}'` }; },
  "colleges.delete_webinar_tip": async () => { const id = await one(`insert into public.college_webinar_tips (college_id, source, tip, created_by) values ('${college}', 'webinar', 'Ask about co-ops', '${c.id}') returning id`); return { input: { tip_id: id, college_id: college }, table: "college_webinar_tips", where: `id = '${id}'` }; },
  "events.delete": async () => { const id = await one(`insert into public.hub_events (name, kind, host, start_date, url, created_by) values ('Practice webinar ${randomUUID().slice(0, 4)}', 'webinar', 'Our practice', '2026-12-10', 'https://example.org/webinar', '${c.id}') returning id`); return { input: { event_id: id }, table: "hub_events", where: `id = '${id}'` }; },
  "resources.delete": async () => { const id = await one(`insert into public.library_resources (category, title, url, counselor_id, created_by) values ('testing', 'Our SAT guide', 'https://example.org/sat', '${c.id}', '${c.id}') returning id`); return { input: { resource_id: id }, table: "library_resources", where: `id = '${id}'` }; },
  "files.delete_folder": async () => { const id = await one(`insert into public.folders (owner_id, name) values ('${c.id}', 'Old notes ${randomUUID().slice(0, 4)}') returning id`); return { input: { folder_id: id }, table: "folders", where: `id = '${id}'` }; },
  "files.delete_document": async () => { const d = await doc(); return { input: { document_id: d.id }, table: "documents", where: `id = '${d.id}'`, doc: d }; },
  "files.delete_link": async () => { const id = await one(`insert into public.document_links (owner_id, student_id, url, title) values ('${c.id}', '${s.id}', 'https://example.org/doc', 'A link') returning id`); return { input: { link_id: id }, table: "document_links", where: `id = '${id}'` }; },
  "outcomes.delete": async () => { const id = await one(`insert into public.admission_outcomes (counselor_id, student_id, high_school_name, cycle, college_name, result) values ('${c.id}', '${s.id}', 'Lincoln High', '2025-2026', 'Pomona College', 'admitted') returning id`); return { input: { outcome_id: id }, table: "admission_outcomes", where: `id = '${id}'` }; },
  "referrals.delete": async () => { const id = await one(`insert into public.referrals (from_student_id, counselor_id) values ('${s.id}', '${c.id}') returning id`); return { input: { referral_id: id }, table: "referrals", where: `id = '${id}'` }; },
  "pipeline.delete_contact": async () => { const r = await call(c.token, "POST", "/pipeline/contacts", { stageId, studentName: "Ada Lovelace", parentEmail: `ada-${randomUUID().slice(0, 8)}@families.test` }); return { input: { contact_id: r.body.id }, table: "pipeline_contacts", where: `id = '${r.body.id}'` }; },
  "management.delete_task": async () => { const id = await one(`insert into public.consultant_tasks (assignee_id, assigned_by, title) values ('${c.id}', '${c.id}', 'Prep the fair') returning id`); return { input: { task_id: id }, table: "consultant_tasks", where: `id = '${id}'` }; },
};

for (const [op, seed] of Object.entries(cases)) {
  let target;
  try {
    target = await seed();
  } catch (err) {
    check(`${op}: its target can be made`, false, String(err.message).slice(0, 200));
    continue;
  }
  const actionId = await propose(op, target.input);
  const confirmed = await call(c.token, "POST", `/axis/actions/${actionId}/confirm`);
  const kept = await one(`select count(*) from private.axis_trash where action_id = '${actionId}'`);
  const gone = await count(target.table, target.where);
  check(`${op}: the confirmed delete keeps its rows in the trash`, confirmed.status === 200 && confirmed.body?.status === "confirmed" && Number(kept) >= 1 && gone === "0",
    `${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)} kept=${kept} left=${gone}`);
  const listed = (await call(c.token, "GET", `/axis/actions?conversationId=${conv.body.id}&status=all`)).body.find?.((a) => a.id === actionId);
  check(`${op}: the card offers Restore until a date`, listed?.payload?.undoable === true && typeof listed?.payload?.restoreUntil === "string", JSON.stringify(listed?.payload ?? null).slice(0, 160));
  const undone = await call(c.token, "POST", `/axis/actions/${actionId}/undo`);
  const back = await count(target.table, target.where);
  check(`${op}: Restore brings it back`, undone.status === 200 && undone.body?.status === "undone" && back === "1", `${undone.status} ${JSON.stringify(undone.body).slice(0, 160)} back=${back}`);
  if (target.doc) {
    const object = await one(`select count(*) from storage.objects where bucket_id = 'student-documents' and name = '${target.doc.path}'`);
    check("a deleted document keeps its file until restored", object === "1", object);
  }
}

// A counselor taken off the student between the delete and the Restore is refused (Review Focus 2).
{
  const s2 = await studentOf(c, "trash-api-moved");
  const other = await user("trash-api-other");
  const id = await one(`insert into public.courses (student_id, name) values ('${s2.id}', 'AP Physics') returning id`);
  const actionId = await propose("courses.delete", { course_id: id, student_id: s2.id }, s2.id);
  await call(c.token, "POST", `/axis/actions/${actionId}/confirm`);
  await sql(`update public.profiles set counselor_id = '${other.id}' where id = '${s2.id}'`);
  const refused = await call(c.token, "POST", `/axis/actions/${actionId}/undo`);
  check("restore after a caseload transfer is refused", refused.status === 409 && String(refused.body?.error ?? refused.body?.message).includes("you no longer have access to that student"), `${refused.status} ${JSON.stringify(refused.body)}`);
  const status = await one(`select status from public.axis_actions where id = '${actionId}'`);
  check("and the card keeps its state", status === "confirmed", status);
}

// Restoring sends nothing: no notification, no delivery, no invite.
{
  // Counted for this test's student and counselor only: other suites send at the same time.
  const before = await one(`select (select count(*) from public.notifications where student_id = '${s.id}' or recipient_id in ('${c.id}', '${s.id}')) + (select count(*) from public.message_deliveries where student_id = '${s.id}' or recipient_id = '${c.id}')`);
  const sc = await cases["college_list.remove"]();
  const meeting = await cases["meetings.delete"]();
  for (const [op, t] of [["college_list.remove", sc], ["meetings.delete", meeting]]) {
    const actionId = await propose(op, t.input);
    await call(c.token, "POST", `/axis/actions/${actionId}/confirm`);
    await call(c.token, "POST", `/axis/actions/${actionId}/undo`);
  }
  const after = await one(`select (select count(*) from public.notifications where student_id = '${s.id}' or recipient_id in ('${c.id}', '${s.id}')) + (select count(*) from public.message_deliveries where student_id = '${s.id}' or recipient_id = '${c.id}')`);
  check("restore sends nothing", before === after, `${before} -> ${after}`);
  const attendees = await count("meeting_attendees", `meeting_id = '${meeting.input.meeting_id}'`);
  check("a restored meeting has its attendee once", attendees === "1", attendees);
}

// A work item about a student moved to another counselor isn't restored through the card either.
{
  const s3 = await studentOf(c, "trash-api-moved-item");
  const other = await user("trash-api-other-item");
  const id = await one(`insert into public.counselor_work_items (counselor_id, student_id, title) values ('${c.id}', '${s3.id}', 'Call the family') returning id`);
  const actionId = await propose("work_queue.delete", { item_id: id }, s3.id);
  await call(c.token, "POST", `/axis/actions/${actionId}/confirm`);
  await sql(`update public.profiles set counselor_id = '${other.id}' where id = '${s3.id}'`);
  const refused = await call(c.token, "POST", `/axis/actions/${actionId}/undo`);
  check("a work item about a moved student isn't restored", refused.status === 409 && (await count("counselor_work_items", `id = '${id}'`)) === "0", `${refused.status} ${JSON.stringify(refused.body)}`);
}

// After 30 days the card stops offering Restore, and a late click is refused without claiming the card.
{
  const id = await one(`insert into public.courses (student_id, name) values ('${s.id}', 'AP Latin') returning id`);
  const actionId = await propose("courses.delete", { course_id: id, student_id: s.id });
  await call(c.token, "POST", `/axis/actions/${actionId}/confirm`);
  await sql(`update public.axis_actions set result = jsonb_set(result, '{restoreUntil}', to_jsonb((now() - interval '1 hour')::text)) where id = '${actionId}'`);
  await sql(`update private.axis_trash set deleted_at = now() - interval '31 days' where action_id = '${actionId}'`);
  const listed = (await call(c.token, "GET", `/axis/actions?conversationId=${conv.body.id}&status=all`)).body.find?.((a) => a.id === actionId);
  check("an expired card doesn't offer Restore", listed?.payload?.undoable === false, JSON.stringify(listed?.payload ?? null).slice(0, 160));
  const late = await call(c.token, "POST", `/axis/actions/${actionId}/undo`);
  check("a late Restore says the 30 days are up", late.status === 409 && String(late.body?.error ?? late.body?.message).includes("the 30 days are up"), `${late.status} ${JSON.stringify(late.body)}`);
  const status = await one(`select status from public.axis_actions where id = '${actionId}'`);
  check("and the expired card keeps its state", status === "confirmed", status);
}

// A delete already restored another way leaves the card undone.
{
  const id = await one(`insert into public.courses (student_id, name) values ('${s.id}', 'AP Music Theory') returning id`);
  const actionId = await propose("courses.delete", { course_id: id, student_id: s.id });
  await call(c.token, "POST", `/axis/actions/${actionId}/confirm`);
  await rest(c.token, "POST", "/rest/v1/rpc/axis_trash_restore", { p_action: actionId });
  const again = await call(c.token, "POST", `/axis/actions/${actionId}/undo`);
  const status = await one(`select status from public.axis_actions where id = '${actionId}'`);
  check("a delete already restored leaves the card undone", again.status === 409 && String(again.body?.error ?? again.body?.message).includes("already restored") && status === "undone", `${again.status} ${JSON.stringify(again.body)} ${status}`);
}
