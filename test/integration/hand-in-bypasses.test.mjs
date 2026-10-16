// Three ways around the first round of hand-in fixes, each an attack that
// worked against it:
//   1. a student takes a submitted New student item back (status to
//      in-progress) and presses Submit again, in a loop: every round re-read
//      the files and re-emailed the counselor;
//   2. anyone registers a documents row at the name of an object that has no
//      row (a deleted file's object stays in the bucket) and so reads it;
//   3. a hand-in limit spent by the student locks their counselor out.
// Database checks run only once their migration is applied; the API's own
// rules are checked either way.
import { user, call, check, sql, rest } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const tag = Date.now();

async function upload(who, path, text) {
  const r = await fetch(`${SB}/storage/v1/object/student-documents/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${who.token}`, "Content-Type": "text/plain" },
    body: Buffer.from(text),
  });
  if (!r.ok) throw new Error(`storage upload ${r.status} ${await r.text()}`);
}

async function download(who, path) {
  const r = await fetch(`${SB}/storage/v1/object/authenticated/student-documents/${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${who.token}` },
  });
  return { status: r.status, text: r.ok ? await r.text() : "" };
}

const register = (who, body) => call(who.token, "POST", "/files/documents", { mimeType: "text/plain", sizeBytes: 40, filename: "f.txt", ...body });
const objectCount = (path) => sql(`select count(*) from storage.objects where bucket_id = 'student-documents' and name = '${path}'`).then(Number);
const hasFn = async (name, fragment) =>
  (await sql(`select count(*) from pg_proc where proname = '${name}' and prosrc like '%${fragment.replace(/'/g, "''")}%'`)) !== "0";

// ---- 1. Take a submitted item back, Submit again ----------------------------------------
{
  const ic = await user("bypass-intake-counselor");
  const is = await user("bypass-intake-student", "student");
  const invite = await call(ic.token, "POST", "/invites", {
    email: is.email, source: "intake", fullName: "Loop Student",
    intakeRequests: [{ id: "transcript", label: "Transcript" }],
  });
  check("the counselor asks for a transcript", invite.status === 201, `status ${invite.status}`);
  const inviteId = invite.body.invitation?.id ?? invite.body.id;
  const token = await sql(`select token from invitations where id='${inviteId}'`);
  await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
    method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${is.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_token: token }),
  });
  const item = (await call(is.token, "GET", "/me/intake")).body.intake?.tasks?.[0];
  const path = `${is.id}/${tag}-transcript.txt`;
  await upload(is, path, "Transcript for Loop Student.");
  const doc = await register(is, { storagePath: path, filename: "transcript.txt" });
  await call(is.token, "POST", `/tasks/${item?.id}/submissions`, { documentId: doc.body.id });

  const told = () => sql(`select count(*) from public.notifications where recipient_id = '${ic.id}' and title like '%sent what you asked for%'`).then(Number);
  const mailed = () => sql(`select count(*) from public.message_deliveries where template = 'intake-submitted-counselor' and recipient_id = '${ic.id}'`).then(Number);

  const early = await call(is.token, "PATCH", `/tasks/${item?.id}`, { status: "review" });
  check("a student can't send an item to review without Submit", early.status === 409, `status ${early.status}`);

  const s1 = await call(is.token, "POST", "/me/intake/submit", {});
  check("the student submits", s1.status === 200, `status ${s1.status}`);
  check("…and the counselor is told once", (await told()) === 1, String(await told()));

  const back = await call(is.token, "PATCH", `/tasks/${item?.id}`, { status: "in-progress" });
  check("the student can't take a submitted item back through the API", back.status === 409, `status ${back.status}`);
  check("…it stays with the counselor", (await sql(`select status from deliverables where id = '${item?.id}'`)) === "review");

  const dbLock = await hasFn("deliverables_guard_student_edits", "This is with your counselor now");
  const direct = await rest(is.token, "PATCH", `/rest/v1/deliverables?id=eq.${item?.id}`, { status: "in-progress" }, { Prefer: "return=representation" });
  if (dbLock) {
    check("…nor through PostgREST", direct.status >= 400, `status ${direct.status}`);
  } else {
    console.log("SKIP  PostgREST status lock: 20261024000044 is not applied");
  }

  // The loop: take it back (any way that works) and Submit, again and again.
  for (let i = 0; i < 6; i++) {
    await rest(is.token, "PATCH", `/rest/v1/deliverables?id=eq.${item?.id}`, { status: "in-progress" });
    await call(is.token, "PATCH", `/tasks/${item?.id}`, { status: "in-progress" });
    await call(is.token, "POST", "/me/intake/submit", {});
  }
  check("a loop of take-back-and-Submit tells the counselor at most three times a day", (await told()) <= 3, String(await told()));
  check("…and emails at most three times", (await mailed()) <= 3, String(await mailed()));
  if (dbLock) check("…and with the database lock, not once more", (await told()) === 1, String(await told()));

  // The honest round still works: the counselor sends it back, the student resubmits.
  const sent = await call(ic.token, "PATCH", `/invites/${inviteId}`, { sendBack: { requestId: "transcript", note: "Please send the official copy." } });
  check("the counselor sends the item back", sent.status === 200, `status ${sent.status} ${JSON.stringify(sent.body).slice(0, 160)}`);
  const path2 = `${is.id}/${tag}-transcript-2.txt`;
  await upload(is, path2, "Official transcript for Loop Student.");
  const doc2 = await register(is, { storagePath: path2, filename: "transcript-official.txt" });
  const attach = await call(is.token, "POST", `/tasks/${item?.id}/submissions`, { documentId: doc2.body.id });
  check("…the student attaches the new file", attach.status === 201, `status ${attach.status}`);
  const before = await told();
  const s2 = await call(is.token, "POST", "/me/intake/submit", {});
  check("…and submits again", s2.status === 200 && (await sql(`select status from deliverables where id = '${item?.id}'`)) === "review", `status ${s2.status}`);
  check("…and the counselor hears about it", (await told()) === before + 1 || (await told()) === 3, `${before} -> ${await told()}`);

  // Received: the student can't reopen it either.
  await call(ic.token, "PATCH", `/invites/${inviteId}`, { receive: { requestId: "transcript", received: true } });
  const reopen = await call(is.token, "PATCH", `/tasks/${item?.id}`, { status: "in-progress" });
  check("a received item can't be reopened by the student", reopen.status === 409, `status ${reopen.status}`);

}

