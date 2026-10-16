// RLS and ownership: the table-level paths a signed-in user could take
// straight through PostgREST (or through a route that trusted them), each
// tried as the attacker would, then the legitimate path beside it to show it
// still works. Migrations 20261024000021-25 and the code checks that go with
// them.
import { API, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const q = (s) => String(s).replace(/'/g, "''");
const one = (query) => sql(query);
const count = async (query) => Number(await sql(query));
const rpc = (token, fn, args) => rest(token, "POST", `/rest/v1/rpc/${fn}`, args);
const cron = (path) => fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const tag = `${Date.now()}`;

// Two practices. A is the attacker's, B the victim's.
const attacker = await user("own-attacker");
const victim = await user("own-victim");
const victimStudent = await studentOf(victim, "own-victim-student");
const attackerStudent = await studentOf(attacker, "own-attacker-student");

// ---- 1. A student can't archive themselves ---------------------------------------------------
{
  const s = await studentOf(victim, "own-self-archiver");
  const api = await call(s.token, "PATCH", `/students/${s.id}`, { archived: true });
  check("student: PATCH /students/<self> { archived } is refused", api.status === 403, `status ${api.status}`);
  const direct = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { archived_at: new Date().toISOString() });
  check("student: a direct PostgREST write of archived_at is refused", direct.status >= 400, `status ${direct.status}`);
  check("...and the student is still on the roster", (await one(`select coalesce(archived_at::text, 'none') from public.profiles where id = '${s.id}'`)) === "none");
  const headline = await call(s.token, "PATCH", `/students/${s.id}`, { headline: "Still here" });
  check("student: other edits of their own record still work", headline.status === 200, `status ${headline.status}`);

  await sql(`update public.profiles set archived_at = now() where id = '${s.id}'`);
  const back = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { archived_at: null });
  check("student: an archived student can't restore themselves directly", back.status >= 400 && (await one(`select (archived_at is not null)::text from public.profiles where id = '${s.id}'`)) === "true", `status ${back.status}`);
  const apiBack = await call(s.token, "PATCH", `/students/${s.id}`, { archived: false });
  check("student: ...nor through the API", apiBack.status === 403, `status ${apiBack.status}`);

  const restore = await call(victim.token, "PATCH", `/students/${s.id}`, { archived: false });
  check("counselor: restores their student", restore.status === 200 && (await one(`select coalesce(archived_at::text, 'none') from public.profiles where id = '${s.id}'`)) === "none", `status ${restore.status}`);
  const archive = await call(victim.token, "PATCH", `/students/${s.id}`, { archived: true });
  check("counselor: archives their student", archive.status === 200 && (await one(`select (archived_at is not null)::text from public.profiles where id = '${s.id}'`)) === "true", `status ${archive.status}`);
}

