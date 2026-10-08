// What the counselor asks for becomes the student's To-Do; the student hands a
// file in; AxIS checks it; the counselor's request ticks. Real accounts on a
// local Supabase against a running API (see harness.mjs).
//
// The AxIS steps need ANTHROPIC_API_KEY on the API; without it the review is
// "skipped" and those checks are reported as skipped, not failed.
import { user, call, check, sql } from "./harness.mjs";

const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

/** A one-page PDF with these lines of text, built by hand: no fixture, no dependency. */
function pdf(lines) {
  const esc = (t) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const body = ["BT", "/F1 11 Tf", "14 TL", "60 740 Td", ...lines.map((l) => `(${esc(l)}) '`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

async function upload(student, name, bytes) {
  const path = `${student.id}/${Date.now()}-${name}`;
  const r = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${student.token}`, "Content-Type": "application/pdf" },
    body: bytes,
  });
  if (!r.ok) throw new Error(`storage upload ${r.status} ${await r.text()}`);
  const doc = await call(student.token, "POST", "/files/documents", {
    storagePath: path, filename: name, mimeType: "application/pdf", sizeBytes: bytes.length,
  });
  if (doc.status !== 201) throw new Error(`register ${doc.status} ${JSON.stringify(doc.body)}`);
  return doc.body;
}

/** The task once AxIS has written a verdict newer than `since`, or null after the wait. */
async function awaitVerdict(token, taskId, since, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    const t = await call(token, "GET", `/tasks/${taskId}`);
    const at = t.body?.tracker?.checkedAt;
    if (t.body?.tracker?.source === "ai" && at && new Date(at) > since) return t.body;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

const c = await user("counselor-sub");
const s = await user("student-sub", "student");
const other = await user("student-other", "student");
await sql(`update profiles set full_name='Jordan Lee' where id='${s.id}'`);

// The counselor's requests ride on the invitation (the New student page).
const inviteToken = `sub-test-${Date.now()}`;
await sql(`insert into invitations (counselor_id, email, token, source, intake_requests)
  values ('${c.id}', '${s.email}', '${inviteToken}', 'intake',
  '[{"id":"tr","label":"Transcript","provided":false},{"id":"rs","label":"Resume","provided":false}]')`);
const accepted = await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_token: inviteToken }),
});
check("student accepts the invitation", accepted.ok, `status ${accepted.status}`);

const todo = await call(s.token, "GET", "/tasks");
const transcript = todo.body.find?.((t) => t.title === "Transcript");
const resume = todo.body.find?.((t) => t.title === "Resume");
check("each request is on the student's To-Do", Boolean(transcript && resume), JSON.stringify(todo.body).slice(0, 200));
check("…as the counselor's document tasks", transcript?.source === "counselor" && transcript?.kind === "document" && transcript?.assignedBy === c.id);
const counselorView = await call(c.token, "GET", `/tasks?studentId=${s.id}`);
check("the counselor sees the same tasks", counselorView.body.some?.((t) => t.id === transcript?.id));

// Security first: nobody else hands in, and a student can't ask for a re-check.
const transcriptPdf = pdf([
  "Lincoln High School - Official Academic Transcript",
  "Student: Jordan Lee    Graduation: June 2027",
  "Grade 9: English 9 A, Algebra I A-, Biology A, World History B+, Spanish I A",
  "Grade 10: English 10 A, Geometry A, Chemistry A-, US History A, Spanish II A",
  "Cumulative GPA (weighted): 4.12    Cumulative GPA (unweighted): 3.86",
  "Class rank: 24 of 410",
  "Registrar signature on file. Page 1 of 1.",
]);
const doc = await upload(s, "transcript.pdf", transcriptPdf);
const otherDoc = await upload(other, "mine.pdf", pdf(["Something else"]));
const intruder = await call(other.token, "POST", `/tasks/${transcript.id}/submissions`, { documentId: otherDoc.id });
check("another student can't hand in on this task", intruder.status === 404 || intruder.status === 403, `status ${intruder.status}`);
const foreign = await call(s.token, "POST", `/tasks/${transcript.id}/submissions`, { documentId: otherDoc.id });
check("a student can't hand in someone else's file", foreign.status === 400 || foreign.status === 404, `status ${foreign.status}`);
const studentRecheck = await call(s.token, "POST", `/tasks/${transcript.id}/review`, {});
check("only the counselor asks AxIS to re-check", studentRecheck.status === 403, `status ${studentRecheck.status}`);
const forged = await fetch(`${SB}/rest/v1/deliverable_tracker_checks`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ student_id: s.id, deliverable_id: transcript.id, verdict: "on-track", note: "forged" }),
});
check("a student can't write a verdict through the database", !forged.ok, `status ${forged.status}`);

// Hand the transcript in.
const since = new Date();
const handed = await call(s.token, "POST", `/tasks/${transcript.id}/submissions`, { documentId: doc.id });
check("student hands in the transcript", handed.status === 201, `status ${handed.status} ${JSON.stringify(handed.body).slice(0, 200)}`);
check("…the file is on the task as a submission", handed.body.task?.documents?.some((d) => d.documentId === doc.id && d.role === "submission"));
check("…and the task waits on a check", handed.body.task?.status === "review", handed.body.task?.status);
const ai = handed.body.review?.status === "checking";
console.log(`AxIS review: ${JSON.stringify(handed.body.review)}`);

if (ai) {
  const done = await awaitVerdict(s.token, transcript.id, since);
  check("AxIS writes a verdict", Boolean(done));
  check("…accepts a real transcript and completes the task", done?.tracker?.verdict === "on-track" && done?.status === "complete",
    `${done?.tracker?.verdict} ${done?.status} ${done?.tracker?.note}`);
  check("…reads the GPA off the file", done?.tracker?.findings?.some((f) => f.includes("4.12")), JSON.stringify(done?.tracker?.findings));
  const ticked = await sql(`select e->>'provided' from invitations i, jsonb_array_elements(i.intake_requests) e where i.token='${inviteToken}' and e->>'id'='tr'`);
  check("the counselor's Transcript request ticks", ticked === "true", ticked);
  const locked = await call(s.token, "DELETE", `/tasks/${transcript.id}/submissions/${doc.id}`);
  check("a finished task keeps its file", locked.status === 409, `status ${locked.status}`);
  const note = await sql(`select title from notifications where recipient_id='${c.id}' and student_id='${s.id}' order by created_at desc limit 1`);
  check("the counselor is notified", note.includes("Transcript") && note.includes("accepted"), note);

  // The wrong file for the Resume task.
  const wrong = await upload(s, "grocery-list.pdf", pdf(["Grocery list", "Milk", "Eggs", "Bread", "Apples"]));
  const since2 = new Date();
  const handed2 = await call(s.token, "POST", `/tasks/${resume.id}/submissions`, { documentId: wrong.id });
  check("student hands in the wrong file", handed2.status === 201 && handed2.body.review?.status === "checking");
  const flagged = await awaitVerdict(s.token, resume.id, since2);
  check("AxIS flags it and hands the task back", flagged?.tracker?.verdict === "below-the-brief" && flagged?.status === "in-progress",
    `${flagged?.tracker?.verdict} ${flagged?.status} ${flagged?.tracker?.note}`);
  const studentNote = await sql(`select title from notifications where recipient_id='${s.id}' order by created_at desc limit 1`);
  check("the student is told to check their Resume", studentNote.includes("Resume"), studentNote);
  const studentMail = await sql(`select count(*) from message_deliveries where template='submission-review-student' and student_id='${s.id}'`);
  check("the student is emailed what to fix", studentMail === "1", studentMail);
  const counselorMail = await sql(`select count(*) from message_deliveries where template='submission-review-counselor' and recipient_id='${c.id}'`);
  check("the counselor is emailed each hand-in", Number(counselorMail) >= 2, counselorMail);
  const stillOpen = await sql(`select e->>'provided' from invitations i, jsonb_array_elements(i.intake_requests) e where i.token='${inviteToken}' and e->>'id'='rs'`);
  check("the Resume request stays open", stillOpen === "false", stillOpen);

  // The counselor re-runs the check.
  const rerun = await call(c.token, "POST", `/tasks/${resume.id}/review`, {});
  check("the counselor can re-run AxIS", rerun.status === 200 && rerun.body.review?.status === "checking", `status ${rerun.status}`);
  await awaitVerdict(c.token, resume.id, new Date(Date.now() - 1000));
} else {
  console.log("SKIP  AxIS verdict checks (no ANTHROPIC_API_KEY on the API)");
}

// Taking a file back.
const backDoc = await upload(s, "draft-resume.pdf", pdf(["Jordan Lee", "Draft"]));
await call(s.token, "POST", `/tasks/${resume.id}/submissions`, { documentId: backDoc.id });
const back = await call(s.token, "DELETE", `/tasks/${resume.id}/submissions/${backDoc.id}`);
check("student takes a handed-in file back", back.status === 200 && !back.body.documents.some((d) => d.documentId === backDoc.id), `status ${back.status}`);
const notTheirs = await call(other.token, "DELETE", `/tasks/${transcript.id}/submissions/${doc.id}`);
check("another student can't take it back", notTheirs.status === 404 || notTheirs.status === 403, `status ${notTheirs.status}`);

// Practice switched AI document reading off: the file is handed in, AxIS stays out.
await sql(`insert into practice_settings (counselor_id, auto_parse_documents) values ('${c.id}', false)
  on conflict do nothing`);
await sql(`update practice_settings set auto_parse_documents=false where counselor_id='${c.id}'`);
const offDoc = await upload(s, "resume.pdf", pdf(["Jordan Lee", "Experience: Robotics team captain"]));
const off = await call(s.token, "POST", `/tasks/${resume.id}/submissions`, { documentId: offDoc.id });
check("with AI reading off, the file is still handed in", off.status === 201 && off.body.task?.status === "review");
check("…and AxIS says why it didn't read it", off.body.review?.status === "skipped" && /off/.test(off.body.review?.reason ?? ""), JSON.stringify(off.body.review));
