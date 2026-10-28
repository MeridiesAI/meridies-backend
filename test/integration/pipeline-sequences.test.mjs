// Contact Pipeline email sequences (migration 20261028000004), as real accounts
// on a local Supabase against a running API (see harness.mjs).
//
//   S   a solo counselor, X a solo counselor elsewhere
//   A   owner of a firm, B a consultant in it
//   Stu a student
//
// Checks: sequences validate and follow the workspace; enrolling (now or from a
// future date); the cron sends what is due, once, and moves on; pause/resume/
// stop; a contact that is lost, won or unsubscribes is sent nothing more; no
// address ends the enrollment; the client can't forge progress or read tokens.
import { createHash } from "node:crypto";
import { CRON_SECRET, API, CLIENT, call, check, rest, sql, user } from "./harness.mjs";

const tag = Date.now();
const email = (name) => `${name}-${tag}@families.test`;
const dispatch = async (secret = CRON_SECRET) => {
  const r = await fetch(`${API}/internal/pipeline-sequences/dispatch`, {
    method: "POST",
    headers: { ...CLIENT, ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const due = (enrollmentId) =>
  sql(`update public.pipeline_sequence_enrollments set next_send_at = now() - interval '1 minute', claimed_at = null where id = '${enrollmentId}'`);
const enrollmentRow = async (id) => JSON.parse(await sql(`select row_to_json(e) from public.pipeline_sequence_enrollments e where id = '${id}'`));
const timeline = async (u, contactId) => (await call(u.token, "GET", `/pipeline/contacts/${contactId}/activities?limit=200`)).body.activities ?? [];
const sentMail = () => sql(`select count(*) from public.message_deliveries where template = 'pipeline-sequence'`);
const board = async (u) => (await call(u.token, "GET", "/pipeline")).body;
const newContact = async (u, stageId, over = {}) => {
  const r = await call(u.token, "POST", "/pipeline/contacts", { stageId, studentName: "Ada Lovelace", ...over });
  if (r.status !== 201) throw new Error(`create contact ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const enroll = (u, contactId, sequenceId, startOn) =>
  call(u.token, "POST", `/pipeline/contacts/${contactId}/sequences`, { sequenceId, ...(startOn ? { startOn } : {}) });
const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

const S = await user("ps-solo");
const X = await user("ps-outsider");
const A = await user("ps-owner");
const B = await user("ps-member");
const Stu = await user("ps-student", "student");
const created = await call(A.token, "POST", "/firms", { name: `Sequence firm ${tag}` });
const firmId = created.body.firmId;
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${B.id}', 'counselor') on conflict do nothing`);
await sql(`update public.profiles set firm_id = '${firmId}' where id = '${B.id}'`);

const stageOf = async (u) => (await board(u)).stages[0].id;
const sStage = await stageOf(S);

// ---------------------------------------------------------------------------
// Writing a sequence
// ---------------------------------------------------------------------------
const steps = [
  { offsetDays: 0, to: "both", subject: "Hi {first}", body: "Thanks for reaching out. — {me}" },
  { offsetDays: 3, to: "parent", subject: "Checking in", body: "Any questions so far?" },
  { offsetDays: 7, to: "both", subject: "Last note", body: "Happy to talk any time." },
];
const seq = await call(S.token, "POST", "/pipeline/sequences", { name: "Inquiry drip", sendHour: 9, steps });
check("a counselor writes a sequence", seq.status === 201 && seq.body.steps.length === 3 && seq.body.steps[1].position === 2, JSON.stringify(seq.body));

const sameDay = await call(S.token, "POST", "/pipeline/sequences", { name: "Bad", steps: [steps[0], { ...steps[1], offsetDays: 0 }] });
check("two emails can't share a day", sameDay.status === 400, `${sameDay.status}`);
const noSteps = await call(S.token, "POST", "/pipeline/sequences", { name: "Empty", steps: [] });
check("a sequence needs at least one email", noSteps.status === 400, `${noSteps.status}`);
const blankSubject = await call(S.token, "POST", "/pipeline/sequences", { name: "Blank", steps: [{ ...steps[0], subject: "  " }] });
check("every email needs a subject", blankSubject.status === 400, `${blankSubject.status}`);

const list = await call(S.token, "GET", "/pipeline/sequences");
check("the list shows it", list.status === 200 && list.body.sequences.some((s) => s.id === seq.body.id), JSON.stringify(list.body));
check("another practice sees none of it", (await call(X.token, "GET", "/pipeline/sequences")).body.sequences?.length === 0);
const xEdit = await call(X.token, "PUT", `/pipeline/sequences/${seq.body.id}`, { name: "Mine now", steps });
check("another practice can't edit it", xEdit.status === 404, `${xEdit.status}`);
const stuList = await call(Stu.token, "GET", "/pipeline/sequences");
check("a student can't reach sequences", stuList.status === 403, `${stuList.status}`);

// ---------------------------------------------------------------------------
// Enrolling
// ---------------------------------------------------------------------------
const c1 = await newContact(S, sStage, { studentEmail: email("ada"), parentEmail: email("ada-parent") });
const future = await enroll(S, c1.id, seq.body.id, tomorrow);
check("enrolling from a future date schedules the first email then", future.status === 201 && future.body.status === "active" && Date.parse(future.body.nextSendAt) > Date.now() + 86_400_000, JSON.stringify(future.body));
const again = await enroll(S, c1.id, seq.body.id);
check("a contact is in a sequence once at a time", again.status === 409, `${again.status}`);
const past = await enroll(S, (await newContact(S, sStage, { studentName: "Past Start", studentEmail: email("past") })).id, seq.body.id, "2020-01-01");
check("the start date can't be in the past", past.status === 400, `${past.status}`);
const xEnroll = await enroll(X, c1.id, seq.body.id);
check("another practice can't enroll your contact", xEnroll.status === 404, `${xEnroll.status}`);

const notYet = await dispatch();
check("the cron needs its secret", (await dispatch(null)).status === 401 && (await dispatch("nope")).status === 401);
check("a future start sends nothing yet", notYet.status === 200 && notYet.body.sent === 0 && (await enrollmentRow(future.body.id)).next_position === 1, JSON.stringify(notYet.body));

// ---------------------------------------------------------------------------
// The cron sends what is due, once
// ---------------------------------------------------------------------------
const before = Number(await sentMail());
await due(future.body.id);
const run1 = await dispatch();
let row = await enrollmentRow(future.body.id);
check("a due email is sent, to the student and the parent", run1.body.sent >= 1 && Number(await sentMail()) - before === 2, `${JSON.stringify(run1.body)} mail+${Number(await sentMail()) - before}`);
check("the enrollment moves to step 2, days out", row.status === "active" && row.next_position === 2 && Date.parse(row.next_send_at) > Date.now() + 2 * 86_400_000 && row.last_sent_at, JSON.stringify(row));
let tl = await timeline(S, c1.id);
check("the send is on the contact's timeline", tl.some((a) => a.kind === "email" && /Inquiry drip/.test(a.body)), tl.map((a) => a.kind).join());
const contactAfter = (await board(S)).contacts.find((c) => c.id === c1.id);
check("it counts as contact", !!contactAfter?.lastContactedAt, JSON.stringify(contactAfter));
const run2 = await dispatch();
check("running again sends nothing twice", run2.body.sent === 0 && Number(await sentMail()) - before === 2, JSON.stringify(run2.body));

// Pause holds it; resume releases it.
const paused = await call(S.token, "PATCH", `/pipeline/sequence-enrollments/${future.body.id}`, { action: "pause" });
await due(future.body.id);
const run3 = await dispatch();
check("a paused enrollment is not sent", paused.body.status === "paused" && run3.body.sent === 0, `${paused.status} ${JSON.stringify(run3.body)}`);
const resumed = await call(S.token, "PATCH", `/pipeline/sequence-enrollments/${future.body.id}`, { action: "resume" });
check("resume sets it going again", resumed.body.status === "active", JSON.stringify(resumed.body));
const run4 = await dispatch();
row = await enrollmentRow(future.body.id);
check("step 2 goes to the parent only", run4.body.sent >= 1 && row.next_position === 3 && Number(await sentMail()) - before === 3, `${JSON.stringify(run4.body)} mail+${Number(await sentMail()) - before}`);
await due(future.body.id);
const run5 = await dispatch();
row = await enrollmentRow(future.body.id);
check("the last email completes the enrollment", row.status === "completed" && run5.body.completed >= 1, JSON.stringify(row));
const endedStop = await call(S.token, "PATCH", `/pipeline/sequence-enrollments/${future.body.id}`, { action: "stop" });
check("an ended enrollment can't be changed", endedStop.status === 409, `${endedStop.status}`);

// ---------------------------------------------------------------------------
// A contact that moves on is sent nothing more
// ---------------------------------------------------------------------------
const cLost = await newContact(S, sStage, { studentName: "Lost Lead", studentEmail: email("lost") });
const eLost = await enroll(S, cLost.id, seq.body.id);
await call(S.token, "PATCH", `/pipeline/contacts/${cLost.id}`, { status: "lost", lostReason: "Went elsewhere" });
row = await enrollmentRow(eLost.body.id);
check("marking a contact lost stops its sequence", row.status === "stopped" && row.stop_reason === "lost", JSON.stringify(row));

const cWon = await newContact(S, sStage, { studentName: "Won Lead", studentEmail: email("won") });
const eWon = await enroll(S, cWon.id, seq.body.id);
await sql(`update public.pipeline_contacts set status = 'won' where id = '${cWon.id}'`);
row = await enrollmentRow(eWon.body.id);
check("a won contact's sequence stops", row.status === "stopped" && row.stop_reason === "won", JSON.stringify(row));
const enrollLost = await enroll(S, cLost.id, seq.body.id);
check("a lost contact can't be enrolled", enrollLost.status === 400, `${enrollLost.status} ${JSON.stringify(enrollLost.body)}`);

const cNone = await newContact(S, sStage, { studentName: "No Address" });
const eNone = await enroll(S, cNone.id, seq.body.id);
await due(eNone.body.id);
await dispatch();
row = await enrollmentRow(eNone.body.id);
check("a card with no address ends the enrollment", row.status === "stopped" && row.stop_reason === "no-address", JSON.stringify(row));

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------
const cUnsub = await newContact(S, sStage, { studentName: "Opt Out", studentEmail: email("optout") });
const eUnsub = await enroll(S, cUnsub.id, seq.body.id);
const token = "A".repeat(43);
await sql(`insert into public.pipeline_unsubscribe_tokens (token_hash, contact_id) values ('${createHash("sha256").update(token).digest("hex")}', '${cUnsub.id}')`);
const page = await fetch(`${API}/pipeline/unsubscribe/${token}`, { headers: CLIENT });
check("the unsubscribe link only shows a button", page.status === 200 && (await sql(`select email_opted_out_at is null from public.pipeline_contacts where id = '${cUnsub.id}'`)) === "t");
const bad = await fetch(`${API}/pipeline/unsubscribe/${"B".repeat(43)}`, { headers: CLIENT });
check("an unknown link is a 404", bad.status === 404, `${bad.status}`);
const post = await fetch(`${API}/pipeline/unsubscribe/${token}`, { method: "POST", headers: { ...CLIENT, "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
row = await enrollmentRow(eUnsub.body.id);
check("a one-click unsubscribe stops their sequences", post.status === 200 && row.status === "stopped" && row.stop_reason === "unsubscribed", `${post.status} ${JSON.stringify(row)}`);
const reEnroll = await enroll(S, cUnsub.id, seq.body.id);
check("an unsubscribed family can't be enrolled again", reEnroll.status === 400, `${reEnroll.status} ${JSON.stringify(reEnroll.body)}`);
const forContact = await call(S.token, "GET", `/pipeline/contacts/${cUnsub.id}/sequences`);
check("the contact's sequences say they unsubscribed", forContact.body.optedOut === true && forContact.body.enrollments.length === 1, JSON.stringify(forContact.body));

// ---------------------------------------------------------------------------
// Editing a sequence under a running enrollment
// ---------------------------------------------------------------------------
const cEdit = await newContact(S, sStage, { studentName: "Edit Case", studentEmail: email("edit") });
const eEdit = await enroll(S, cEdit.id, seq.body.id);
await sql(`update public.pipeline_sequence_enrollments set next_position = 3 where id = '${eEdit.body.id}'`);
const shorter = await call(S.token, "PUT", `/pipeline/sequences/${seq.body.id}`, { name: "Inquiry drip", sendHour: 10, steps: steps.slice(0, 2) });
check("a sequence can be shortened", shorter.status === 200 && shorter.body.steps.length === 2 && shorter.body.sendHour === 10, JSON.stringify(shorter.body));
await due(eEdit.body.id);
await dispatch();
row = await enrollmentRow(eEdit.body.id);
check("a contact past the new end finishes without a send", row.status === "completed" && row.last_sent_at === null, JSON.stringify(row));
const reread = await call(S.token, "GET", "/pipeline/sequences");
check("the shortened sequence kept its two emails", reread.body.sequences.find((s) => s.id === seq.body.id)?.steps.length === 2);

// ---------------------------------------------------------------------------
// The firm's workspace, and what the client can't do
// ---------------------------------------------------------------------------
const fSeq = await call(A.token, "POST", "/pipeline/sequences", { name: "Firm drip", steps: [steps[0]] });
check("a firm member sees the firm's sequences", (await call(B.token, "GET", "/pipeline/sequences")).body.sequences?.some((s) => s.id === fSeq.body.id));
check("another practice does not", !(await call(S.token, "GET", "/pipeline/sequences")).body.sequences?.some((s) => s.id === fSeq.body.id));

const forge = await rest(S.token, "PATCH", `/rest/v1/pipeline_sequence_enrollments?id=eq.${eNone.body.id}`, { next_position: 3 });
check("the client can't set progress", forge.status >= 400, `${forge.status} ${JSON.stringify(forge.body)}`);
const tokens = await rest(S.token, "GET", "/rest/v1/pipeline_unsubscribe_tokens?select=token_hash");
check("the client can't read unsubscribe tokens", tokens.status >= 400 || (Array.isArray(tokens.body) && tokens.body.length === 0), `${tokens.status}`);
const optOutWrite = await rest(S.token, "PATCH", `/rest/v1/pipeline_contacts?id=eq.${c1.id}`, { email_opted_out_at: null });
check("the client can't clear an opt-out", optOutWrite.status >= 400, `${optOutWrite.status}`);

const del = await call(S.token, "DELETE", `/pipeline/sequences/${seq.body.id}`);
const left = await sql(`select count(*) from public.pipeline_sequence_enrollments where sequence_id = '${seq.body.id}'`);
check("deleting a sequence removes its enrollments", del.status === 204 && left === "0", `${del.status} ${left}`);

console.log(process.exitCode ? "\nSome checks FAILED" : "\nAll checks passed");