// ---- 2. Firm membership only through the firm functions ----------------------------------------
{
  const made = await rpc(attacker.token, "create_firm", { p_name: `Attacker firm ${tag}` });
  check("create_firm still works", made.status === 200, JSON.stringify(made.body));
  const firm = String(made.body);

  const add = await rest(attacker.token, "POST", "/rest/v1/firm_members", { firm_id: firm, profile_id: victim.id, seat_role: "counselor" });
  check("firm admin: can't insert another practice's counselor into firm_members", add.status >= 400, `status ${add.status}`);
  check("...no row was written", (await count(`select count(*) from public.firm_members where profile_id = '${victim.id}'`)) === 0);
  const roster = await rpc(attacker.token, "firm_consultant_students", { p_consultant: victim.id });
  const leaked = Array.isArray(roster.body) && roster.body.some((r) => r.id === victimStudent.id || r.student_id === victimStudent.id);
  check("...so the victim's roster stays private", !leaked, JSON.stringify(roster.body).slice(0, 200));

  // An admin trying to take the owner's seat.
  const owner = await user("own-firm-owner");
  const admin = await user("own-firm-admin");
  const f2 = String((await rpc(owner.token, "create_firm", { p_name: `Owner firm ${tag}` })).body);
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${f2}', '${admin.id}', 'admin')`);
  await sql(`update public.profiles set firm_id = '${f2}' where id = '${admin.id}'`);

  const steal = await rest(admin.token, "PATCH", `/rest/v1/firms?id=eq.${f2}`, { owner_id: admin.id });
  check("firm admin: can't write firms.owner_id", steal.status >= 400 && (await one(`select owner_id from public.firms where id = '${f2}'`)) === owner.id, `status ${steal.status}`);
  const seats = await rest(admin.token, "PATCH", `/rest/v1/firms?id=eq.${f2}`, { seats: 500 });
  check("firm admin: can't write firms.seats", seats.status >= 400 && (await one(`select seats::text from public.firms where id = '${f2}'`)) === "10", `status ${seats.status}`);
  const kick = await rest(admin.token, "DELETE", `/rest/v1/firm_members?firm_id=eq.${f2}&profile_id=eq.${owner.id}`);
  check("firm admin: can't delete the owner's membership", (await count(`select count(*) from public.firm_members where firm_id = '${f2}' and profile_id = '${owner.id}'`)) === 1, `status ${kick.status}`);
  const demote = await rest(owner.token, "PATCH", `/rest/v1/firm_members?firm_id=eq.${f2}&profile_id=eq.${owner.id}`, { seat_role: "assistant" });
  const promote = await rest(admin.token, "PATCH", `/rest/v1/firm_members?firm_id=eq.${f2}&profile_id=eq.${admin.id}`, { seat_role: "owner" });
  check("nobody changes a seat with a direct write", (await one(`select string_agg(seat_role, ',' order by seat_role) from public.firm_members where firm_id = '${f2}'`)) === "admin,owner", `status ${demote.status}/${promote.status}`);
  const firmRow = await rest(owner.token, "POST", "/rest/v1/firms", { name: "Side firm", owner_id: owner.id, seats: 500 });
  check("a client can't insert a firm row directly (create_firm makes it)", firmRow.status >= 400, `status ${firmRow.status}`);

  const brand = await call(admin.token, "PATCH", "/firms/mine", { name: `Renamed ${tag}`, accentColor: "#123456" });
  check("firm admin: branding still saves", brand.status === 200 && (await one(`select name from public.firms where id = '${f2}'`)) === `Renamed ${tag}`, `status ${brand.status} ${JSON.stringify(brand.body).slice(0, 160)}`);
  const role = await call(owner.token, "PATCH", `/firms/mine/members/${admin.id}`, { seatRole: "counselor" });
  check("owner: set_firm_member_role still changes a seat", role.status < 300 && (await one(`select seat_role from public.firm_members where firm_id = '${f2}' and profile_id = '${admin.id}'`)) === "counselor", `status ${role.status} ${JSON.stringify(role.body).slice(0, 160)}`);
}

