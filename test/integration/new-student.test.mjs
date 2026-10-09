// New-student onboarding: the counselor asks for things on New student, the
// student answers each (a file, or a typed answer) and presses Submit, the
// counselor receives each or sends one back, then confirms. Confirmed takes
// the card off "Building profile" and opens the setup steps on both sides,
// which clear themselves as the record fills in. Real accounts on a local
// Supabase against a running API (see harness.mjs).
import { user, call, check, sql } from "./harness.mjs";

const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

async function uploadText(student, name, text) {
  const bytes = Buffer.from(text);
  const path = `${student.id}/${Date.now()}-${name}`;
  const r = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${student.token}`, "Content-Type": "text/plain" },
    body: bytes,
  });
  if (!r.ok) throw new Error(`storage upload ${r.status} ${await r.text()}`);
  const doc = await call(student.token, "POST", "/files/documents", {
    storagePath: path, filename: name, mimeType: "text/plain", sizeBytes: bytes.length,
  });
  if (doc.status !== 201) throw new Error(`register ${doc.status} ${JSON.stringify(doc.body)}`);
  return doc.body;
}

const c = await user("counselor-new");
const s = await user("student-new", "student");
const other = await user("counselor-other");

// New student: Transcript, Resume and a custom "GPA".
const invite = await call(c.token, "POST", "/invites", {
  email: s.email,
  source: "intake",
  fullName: "Riley Park",
  intakeRequests: [
    { id: "transcript", label: "Transcript" },
    { id: "resume", label: "Resume" },
    { id: "custom-gpa", label: "GPA" },
  ],
});
check("counselor creates the new student", invite.status === 201, `status ${invite.status} ${JSON.stringify(invite.body).slice(0, 200)}`);
const inviteId = invite.body.invitation?.id ?? invite.body.id;
const token = await sql(`select token from invitations where id='${inviteId}'`);

let building = await call(c.token, "GET", "/invites/building");
check("it reads Building profile before they join", building.body.some?.((b) => b.id === inviteId && !b.canConfirm));
const early = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true });
check("…and can't be confirmed yet", early.status === 409, `status ${early.status}`);

const accepted = await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_token: token }),
});
check("student joins", accepted.ok, `status ${accepted.status}`);

// The student's card.
let mine = await call(s.token, "GET", "/me/intake");
const tasks = mine.body.intake?.tasks ?? [];
check("the student sees every request", tasks.length === 3, JSON.stringify(mine.body).slice(0, 200));
const byLabel = Object.fromEntries(tasks.map((t) => [t.title, t]));

const tooSoon = await call(s.token, "POST", "/me/intake/submit", {});
check("Submit waits for every item", tooSoon.status === 400 && /Still needed/.test(tooSoon.body.error ?? tooSoon.body.message ?? ""), JSON.stringify(tooSoon.body));

const selfComplete = await fetch(`${SB}/rest/v1/deliverables?id=eq.${byLabel.Transcript.id}`, {
  method: "PATCH",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ status: "complete" }),
});
check("a student can't mark a request received themselves", !selfComplete.ok, `status ${selfComplete.status}`);

const transcriptDoc = await uploadText(s, "transcript.txt", "Lincoln High School transcript. Riley Park. GPA 3.9.");
const resumeDoc = await uploadText(s, "resume.txt", "Riley Park. Robotics captain.");
const attached = await call(s.token, "POST", `/tasks/${byLabel.Transcript.id}/submissions`, { documentId: transcriptDoc.id });
check("attaching a file doesn't send it", attached.status === 201 && attached.body.task?.status !== "review" && attached.body.review === null,
  `${attached.status} ${attached.body.task?.status}`);
await call(s.token, "POST", `/tasks/${byLabel.Resume.id}/submissions`, { documentId: resumeDoc.id });
const answered = await call(s.token, "PATCH", `/me/intake/${byLabel.GPA.id}`, { answer: "3.92 weighted" });
check("the student types the GPA", answered.status === 200, `status ${answered.status}`);

const submitted = await call(s.token, "POST", "/me/intake/submit", {});
check("Submit sends everything", submitted.status === 200 && submitted.body.intake?.submittedAt, JSON.stringify(submitted.body).slice(0, 200));
check("…every item is with the counselor", submitted.body.intake?.tasks?.every((t) => t.status === "review"));
const note = await sql(`select title from notifications where recipient_id='${c.id}' and student_id='${s.id}' order by created_at desc limit 1`);
check("the counselor is told once", note.includes("sent what you asked for"), note);
const locked = await call(s.token, "PATCH", `/me/intake/${byLabel.GPA.id}`, { answer: "4.0" });
check("a sent answer is locked", locked.status === 409, `status ${locked.status}`);

// The counselor's side.
building = await call(c.token, "GET", "/invites/building");
const card = building.body.find?.((b) => b.id === inviteId);
check("the card shows each item submitted", card?.intakeItems?.every((i) => i.status === "submitted"), JSON.stringify(card?.intakeItems));
check("…with the typed answer and the files", card?.intakeItems?.find((i) => i.requestId === "custom-gpa")?.answer === "3.92 weighted"
  && card?.intakeItems?.find((i) => i.requestId === "transcript")?.files?.length === 1);
const stranger = await call(other.token, "PATCH", `/invites/${inviteId}`, { receive: { requestId: "transcript", received: true } });
check("another counselor can't receive it", stranger.status === 404, `status ${stranger.status}`);

await call(c.token, "PATCH", `/invites/${inviteId}`, { receive: { requestId: "transcript", received: true } });
await call(c.token, "PATCH", `/invites/${inviteId}`, { receive: { requestId: "custom-gpa", received: true } });
const back = await call(c.token, "PATCH", `/invites/${inviteId}`, { sendBack: { requestId: "resume", note: "Please send the full resume, not a draft." } });
check("the counselor sends the resume back", back.status === 200 && back.body.submittedAt === null, `status ${back.status}`);
const notYet = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true });
check("…and can't confirm with it outstanding", notYet.status === 409, `status ${notYet.status}`);

mine = await call(s.token, "GET", "/me/intake");
const resumeTask = mine.body.intake.tasks.find((t) => t.title === "Resume");
check("the student sees the note", resumeTask?.sentBackNote === "Please send the full resume, not a draft.");
check("…the transcript reads received", mine.body.intake.tasks.find((t) => t.title === "Transcript")?.status === "complete");
const studentNote = await sql(`select title from notifications where recipient_id='${s.id}' order by created_at desc limit 1`);
check("…and is notified", studentNote.includes("Resume"), studentNote);

const resume2 = await uploadText(s, "resume-full.txt", "Riley Park. Full resume.");
await call(s.token, "POST", `/tasks/${resumeTask.id}/submissions`, { documentId: resume2.id });
const again = await call(s.token, "POST", "/me/intake/submit", {});
check("the student resubmits just the resume", again.status === 200 && again.body.intake.tasks.find((t) => t.title === "Resume")?.status === "review");
await call(c.token, "PATCH", `/invites/${inviteId}`, { receive: { requestId: "resume", received: true } });

const preSetup = await call(s.token, "GET", "/me/setup");
check("no Getting started before confirm", preSetup.body.steps?.length === 0, JSON.stringify(preSetup.body));

const confirmed = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true });
check("the counselor confirms", confirmed.status === 200 && confirmed.body.confirmedAt, `status ${confirmed.status}`);
building = await call(c.token, "GET", "/invites/building");
check("the card leaves Building profile", !building.body.some?.((b) => b.id === inviteId));
const roster = await call(c.token, "GET", "/students");
check("…and they are a student on the roster", JSON.stringify(roster.body).includes(s.id));

// Setup steps, both sides.
let queue = await call(c.token, "GET", "/work-items?includeDerived=true");
const setup = queue.body.filter?.((i) => i.origin === "setup" && i.studentId === s.id) ?? [];
check("My Work Queue lists the setup steps", setup.length === 6, JSON.stringify(setup.map((i) => i.title)));
check("…each says where it is done", setup.every((i) => i.setupLink));
let studentSetup = await call(s.token, "GET", "/me/setup");
check("the student's Getting started lists theirs", studentSetup.body.steps?.length === 4, JSON.stringify(studentSetup.body));

await sql(`insert into guardians (student_id, full_name, email) values ('${s.id}', 'Sam Park', 'sam@example.com')`);
queue = await call(c.token, "GET", "/work-items?includeDerived=true");
check("a guardian on file clears that step for the counselor",
  !queue.body.some?.((i) => i.origin === "setup" && i.studentId === s.id && i.id.endsWith(":guardian")));
studentSetup = await call(s.token, "GET", "/me/setup");
check("…and for the student", !studentSetup.body.steps?.some((st) => st.key === "guardian"));
