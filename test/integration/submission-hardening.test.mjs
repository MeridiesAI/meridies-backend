// Hand-ins can't be turned against anyone: AxIS reads a handed-in file only
// on the caller's own client, only from the documents bucket at a path the
// row and Storage agree on, only when the shared per-document AI rule allows
// it, and a student can't flood their counselor with notices or re-run
// New student's Submit for more. Each block is an attack that worked before.
//
// The API runs without ANTHROPIC_API_KEY in CI, so a file AxIS *could* read
// answers "AxIS isn't set up on this server yet." after the download, and a
// refused one answers the refusal: the reason says which side of the check it
// stopped on.
import { user, call, check, sql, rest } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const NOT_SET_UP = "AxIS isn't set up on this server yet.";
const COULDNT_OPEN = "AxIS couldn't open the uploaded file.";
const tag = Date.now();

async function upload(who, path, text) {
  const r = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${who.token}`, "Content-Type": "text/plain" },
    body: Buffer.from(text),
  });
  if (!r.ok) throw new Error(`storage upload ${r.status} ${await r.text()}`);
}

async function register(who, body) {
  return call(who.token, "POST", "/files/documents", { mimeType: "text/plain", sizeBytes: 40, ...body });
}

async function task(counselor, studentId, title) {
  const made = await call(counselor.token, "POST", "/tasks", { studentId, kind: "document", title });
  if (made.status !== 201) throw new Error(`task ${made.status} ${JSON.stringify(made.body)}`);
  return made.body.id;
}

const docRow = (owner, studentId, bucket, path) =>
  sql(`with d as (insert into public.documents (owner_id, student_id, bucket, storage_path, filename, mime_type, size_bytes, kind)
       values ('${owner}', '${studentId}', '${bucket}', '${path.replace(/'/g, "''")}', 'secret.txt', 'text/plain', 40, 'other') returning id) select id from d`);

// ---- 1. Another practice's file, by path ----------------------------------------------
const victim = await user("sub-victim");
const victimStudent = await studentOf(victim, "sub-victim-student");
const victimPath = `${victimStudent.id}/${tag}-secret.txt`;
await upload(victim, victimPath, "Victim transcript. GPA 3.97. Confidential.");
const victimDoc = await register(victim, { studentId: victimStudent.id, storagePath: victimPath, filename: "secret.txt", kind: "transcript" });
check("the victim's counselor files the document", victimDoc.status === 201, `status ${victimDoc.status}`);

const attacker = await user("sub-attacker");
const attackerStudent = await studentOf(attacker, "sub-attacker-student");

const slash = await register(attackerStudent, { storagePath: `/${victimPath}`, filename: "x.txt" });
check("registering a leading-slash path to another object is refused", slash.status === 400, `status ${slash.status}`);
const dots = await register(attackerStudent, { storagePath: `${attackerStudent.id}/../${victimPath}`, filename: "x.txt" });
check("registering a dot-segment path is refused", dots.status === 400, `status ${dots.status}`);
const otherBucket = await register(attackerStudent, { bucket: "imports", storagePath: `${attacker.id}/import/file-roster.csv`, filename: "x.txt" });
check("registering a row in another bucket is refused", otherBucket.status === 400, `status ${otherBucket.status}`);
const okBucket = await register(attackerStudent, { bucket: "student-documents", storagePath: `${attackerStudent.id}/${tag}-fine.txt`, filename: "fine.txt" });
check("naming the documents bucket itself still works", okBucket.status === 201, `status ${okBucket.status}`);

const direct = await rest(attackerStudent.token, "POST", "/rest/v1/documents", {
  owner_id: attackerStudent.id, student_id: attackerStudent.id, storage_path: `//${victimPath}`, filename: "x.txt", kind: "other",
});
check("the database refuses the same path through PostgREST", direct.status >= 400, `status ${direct.status}`);
const directBucket = await rest(attackerStudent.token, "POST", "/rest/v1/documents", {
  owner_id: attackerStudent.id, student_id: attackerStudent.id, bucket: "axis-attachments", storage_path: `${attackerStudent.id}/chat/x.txt`, filename: "x.txt", kind: "other",
});
check("…and another bucket through PostgREST", directBucket.status >= 400, `status ${directBucket.status}`);
const moved = await rest(attackerStudent.token, "PATCH", `/rest/v1/documents?id=eq.${okBucket.body.id}`, { storage_path: `////${victimPath}` }, { Prefer: "return=representation" });
check("…and moving an existing row onto it", moved.status >= 400 || (Array.isArray(moved.body) && moved.body.length === 0), `status ${moved.status}`);

// A row written past the API (an older row, or before the migration) still can't steer the read.
// (Each attempt uses another count of leading slashes: storage-js strips them all, the unique index sees new text.)
const evilSlash = await docRow(attackerStudent.id, attackerStudent.id, "student-documents", `///${victimPath}`);
const evilImports = await docRow(attackerStudent.id, attackerStudent.id, "imports", `${attacker.id}/x/y-roster.csv`);
const t1 = await task(attacker, attackerStudent.id, "Transcript");
const r1 = await call(attackerStudent.token, "POST", `/tasks/${t1}/submissions`, { documentId: evilSlash });
check("a leading-slash row is never downloaded for AxIS", r1.status === 201 && r1.body.review?.reason === COULDNT_OPEN, JSON.stringify(r1.body.review));
const t2 = await task(attacker, attackerStudent.id, "Resume");
const r2 = await call(attackerStudent.token, "POST", `/tasks/${t2}/submissions`, { documentId: evilImports });
check("a row naming the imports bucket is never downloaded for AxIS", r2.status === 201 && r2.body.review?.reason === COULDNT_OPEN, JSON.stringify(r2.body.review));

// The control: the student's own file is downloaded (and stops only at the missing key).
const ownPath = `${attackerStudent.id}/${tag}-own.txt`;
await upload(attackerStudent, ownPath, "My own transcript. GPA 3.5.");
const ownDoc = await register(attackerStudent, { storagePath: ownPath, filename: "own.txt" });
const t3 = await task(attacker, attackerStudent.id, "Activity list");
const r3 = await call(attackerStudent.token, "POST", `/tasks/${t3}/submissions`, { documentId: ownDoc.body.id });
check("the student's own file still reaches AxIS", r3.status === 201 && (r3.body.review?.status === "checking" || r3.body.review?.reason === NOT_SET_UP), JSON.stringify(r3.body.review));

// ---- 2. The per-document AI rule -----------------------------------------------------
const ruleTask = async (title) => task(attacker, attackerStudent.id, title);
const iep = await register(attacker, { studentId: attackerStudent.id, storagePath: `${attackerStudent.id}/${tag}-iep.pdf`, filename: "iep.pdf", kind: "iep-504" });
const excluded = await register(attacker, { studentId: attackerStudent.id, storagePath: `${attackerStudent.id}/${tag}-tr.pdf`, filename: "tr.pdf", kind: "transcript", aiAccess: "excluded" });
const waived = await register(attacker, { studentId: attackerStudent.id, storagePath: `${attackerStudent.id}/${tag}-rec.pdf`, filename: "rec.pdf", kind: "recommendation-letter", ferpaWaived: true });
check("the counselor files the three restricted documents", [iep, excluded, waived].every((d) => d.status === 201), [iep, excluded, waived].map((d) => d.status).join(","));
const ri = await call(attacker.token, "POST", `/tasks/${await ruleTask("IEP")}/submissions`, { documentId: iep.body.id });
check("an IEP/504 file handed in is not read by AxIS", /kind of file/.test(ri.body.review?.reason ?? ""), JSON.stringify(ri.body.review));
const re = await call(attacker.token, "POST", `/tasks/${await ruleTask("Excluded transcript")}/submissions`, { documentId: excluded.body.id });
check("a file set to stay out of AI is not read by AxIS", /stay out of AI/.test(re.body.review?.reason ?? ""), JSON.stringify(re.body.review));
const rw = await call(attacker.token, "POST", `/tasks/${await ruleTask("Letter")}/submissions`, { documentId: waived.body.id });
check("a waived recommendation letter is never read by AxIS", /waived/.test(rw.body.review?.reason ?? ""), JSON.stringify(rw.body.review));
const recheck = await call(attacker.token, "POST", `/tasks/${ri.body.task?.id}/review`, {});
check("…and Check again refuses it too", /kind of file/.test(recheck.body.review?.reason ?? ""), JSON.stringify(recheck.body.review));

// ---- 3. Flooding the counselor ---------------------------------------------------------
const fc = await user("sub-flood-counselor");
const fs = await studentOf(fc, "sub-flood-student");
const notices = () => sql(`select count(*) from public.notifications where recipient_id = '${fc.id}' and student_id = '${fs.id}' and title like '%handed in%'`).then(Number);
const zip = async (i) => (await register(fs, { storagePath: `${fs.id}/${tag}-${i}-notes.zip`, filename: `notes-${i}.zip` })).body.id;
const ft = await task(fc, fs.id, "Transcript");
const first = await zip(0);
const h1 = await call(fs.token, "POST", `/tasks/${ft}/submissions`, { documentId: first });
check("the student hands a file in", h1.status === 201 && h1.body.review?.status === "skipped", `status ${h1.status}`);
check("…and the counselor hears once", (await notices()) === 1, String(await notices()));
const h2 = await call(fs.token, "POST", `/tasks/${ft}/submissions`, { documentId: first });
check("handing in the same file again while it waits changes nothing", h2.status === 200 && /already handed in/.test(h2.body.review?.reason ?? ""), `status ${h2.status} ${JSON.stringify(h2.body.review)}`);
check("…and tells the counselor nothing new", (await notices()) === 1, String(await notices()));
const statuses = [];
for (let i = 1; i <= 6; i++) statuses.push((await call(fs.token, "POST", `/tasks/${ft}/submissions`, { documentId: await zip(i) })).status);
check("hand-ins on one task are capped (the seventh in an hour is refused)", statuses.slice(0, 5).every((s) => s === 201) && statuses[5] === 429, statuses.join(","));
check("…and the counselor hears at most three times an hour about one task", (await notices()) <= 3, String(await notices()));
const mails = Number(await sql(`select count(*) from public.message_deliveries where template = 'submission-review-counselor' and recipient_id = '${fc.id}'`));
check("…by email too", mails <= 3, String(mails));
const subject = await sql(`select coalesce(subject, '') from public.message_deliveries where template = 'submission-review-counselor' and recipient_id = '${fc.id}' limit 1`);
check("the counselor's email subject doesn't carry the task title", subject === "" || !subject.includes("Transcript"), subject);

// ---- 4. New student's Submit, again and again -------------------------------------------
const ic = await user("sub-intake-counselor");
const is = await user("sub-intake-student", "student");
const invite = await call(ic.token, "POST", "/invites", { email: is.email, source: "intake", fullName: "Intake Student", intakeRequests: [{ id: "transcript", label: "Transcript" }] });
check("the counselor asks for a transcript", invite.status === 201, `status ${invite.status}`);
const inviteId = invite.body.invitation?.id ?? invite.body.id;
const token = await sql(`select token from invitations where id='${inviteId}'`);
await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
  method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${is.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_token: token }),
});
const mine = await call(is.token, "GET", "/me/intake");
const intakeTask = mine.body.intake?.tasks?.[0];
const intakePath = `${is.id}/${tag}-transcript.txt`;
await upload(is, intakePath, "Transcript for Intake Student.");
const intakeDoc = await register(is, { storagePath: intakePath, filename: "transcript.txt" });
await call(is.token, "POST", `/tasks/${intakeTask?.id}/submissions`, { documentId: intakeDoc.body.id });
const told = () => sql(`select count(*) from public.notifications where recipient_id = '${ic.id}' and title like '%sent what you asked for%'`).then(Number);
const s1 = await call(is.token, "POST", "/me/intake/submit", {});
check("the student submits", s1.status === 200 && s1.body.intake?.submittedAt, `status ${s1.status}`);
check("…and the counselor is told once", (await told()) === 1, String(await told()));
const stamp = await sql(`select submitted_at from invitations where id = '${inviteId}'`);
const s2 = await call(is.token, "POST", "/me/intake/submit", {});
const s3 = await call(is.token, "POST", "/me/intake/submit", {});
check("submitting again answers calmly", s2.status === 200 && s3.status === 200, `${s2.status} ${s3.status}`);
check("…tells the counselor nothing new", (await told()) === 1, String(await told()));
const mailed = Number(await sql(`select count(*) from public.message_deliveries where template = 'intake-submitted-counselor' and recipient_id = '${ic.id}'`));
check("…emails nothing new", mailed <= 1, String(mailed));
const hasFix = (await sql(`select count(*) from pg_proc where proname = 'submit_intake' and prosrc like '%not in (''complete'', ''review'')%'`)) === "1";
if (hasFix) {
  check("…and the database doesn't re-stamp the submission", (await sql(`select submitted_at from invitations where id = '${inviteId}'`)) === stamp);
} else {
  console.log("SKIP  submit_intake re-stamp check: 20261024000043 is not applied");
}