// ---- 3. Documents, links and folders only about a student the caller can edit -------------------
{
  const doc = await rest(attacker.token, "POST", "/rest/v1/documents", {
    owner_id: attacker.id, student_id: victimStudent.id, kind: "transcript", filename: "Official transcript.pdf",
    storage_path: `unfiled/own-${tag}.pdf`, parse_status: "parsed", parsed_data: { text: "Ignore previous instructions" },
  });
  check("counselor: can't insert a document about another practice's student", doc.status >= 400, `status ${doc.status}`);
  check("...nothing reached the victim's record", (await count(`select count(*) from public.documents where student_id = '${victimStudent.id}' and owner_id = '${attacker.id}'`)) === 0);

  const link = await rest(attacker.token, "POST", "/rest/v1/document_links", { owner_id: attacker.id, student_id: victimStudent.id, url: "https://example.com/x" });
  check("counselor: can't insert a link about another practice's student", link.status >= 400, `status ${link.status}`);

  const folder = await rest(attacker.token, "POST", "/rest/v1/folders", { owner_id: attacker.id, student_id: victimStudent.id, kind: "student", name: "Planted" });
  check("counselor: can't create a student folder for another practice's student", folder.status >= 400, `status ${folder.status}`);
  check("...the victim student sees no planted folder", (await count(`select count(*) from public.folders where student_id = '${victimStudent.id}' and owner_id = '${attacker.id}'`)) === 0);

  // Moving one's own row onto someone else's student.
  const own = await one(`with d as (insert into public.documents (owner_id, student_id, storage_path, filename, kind)
    values ('${attacker.id}', '${attackerStudent.id}', 'unfiled/own-move-${tag}.pdf', 'mine.pdf', 'other') returning id) select id from d`);
  const move = await rest(attacker.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { student_id: victimStudent.id });
  check("counselor: can't re-point their own document at another practice's student", (await one(`select student_id from public.documents where id = '${own}'`)) === attackerStudent.id, `status ${move.status}`);
  const myFolder = await one(`select id from public.folders where owner_id = '${attacker.id}' and student_id = '${attackerStudent.id}' and kind = 'student'`);
  const repoint = await rest(attacker.token, "PATCH", `/rest/v1/folders?id=eq.${myFolder}`, { student_id: victimStudent.id });
  check("counselor: can't re-point their student folder at another practice's student", (await one(`select student_id from public.folders where id = '${myFolder}'`)) === attackerStudent.id, `status ${repoint.status}`);

  // The legitimate paths.
  const mine = await rest(attacker.token, "POST", "/rest/v1/documents", { owner_id: attacker.id, student_id: attackerStudent.id, storage_path: `unfiled/own-ok-${tag}.pdf`, filename: "ok.pdf", kind: "other" }, { Prefer: "return=representation" });
  check("counselor: a document about their own student still saves", mine.status === 201, `status ${mine.status} ${JSON.stringify(mine.body).slice(0, 160)}`);
  const api = await call(attacker.token, "POST", "/files/documents", { studentId: attackerStudent.id, storagePath: `${attackerStudent.id}/own-api-${tag}.pdf`, filename: "api.pdf" });
  check("counselor: POST /files/documents files into the student's folder", api.status === 201 && api.body.folderId === myFolder, `status ${api.status} ${JSON.stringify(api.body).slice(0, 160)}`);
  const studentUp = await call(attackerStudent.token, "POST", "/files/documents", { storagePath: `${attackerStudent.id}/own-student-${tag}.pdf`, filename: "me.pdf" });
  check("student: their own upload still lands in My documents", studentUp.status === 201, `status ${studentUp.status} ${JSON.stringify(studentUp.body).slice(0, 160)}`);
  const plain = await call(attacker.token, "POST", "/files/folders", { name: `Plain ${tag}` });
  check("counselor: a plain folder still saves", plain.status === 201, `status ${plain.status}`);
  const rename = await call(attacker.token, "PATCH", `/files/folders/${myFolder}`, { name: "Renamed student folder" });
  check("counselor: renaming their student's folder still works", rename.status === 200, `status ${rename.status}`);

  // A write collaborator from the same practice may file about the shared student.
  const collab = await user("own-collab");
  await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${attackerStudent.id}', '${collab.id}', 'write')`);
  const shared = await rest(collab.token, "POST", "/rest/v1/documents", { owner_id: collab.id, student_id: attackerStudent.id, folder_id: myFolder, storage_path: `${attackerStudent.id}/own-collab-${tag}.pdf`, filename: "collab.pdf", kind: "other" });
  check("write collaborator: files a document about the shared student into its folder", shared.status === 201, `status ${shared.status} ${JSON.stringify(shared.body).slice(0, 160)}`);
  const readOnly = await user("own-collab-ro");
  await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${attackerStudent.id}', '${readOnly.id}', 'read')`);
  const ro = await rest(readOnly.token, "POST", "/rest/v1/documents", { owner_id: readOnly.id, student_id: attackerStudent.id, storage_path: `unfiled/own-ro-${tag}.pdf`, filename: "ro.pdf", kind: "other" });
  check("read-only collaborator: can't file a document about the shared student", ro.status >= 400, `status ${ro.status}`);
  const foreignFolder = await rest(attacker.token, "POST", "/rest/v1/documents", { owner_id: attacker.id, student_id: null, folder_id: await one(`select id from public.folders where owner_id = '${victim.id}' and kind = 'student' limit 1`), storage_path: `unfiled/own-ff-${tag}.pdf`, filename: "ff.pdf", kind: "other" });
  check("counselor: can't file into another practice's folder", foreignFolder.status >= 400, `status ${foreignFolder.status}`);
}