// ---- 2. A row at an object with no row --------------------------------------------------
{
  const owner = await user("claim-owner");
  const ownerStudent = await studentOf(owner, "claim-owner-student");
  const stranger = await user("claim-stranger");
  const strangerStudent = await studentOf(stranger, "claim-stranger-student");

  // An object with no row: uploaded and never registered (or its row deleted).
  const orphan = `unfiled/${tag}-orphan-transcript.txt`;
  await upload(ownerStudent, orphan, "Orphaned transcript. GPA 3.91. Confidential.");
  const inFolder = `${ownerStudent.id}/${tag}-orphan-essay.txt`;
  await upload(ownerStudent, inFolder, "Orphaned essay. Confidential.");
  check("the stranger can't read the orphaned object to begin with", (await download(strangerStudent, orphan)).status >= 400);

  const claim = await register(strangerStudent, { storagePath: orphan });
  check("a stranger can't register a row at another user's object", claim.status === 400, `status ${claim.status}`);
  const claim2 = await register(stranger, { studentId: strangerStudent.id, storagePath: orphan });
  check("…nor can another practice's counselor", claim2.status === 400, `status ${claim2.status}`);
  const elsewhere = await register(strangerStudent, { storagePath: inFolder });
  check("…nor register under a student they can't edit", elsewhere.status === 400, `status ${elsewhere.status}`);
  const fresh = await register(strangerStudent, { storagePath: `unfiled/${tag}-nothing-here.txt` });
  check("…though a path with no object still registers", fresh.status === 201, `status ${fresh.status}`);
  check("after trying through the API the stranger still can't read the object", !(await download(strangerStudent, orphan)).text.includes("Confidential"));

  const dbClaims = await hasFn("documents_guard_storage_path", "document_path_taken_by_other");
  const viaRest = await rest(strangerStudent.token, "POST", "/rest/v1/documents", {
    owner_id: strangerStudent.id, student_id: strangerStudent.id, storage_path: orphan, filename: "x.txt", kind: "other",
  });
  const viaRest2 = await rest(strangerStudent.token, "POST", "/rest/v1/documents", {
    owner_id: strangerStudent.id, student_id: strangerStudent.id, storage_path: inFolder, filename: "x.txt", kind: "other",
  });
  if (dbClaims) {
    check("the database refuses the same claim through PostgREST", viaRest.status >= 400, `status ${viaRest.status}`);
    check("…and a row under a student the writer can't edit", viaRest2.status >= 400, `status ${viaRest2.status}`);
  } else {
    console.log("SKIP  PostgREST claim checks: 20261024000045 is not applied");
    // Clean up what the old database let through so the read check below means the API's rule.
    await sql(`delete from public.documents where storage_path in ('${orphan}', '${inFolder}') and owner_id = '${strangerStudent.id}'`);
  }
  check("the stranger still can't read the object", !(await download(strangerStudent, orphan)).text.includes("Confidential"));

  // The uploader may still register their own orphan.
  const mine = await register(ownerStudent, { storagePath: orphan, filename: "transcript.txt" });
  check("the uploader can register their own object", mine.status === 201, `status ${mine.status}`);

  // A counselor deleting the student's file removes the object, so nothing is left to claim.
  check("the object is there while its row is", (await objectCount(orphan)) === 1);
  const del = await call(owner.token, "DELETE", `/files/documents/${mine.body.id}`);
  check("the counselor deletes the student's document", del.status === 200, `status ${del.status}`);
  check("…and its object goes with it", (await objectCount(orphan)) === 0, String(await objectCount(orphan)));
}

// ---- 3. The student's hand-in count doesn't hold their counselor -----------------------
{
  const c = await user("handin-limit-counselor");
  const s = await studentOf(c, "handin-limit-student");
  const t = await call(c.token, "POST", "/tasks", { studentId: s.id, kind: "document", title: "Resume" });
  const zip = async (who, i) => (await register(who, { studentId: s.id, storagePath: `${s.id}/${tag}-${i}-notes.zip`, filename: `notes-${i}.zip` })).body.id;
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await call(s.token, "POST", `/tasks/${t.body.id}/submissions`, { documentId: await zip(s, `s${i}`) })).status);
  check("the student hits the per-task hand-in cap", statuses[6] === 429, statuses.join(","));
  const byCounselor = await call(c.token, "POST", `/tasks/${t.body.id}/submissions`, { documentId: await zip(c, "c0") });
  check("…and the counselor can still hand in for them", byCounselor.status === 201, `status ${byCounselor.status}`);
}
