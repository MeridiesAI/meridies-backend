// A counselor may confirm a new student over requests they don't need yet
// (PATCH /invites/:id { confirmed: true, waive: [...] }). The waived items stay
// open for the student, who keeps their red card and can still Submit them
// (20261101000001). The Building card also reads the name the student signed
// up with, not the one typed on the invitation. Real accounts on a local
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

const c = await user("counselor-waive");
const s = await user("student-waive", "student");

const invite = await call(c.token, "POST", "/invites", {
  email: s.email,
  source: "intake",
  fullName: "Invite Typed Name",
  intakeRequests: [
    { id: "transcript", label: "Transcript" },
    { id: "resume", label: "Resume" },
  ],
});
check("counselor creates the new student", invite.status === 201, `status ${invite.status}`);
const inviteId = invite.body.invitation?.id ?? invite.body.id;
const token = await sql(`select token from invitations where id='${inviteId}'`);

const early = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true, waive: ["transcript", "resume"] });
check("a waiver can't confirm someone who hasn't joined", early.status === 409, `status ${early.status}`);

const accepted = await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_token: token }),
});
check("student joins", accepted.ok, `status ${accepted.status}`);

// The name: the student's own, not the invitation's.
const building = await call(c.token, "GET", "/invites/building");
const card = building.body.find?.((b) => b.id === inviteId);
check("the Building card carries the name the student signed up with", card?.acceptedByName === "student-waive", JSON.stringify(card?.acceptedByName));
check("…while the invitation still says what the counselor typed", card?.fullName === "Invite Typed Name");

// Confirming over open requests.
const open = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true });
check("confirm without a waiver still needs every request", open.status === 409, `status ${open.status}`);
const partial = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true, waive: ["transcript"] });
check("…and a waiver must name every open one", partial.status === 409, `status ${partial.status}`);
const unknown = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true, waive: ["transcript", "resume", "nope"] });
check("…and may not name a request nobody asked for", unknown.status === 409, `status ${unknown.status}`);
const waived = await call(c.token, "PATCH", `/invites/${inviteId}`, { confirmed: true, waive: ["transcript", "resume"] });
check("the counselor confirms over both", waived.status === 200 && waived.body.confirmedAt, `status ${waived.status}`);
check("…and nothing was marked received", waived.body.intakeRequests?.every((r) => r.provided === false), JSON.stringify(waived.body.intakeRequests));
const after = await call(c.token, "GET", "/invites/building");
check("the card leaves Building profile", !after.body.some?.((b) => b.id === inviteId));
const roster = await call(c.token, "GET", "/students");
check("…and they are a student on the roster", JSON.stringify(roster.body).includes(s.id));

// The student still owes both, and can still send them.
let mine = await call(s.token, "GET", "/me/intake");
const tasks = mine.body.intake?.tasks ?? [];
check("the student's request card still lists both", tasks.length === 2 && tasks.every((t) => t.status !== "complete"), JSON.stringify(tasks.map((t) => t.status)));
check("…and says they are confirmed", Boolean(mine.body.intake?.confirmedAt));

const tooSoon = await call(s.token, "POST", "/me/intake/submit", {});
check("Submit still waits for every open item", tooSoon.status === 400 && /Still needed/.test(tooSoon.body.error ?? tooSoon.body.message ?? ""), JSON.stringify(tooSoon.body));

const byLabel = Object.fromEntries(tasks.map((t) => [t.title, t]));
const transcriptDoc = await uploadText(s, "transcript.txt", "Lincoln High School transcript. GPA 3.9.");
const resumeDoc = await uploadText(s, "resume.txt", "Robotics captain.");
await call(s.token, "POST", `/tasks/${byLabel.Transcript.id}/submissions`, { documentId: transcriptDoc.id });
await call(s.token, "POST", `/tasks/${byLabel.Resume.id}/submissions`, { documentId: resumeDoc.id });
const sent = await call(s.token, "POST", "/me/intake/submit", {});
check("after confirming, the student can still Submit", sent.status === 200 && sent.body.intake?.tasks?.every((t) => t.status === "review"), `status ${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);

// A normal confirmation (everything received) is still closed to a late Submit.
const s2 = await user("student-waive-done", "student");
const inv2 = await call(c.token, "POST", "/invites", {
  email: s2.email, source: "intake", fullName: "Second Student",
  intakeRequests: [{ id: "transcript", label: "Transcript" }],
});
const inv2Id = inv2.body.invitation?.id ?? inv2.body.id;
const token2 = await sql(`select token from invitations where id='${inv2Id}'`);
await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s2.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_token: token2 }),
});
await call(c.token, "PATCH", `/invites/${inv2Id}`, { receive: { requestId: "transcript", received: true } });
const normal = await call(c.token, "PATCH", `/invites/${inv2Id}`, { confirmed: true });
check("a normal confirmation still works", normal.status === 200, `status ${normal.status}`);
const late = await call(s2.token, "POST", "/me/intake/submit", {});
check("…and a Submit after it is still refused", late.status === 400 && /already has everything/.test(late.body.error ?? late.body.message ?? ""), JSON.stringify(late.body));