// ---- 4. Only accept_invitation marks an invitation accepted --------------------------------------
{
  const inv = await call(attacker.token, "POST", "/invites", {
    email: `own-inv-${tag}@test.local`, source: "intake", fullName: "Forged Joiner",
    intakeRequests: [{ id: "r1", label: "Transcript" }],
  });
  check("counselor creates an invitation", inv.status === 201, `status ${inv.status}`);
  const invId = inv.body.invitation?.id ?? inv.body.id;

  const forge = await rest(attacker.token, "PATCH", `/rest/v1/invitations?id=eq.${invId}`, { status: "accepted", accepted_by: victimStudent.id, accepted_at: new Date().toISOString() });
  check("counselor: can't forge an acceptance on their own invitation", forge.status >= 400 && (await one(`select status || ':' || coalesce(accepted_by::text, 'none') from public.invitations where id = '${invId}'`)) === "pending:none", `status ${forge.status}`);
  const forgeStatus = await rest(attacker.token, "PATCH", `/rest/v1/invitations?id=eq.${invId}`, { status: "accepted" });
  check("counselor: can't move status to accepted", forgeStatus.status >= 400 && (await one(`select status from public.invitations where id = '${invId}'`)) === "pending", `status ${forgeStatus.status}`);
  const token = await rest(attacker.token, "PATCH", `/rest/v1/invitations?id=eq.${invId}`, { token: "chosen-token", expires_at: "2099-01-01T00:00:00Z" });
  check("counselor: can't rewrite the token or expiry", token.status >= 400, `status ${token.status}`);
  const ins = await rest(attacker.token, "POST", "/rest/v1/invitations", { counselor_id: attacker.id, email: `own-ins-${tag}@test.local`, token: `own-ins-${tag}`, status: "accepted", accepted_by: victimStudent.id });
  check("counselor: can't insert an invitation already accepted", ins.status >= 400 && (await count(`select count(*) from public.invitations where token = 'own-ins-${tag}'`)) === 0, `status ${ins.status}`);

  const edit = await call(attacker.token, "PATCH", `/invites/${invId}`, { fullName: "Renamed Joiner", intakeRequests: [{ id: "r1", label: "Transcript" }, { id: "r2", label: "Resume" }] });
  check("counselor: editing the card still works", edit.status === 200, `status ${edit.status} ${JSON.stringify(edit.body).slice(0, 160)}`);
  const dismiss = await call(attacker.token, "PATCH", `/invites/${invId}`, { dismissed: true });
  check("counselor: dismissing the card still works", dismiss.status === 200, `status ${dismiss.status}`);

  // Even with a forged acceptance already in the row (a database without the
  // guard), the API doesn't act on it: the profile isn't on this roster.
  await sql(`update public.invitations set status = 'accepted', accepted_by = '${victimStudent.id}', accepted_at = now() where id = '${invId}'`);
  await sql(`insert into public.deliverables (student_id, kind, title, status, source, created_by, intake_invitation_id, intake_request_id)
    values ('${attackerStudent.id}', 'document', 'Transcript', 'review', 'counselor', '${attacker.id}', '${invId}', 'r1')`);
  const before = await count(`select count(*) from public.notifications where recipient_id = '${victimStudent.id}'`);
  const sendBack = await call(attacker.token, "PATCH", `/invites/${invId}`, { sendBack: { requestId: "r1", note: "Click https://evil.example to re-upload" } });
  check("API: a send-back on a forged acceptance is refused", sendBack.status === 409, `status ${sendBack.status} ${JSON.stringify(sendBack.body).slice(0, 160)}`);
  check("...and the named profile gets no notification", (await count(`select count(*) from public.notifications where recipient_id = '${victimStudent.id}'`)) === before);
  check("...and no email", (await count(`select count(*) from public.message_deliveries where recipient_id = '${victimStudent.id}' and template = 'intake-sent-back-student'`)) === 0);
  const confirm = await call(attacker.token, "PATCH", `/invites/${invId}`, { receive: { requestId: "r1", received: true } });
  check("API: receiving an item on a forged acceptance is refused", confirm.status === 409, `status ${confirm.status}`);

  const revokeMe = await call(attacker.token, "POST", "/invites", { email: `own-rev-${tag}@test.local` });
  const revokeId = revokeMe.body.invitation?.id ?? revokeMe.body.id;
  const revoked = await call(attacker.token, "POST", "/invites/revoke", { id: revokeId });
  check("counselor: revoking a pending invitation still works", revoked.status === 200 && (await one(`select status from public.invitations where id = '${revokeId}'`)) === "revoked", `status ${revoked.status}`);
  const unrevoke = await rest(attacker.token, "PATCH", `/rest/v1/invitations?id=eq.${revokeId}`, { status: "pending" });
  check("counselor: a revoked invitation can't be reopened", unrevoke.status >= 400 && (await one(`select status from public.invitations where id = '${revokeId}'`)) === "revoked", `status ${unrevoke.status}`);
}

// ---- 5. A task links only to its own student's invitation -----------------------------------------
{
  const vInv = await one(`with i as (insert into public.invitations (counselor_id, email, token, intake_requests)
    values ('${victim.id}', 'own-v-${tag}@test.local', 'own-v-${tag}', '[{"id":"t1","label":"Transcript","provided":false}]'::jsonb) returning id) select id from i`);
  const planted = await rest(attacker.token, "POST", "/rest/v1/deliverables", {
    student_id: attackerStudent.id, kind: "document", title: "Transcript", source: "counselor", created_by: attacker.id,
    intake_invitation_id: vInv, intake_request_id: "t1",
  });
  check("counselor: can't point a task at another counselor's invitation", planted.status >= 400, `status ${planted.status}`);

  // A link that got in anyway (before the guard) can't tick the other invitation.
  const task = await one(`with d as (insert into public.deliverables (student_id, kind, title, status, source, created_by, intake_invitation_id, intake_request_id)
    values ('${attackerStudent.id}', 'document', 'Transcript', 'in-progress', 'counselor', '${attacker.id}', '${vInv}', 't1')
    on conflict (intake_invitation_id, intake_request_id) where intake_invitation_id is not null do update set status = 'in-progress'
    returning id) select id from d`);
  await rest(attacker.token, "PATCH", `/rest/v1/deliverables?id=eq.${task}`, { status: "complete", progress_pct: 100 });
  check("...and completing such a task doesn't tick the victim's request", (await one(`select coalesce((intake_requests->0->>'provided'), 'false') from public.invitations where id = '${vInv}'`)) === "false");
  const relink = await rest(attacker.token, "PATCH", `/rest/v1/deliverables?id=eq.${task}`, { intake_request_id: "t2" });
  check("counselor: can't change a task's invitation link", relink.status >= 400 && (await one(`select intake_request_id from public.deliverables where id = '${task}'`)) === "t1", `status ${relink.status}`);
}

// ---- 6. Composer messages reach only the student and guardians on file -----------------------------
{
  await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${attacker.id}', 'UTC', null, null) on conflict do nothing`);
  const forged = `[{"kind":"student","id":"${attackerStudent.id}","name":"x","email":"victim-${tag}@elsewhere.test","phone":"+19005550199"}]`;
  const direct = await rest(attacker.token, "POST", "/rest/v1/student_messages", {
    student_id: attackerStudent.id, counselor_id: attacker.id, audience: "student", channel: "email", kind: "message",
    status: "scheduled", scheduled_for: new Date(Date.now() - 60_000).toISOString(), subject: "Hi", body: "Phish",
    recipients: JSON.parse(forged),
  });
  check("counselor: can't insert a message naming arbitrary recipients", direct.status >= 400, `status ${direct.status}`);
  const guardianForged = await rest(attacker.token, "POST", "/rest/v1/student_messages", {
    student_id: attackerStudent.id, counselor_id: attacker.id, audience: "parent", channel: "email", kind: "message",
    status: "queued", subject: "Hi", body: "Phish",
    recipients: [{ kind: "guardian", id: "00000000-0000-4000-8000-000000000000", name: "x", email: `victim2-${tag}@elsewhere.test`, phone: null }],
  });
  check("counselor: can't insert a parent message to someone not on file", guardianForged.status >= 400, `status ${guardianForged.status}`);

  // A forged row that got in anyway (before the guard): dispatch checks it.
  const planted = await one(`with m as (insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status, scheduled_for)
    values ('${attackerStudent.id}', '${attacker.id}', 'student', 'email', '${q(forged)}'::jsonb, 'Hi', 'Phish', 'scheduled', now() - interval '1 minute') returning id) select id from m`);
  const disp = await cron("/communication/internal/dispatch");
  check("the dispatch cron ran", disp.status === 200, `status ${disp.status}`);
  check("dispatch: nothing went to an address that isn't the student's", (await count(`select count(*) from public.message_deliveries where to_email = 'victim-${tag}@elsewhere.test'`)) === 0);
  const plantedStatus = await one(`select status from public.student_messages where id = '${planted}'`);
  check("dispatch: the forged row went, if at all, only to the student's own address", plantedStatus !== "scheduled" && (await count(`select count(*) from public.message_deliveries where student_id = '${attackerStudent.id}' and lower(to_email) <> lower('${q(attackerStudent.email)}')`)) === 0, plantedStatus);

  // A legitimate scheduled message still goes, to the student's own address.
  const sched = await call(attacker.token, "POST", `/communication/${attackerStudent.id}/messages`, {
    audience: "student", channel: "email", subject: "Reminder", body: "Your essay is due Friday.",
    scheduleFor: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  check("counselor: schedules a message through the composer", sched.status === 201 && sched.body.status === "scheduled", `status ${sched.status} ${JSON.stringify(sched.body).slice(0, 200)}`);
  await sql(`update public.student_messages set scheduled_for = now() - interval '1 minute' where id = '${sched.body.id}'`);
  await cron("/communication/internal/dispatch");
  const legit = await one(`select status from public.student_messages where id = '${sched.body.id}'`);
  check("dispatch: the composer's own message leaves the queue", legit !== "scheduled" && legit !== "cancelled", legit);
  check("...addressed to the student's email on file", (await count(`select count(*) from public.message_deliveries where student_id = '${attackerStudent.id}' and lower(to_email) = lower('${q(attackerStudent.email)}')`)) >= 1);

  // A sent row can't be re-armed, and scheduled_for is the cron's.
  const rearm = await rest(attacker.token, "PATCH", `/rest/v1/student_messages?id=eq.${sched.body.id}`, { status: "scheduled" });
  check("counselor: can't move a sent message back to scheduled", rearm.status >= 400 && (await one(`select status from public.student_messages where id = '${sched.body.id}'`)) === legit, `status ${rearm.status}`);
  const later = await call(attacker.token, "POST", `/communication/${attackerStudent.id}/messages`, {
    audience: "student", channel: "email", subject: "Later", body: "Later.", scheduleFor: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const moved = await rest(attacker.token, "PATCH", `/rest/v1/student_messages?id=eq.${later.body.id}`, { scheduled_for: new Date(Date.now() - 60_000).toISOString() });
  check("counselor: can't move scheduled_for directly", moved.status >= 400, `status ${moved.status}`);
  const cancel = await call(attacker.token, "POST", `/communication/messages/${later.body.id}/cancel`);
  check("counselor: cancelling a scheduled message still works", cancel.status === 200 && cancel.body.status === "cancelled", `status ${cancel.status}`);
  const now = await call(attacker.token, "POST", `/communication/${attackerStudent.id}/messages`, {
    audience: "student", channel: "email", subject: "Now", body: "Sent now.", overrideQuietHours: true,
  });
  check("counselor: an immediate send still records its outcome", now.status === 201 && now.body.status !== "queued", `status ${now.status} ${JSON.stringify(now.body).slice(0, 200)}`);
}

// ---- 7. Follow-up: no oracle, capped volume, the student's current address -------------------------
{
  // A direct insert for someone else's student fails the same way whether the
  // address guessed is right or wrong, for a student, a counselor or a guardian.
  const g = await one(`with g as (insert into public.guardians (student_id, full_name, email, alerts_enabled)
    values ('${victimStudent.id}', 'Victim Parent', 'parent-${tag}@victim.test', true) returning id) select id from g`);
  const probe = (who, row) => rest(who.token, "POST", "/rest/v1/student_messages", {
    counselor_id: who.id, kind: "message", status: "scheduled", scheduled_for: new Date(Date.now() + 3_600_000).toISOString(),
    subject: "Hi", body: "Probe", ...row,
  });
  const asStudent = (id, email) => ({ student_id: id, audience: "student", channel: "email", recipients: [{ kind: "student", id, name: "x", email, phone: null }] });
  const shape = (r) => `${r.status}:${r.body?.code}:${r.body?.message}`;
  const right = await probe(attacker, asStudent(victimStudent.id, victimStudent.email));
  const wrong = await probe(attacker, asStudent(victimStudent.id, `nobody-${tag}@victim.test`));
  check("oracle: a right and a wrong guess at another student's email fail alike", shape(right) === shape(wrong) && right.status >= 400, `${shape(right)} | ${shape(wrong)}`);
  const rightC = await probe(attacker, asStudent(victim.id, victim.email));
  const wrongC = await probe(attacker, asStudent(victim.id, `nobody2-${tag}@victim.test`));
  check("oracle: ...and at a counselor's", shape(rightC) === shape(wrongC) && rightC.status >= 400, `${shape(rightC)} | ${shape(wrongC)}`);
  const asParent = (email) => ({ student_id: victimStudent.id, audience: "parent", channel: "email", recipients: [{ kind: "guardian", id: g, name: "x", email, phone: null }] });
  const rightG = await probe(attacker, asParent(`parent-${tag}@victim.test`));
  const wrongG = await probe(attacker, asParent(`other-${tag}@victim.test`));
  check("oracle: ...and at a guardian's", shape(rightG) === shape(wrongG) && rightG.status >= 400, `${shape(rightG)} | ${shape(wrongG)}`);
  const stu = await studentOf(attacker, "own-oracle-student");
  const rightS = await probe(stu, asStudent(victimStudent.id, victimStudent.email));
  const wrongS = await probe(stu, asStudent(victimStudent.id, `nobody3-${tag}@victim.test`));
  check("oracle: ...and for a student caller", shape(rightS) === shape(wrongS) && rightS.status >= 400, `${shape(rightS)} | ${shape(wrongS)}`);
  check("...and none of the probes was written", (await count(`select count(*) from public.student_messages where body = 'Probe'`)) === 0);

  // Volume: a counselor's direct inserts are capped in the database.
  const vol = await user("own-volume");
  const volStudent = await studentOf(vol, "own-volume-student");
  await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${vol.id}', 'UTC', null, null) on conflict do nothing`);
  const legitRow = { student_id: volStudent.id, audience: "student", channel: "email", recipients: [{ kind: "student", id: volStudent.id, name: "x", email: volStudent.email, phone: null }] };
  const first = await probe(vol, { ...legitRow, body: "Direct one" });
  check("a direct insert to the counselor's own student at the address on file passes the guard", first.status === 201, `status ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
  await sql(`update private.rate_limit_buckets set count = 200 where key = 'student-messages-insert:${vol.id}'`);
  const over = await probe(vol, { ...legitRow, body: "Direct two hundred and one" });
  check("volume: the 201st direct insert in a day is refused", over.status >= 400 && (await count(`select count(*) from public.student_messages where body = 'Direct two hundred and one'`)) === 0, `status ${over.status}`);
  const viaRoute = await call(vol.token, "POST", `/communication/${volStudent.id}/messages`, {
    audience: "student", channel: "email", subject: "Route", body: "Through the composer.", scheduleFor: new Date(Date.now() + 3_600_000).toISOString(),
  });
  check("volume: ...and the composer answers that cap as a 429, not a database error", viaRoute.status === 429, `status ${viaRoute.status} ${JSON.stringify(viaRoute.body).slice(0, 160)}`);
  await sql(`delete from private.rate_limit_buckets where key = 'student-messages-insert:${vol.id}'`);

  // Volume at dispatch: past the counselor's daily cap a due row waits, it isn't sent or dropped.
  const due = await one(`with m as (insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status, scheduled_for)
    values ('${volStudent.id}', '${vol.id}', 'student', 'email', '${q(JSON.stringify(legitRow.recipients))}'::jsonb, 'Due', 'Due now', 'scheduled', now() - interval '1 minute') returning id) select id from m`);
  await sql(`insert into private.rate_limit_buckets (key, window_start, count) values ('communication:dispatch:${vol.id}', now(), 100)
    on conflict (key) do update set window_start = now(), count = 100`);
  await cron("/communication/internal/dispatch");
  const held = await one(`select status || '|' || (scheduled_for > now())::text || '|' || coalesce(hold_reason, '') from public.student_messages where id = '${due}'`);
  check("dispatch cap: over the day's cap a due message stays scheduled for later", held.startsWith("scheduled|true|Held"), held);
  check("...and nothing was sent for it", (await count(`select count(*) from public.message_deliveries where student_id = '${volStudent.id}'`)) === 0);
  await sql(`delete from private.rate_limit_buckets where key = 'communication:dispatch:${vol.id}'`);
  await sql(`update public.student_messages set scheduled_for = now() - interval '1 minute' where id = '${due}'`);
  await cron("/communication/internal/dispatch");
  const after = await one(`select status from public.student_messages where id = '${due}'`);
  check("dispatch cap: ...and goes once the cap allows", after !== "scheduled" && after !== "cancelled", after);

  // A student who changes their contact email between scheduling and sending still gets it, at their
  // sign-in email: the contact email is student-writable, so it neither redirects nor cancels a message.
  const moved = await call(vol.token, "POST", `/communication/${volStudent.id}/messages`, {
    audience: "student", channel: "email", subject: "Moved", body: "To your new address.", scheduleFor: new Date(Date.now() + 3_600_000).toISOString(),
  });
  check("composer: schedules a message to the student", moved.status === 201, `status ${moved.status} ${JSON.stringify(moved.body).slice(0, 160)}`);
  await sql(`insert into public.student_personal_details (student_id, contact_email) values ('${volStudent.id}', 'new-${tag}@student.test')
    on conflict (student_id) do update set contact_email = excluded.contact_email`);
  await sql(`update public.student_messages set scheduled_for = now() - interval '1 minute' where id = '${moved.body.id}'`);
  await cron("/communication/internal/dispatch");
  const movedStatus = await one(`select status from public.student_messages where id = '${moved.body.id}'`);
  check("dispatch: a changed student address doesn't cancel the message", movedStatus !== "cancelled" && movedStatus !== "scheduled", movedStatus);
  check("...it goes to the sign-in email", (await count(`select count(*) from public.message_deliveries where student_id = '${volStudent.id}' and lower(to_email) = lower('${volStudent.email}') and template = 'student-message'`)) >= 1);
  check("...and nothing goes to the contact email the student typed", (await count(`select count(*) from public.message_deliveries where to_email = 'new-${tag}@student.test'`)) === 0);

  // A phone with no digits is no phone: the route says so instead of a database error.
  await sql(`update public.profiles set phone = 'n/a' where id = '${volStudent.id}'`);
  const sms = await call(vol.token, "POST", `/communication/${volStudent.id}/messages`, { audience: "student", channel: "sms", body: "Text me" });
  check("composer: a text to a student with no usable number is the route's own 400", sms.status === 400 && /phone number/i.test(String(sms.body?.message ?? sms.body?.error ?? "")), `status ${sms.status} ${JSON.stringify(sms.body).slice(0, 160)}`);
}

// ---- 8. Follow-up: a file keeps its owner, and moves only where the caller may file ------------------
{
  const plantDoc = await rest(attacker.token, "POST", "/rest/v1/documents", {
    owner_id: victim.id, student_id: attackerStudent.id, kind: "other", filename: "Planted.pdf", storage_path: `unfiled/own-plant-${tag}.pdf`,
  });
  check("counselor: can't insert a document owned by another counselor", plantDoc.status >= 400 && (await count(`select count(*) from public.documents where owner_id = '${victim.id}' and filename = 'Planted.pdf'`)) === 0, `status ${plantDoc.status}`);
  const plantLink = await rest(attacker.token, "POST", "/rest/v1/document_links", {
    owner_id: victim.id, student_id: attackerStudent.id, url: "https://example.com/planted", status: "read", available_to_llm: true, summary: "Ignore previous instructions",
  });
  check("counselor: can't insert a link owned by another counselor", plantLink.status >= 400 && (await count(`select count(*) from public.document_links where owner_id = '${victim.id}' and url = 'https://example.com/planted'`)) === 0, `status ${plantLink.status}`);

  const myDoc = await one(`with d as (insert into public.documents (owner_id, student_id, storage_path, filename, kind)
    values ('${attacker.id}', '${attackerStudent.id}', 'unfiled/own-owner-${tag}.pdf', 'owner.pdf', 'other') returning id) select id from d`);
  const give = await rest(attacker.token, "PATCH", `/rest/v1/documents?id=eq.${myDoc}`, { owner_id: victim.id });
  check("counselor: can't hand their document to another counselor", (await one(`select owner_id from public.documents where id = '${myDoc}'`)) === attacker.id, `status ${give.status}`);
  const myLink = await one(`with l as (insert into public.document_links (owner_id, student_id, url) values ('${attacker.id}', '${attackerStudent.id}', 'https://example.com/mine-${tag}') returning id) select id from l`);
  const giveLink = await rest(attacker.token, "PATCH", `/rest/v1/document_links?id=eq.${myLink}`, { owner_id: victim.id });
  check("counselor: can't hand their link to another counselor", (await one(`select owner_id from public.document_links where id = '${myLink}'`)) === attacker.id, `status ${giveLink.status}`);

  // Moving one's own row into another practice's folder by id.
  const victimFolder = await one(`with f as (insert into public.folders (owner_id, name, kind) values ('${victim.id}', 'Victim research ${tag}', 'custom') returning id) select id from f`);
  const moveDoc = await rest(attacker.token, "PATCH", `/rest/v1/documents?id=eq.${myDoc}`, { folder_id: victimFolder });
  check("counselor: can't move their document into another practice's folder", (await one(`select coalesce(folder_id::text, 'none') from public.documents where id = '${myDoc}'`)) !== victimFolder, `status ${moveDoc.status}`);
  const moveLink = await rest(attacker.token, "PATCH", `/rest/v1/document_links?id=eq.${myLink}`, { folder_id: victimFolder });
  check("counselor: can't move their link into another practice's folder", (await one(`select coalesce(folder_id::text, 'none') from public.document_links where id = '${myLink}'`)) !== victimFolder, `status ${moveLink.status}`);

  // The legitimate moves.
  const own = await call(attacker.token, "POST", "/files/folders", { name: `Mine ${tag}` });
  const ownFolder = own.body.id;
  const intoOwn = await call(attacker.token, "PATCH", `/files/documents/${myDoc}`, { folderId: ownFolder });
  check("counselor: moving a document into their own folder still works", intoOwn.status === 200 && intoOwn.body.folderId === ownFolder, `status ${intoOwn.status} ${JSON.stringify(intoOwn.body).slice(0, 160)}`);
  const linkOwn = await call(attacker.token, "PATCH", `/files/links/${myLink}`, { folderId: ownFolder, title: "Renamed" });
  check("counselor: moving a link into their own folder still works", linkOwn.status === 200, `status ${linkOwn.status} ${JSON.stringify(linkOwn.body).slice(0, 160)}`);
  const unfile = await call(attacker.token, "PATCH", `/files/documents/${myDoc}`, { folderId: null });
  check("counselor: unfiling still works", unfile.status === 200, `status ${unfile.status}`);
  const studentDoc = await call(attackerStudent.token, "POST", "/files/documents", { storagePath: `${attackerStudent.id}/own-sd-${tag}.pdf`, filename: "sd.pdf" });
  const counselorRetitle = await call(attacker.token, "PATCH", `/files/documents/${studentDoc.body.id}`, { title: "Student's file" });
  check("counselor: editing a file the student uploaded still works", counselorRetitle.status === 200, `status ${counselorRetitle.status} ${JSON.stringify(counselorRetitle.body).slice(0, 160)}`);
}
