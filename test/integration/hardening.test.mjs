import { createHmac, createHash } from "node:crypto";
import { user, call, check, sql, API, CRON_SECRET } from "./harness.mjs";
const c = await user("counselor-h");
const s = await user("student-h", "student");
await sql(`update profiles set counselor_id='${c.id}' where id='${s.id}'`);

// Guardians
const g1 = await call(s.token, "POST", "/accountability/guardians", { full_name: "Pat Parent", email: "pat@example.com" });
const gStatus = g1.status; const gid = g1.body?.id;
check("student can add a guardian", gStatus === 201 || gStatus === 200, `status ${gStatus} ${JSON.stringify(g1.body).slice(0,120)}`);
check("…but it starts with alerts off", (await sql(`select alerts_enabled from guardians where id='${gid}'`)) === "f");
const sEdit = await call(s.token, "PATCH", `/accountability/guardians/${gid}`, { email: "me@student.com" });
check("student can't change a guardian", sEdit.status === 404 || sEdit.status === 403, `status ${sEdit.status}`);
check("…and the email is unchanged", (await sql(`select email from guardians where id='${gid}'`)) === "pat@example.com");
const sDel = await call(s.token, "DELETE", `/accountability/guardians/${gid}`);
check("student can't delete a guardian", (await sql(`select count(*) from guardians where id='${gid}'`)) === "1", `status ${sDel.status}`);
const cEdit = await call(c.token, "PATCH", `/accountability/guardians/${gid}`, { alerts_enabled: true });
check("counselor turns alerts on", cEdit.status === 200 && (await sql(`select alerts_enabled from guardians where id='${gid}'`)) === "t", `status ${cEdit.status}`);

// Firm teams
const f = await call(c.token, "POST", "/firms", { name: "Rivera College Advising" });
check("start a firm", f.status === 201, JSON.stringify(f.body));
await sql(`update firms set seats = 2 where id='${f.body.firmId}'`);
const again = await call(c.token, "POST", "/firms", { name: "Second" });
check("can't start a second", again.status === 409 || again.status === 400, `status ${again.status}`);
const colleague = await user("colleague-h");
const inv = await call(c.token, "POST", "/firms/mine/invites", { email: colleague.email, seatRole: "counselor" });
check("invite a colleague", inv.status === 201 && inv.body.status === "pending", JSON.stringify(inv.body));
// The token is only in the email; mint a known one for the test.
const token = "test-token-0123456789-" + Date.now();
await sql(`update firm_invitations set token_hash='${createHash("sha256").update(token).digest("hex")}' where id='${inv.body.id}'`);
const stranger = await user("stranger-h");
const wrong = await call(stranger.token, "POST", "/firms/join", { token });
check("someone else can't use it", wrong.status === 403, `status ${wrong.status} ${JSON.stringify(wrong.body)}`);
const join = await call(colleague.token, "POST", "/firms/join", { token });
check("the invitee joins", join.status === 200 && join.body.firmId === f.body.firmId, `status ${join.status} ${JSON.stringify(join.body)}`);
const reuse = await call(colleague.token, "POST", "/firms/join", { token });
check("a used invitation can't be reused", reuse.status >= 400);
const members = await call(c.token, "GET", "/firms/mine/members");
check("members list", members.body.length === 2, JSON.stringify(members.body.map((m) => m.seatRole)));
const promote = await call(colleague.token, "PATCH", `/firms/mine/members/${c.id}`, { seatRole: "assistant" });
check("a counselor seat can't change seats", promote.status === 403, `status ${promote.status}`);
const toAdmin = await call(c.token, "PATCH", `/firms/mine/members/${colleague.id}`, { seatRole: "admin" });
check("owner makes them admin", toAdmin.status === 200);
const demoteOwner = await call(colleague.token, "PATCH", `/firms/mine/members/${c.id}`, { seatRole: "counselor" });
check("the owner's seat can't change", demoteOwner.status === 409 || demoteOwner.status === 400, `status ${demoteOwner.status}`);
const third = await user("third-h");
const inv3 = await call(c.token, "POST", "/firms/mine/invites", { email: third.email });
const t3 = "test-token-third-01234-" + Date.now();
await sql(`update firm_invitations set token_hash='${createHash("sha256").update(t3).digest("hex")}' where id='${inv3.body.id}'`);
const full = await call(third.token, "POST", "/firms/join", { token: t3 });
check("seat limit holds", full.status === 409, `status ${full.status} ${JSON.stringify(full.body)}`);
const leave = await call(colleague.token, "DELETE", `/firms/mine/members/${colleague.id}`);
check("a member can leave", leave.status === 204 && (await sql(`select coalesce(firm_id::text,'none') from profiles where id='${colleague.id}'`)) === "none");
const ownerLeave = await call(c.token, "DELETE", `/firms/mine/members/${c.id}`);
check("the owner can't leave", ownerLeave.status === 409 || ownerLeave.status === 400);

// Webhooks
const RID = 're_' + Date.now(); const SID = 'SM' + Date.now();
await sql(`insert into message_deliveries (student_id, recipient_kind, channel, provider, provider_message_id, status, to_email) values ('${s.id}', 'student', 'email', 'resend', '${RID}', 'sent', 'x@example.com'), ('${s.id}', 'student', 'sms', 'twilio', '${SID}', 'sent', null)`);
const secret = Buffer.from("test-resend-secret-for-local-tests");
const body = JSON.stringify({ type: "email.delivered", data: { email_id: RID } });
const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", secret).update(`msg_1.${ts}.${body}`).digest("base64");
const ok = await fetch(API + "/webhooks/resend", { method: "POST", headers: { "Content-Type": "application/json", "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body });
check("signed Resend event applies", ok.status === 200 && (await sql(`select status from message_deliveries where provider_message_id='${RID}'`)) === "delivered", `status ${ok.status} ${await ok.text()}`);
const forged = await fetch(API + "/webhooks/resend", { method: "POST", headers: { "Content-Type": "application/json", "svix-id": "msg_2", "svix-timestamp": ts, "svix-signature": "v1,AAAA" }, body: JSON.stringify({ type: "email.bounced", data: { email_id: RID } }) });
check("forged Resend event refused", forged.status === 401);
const late = JSON.stringify({ type: "email.sent", data: { email_id: RID } });
const sig2 = createHmac("sha256", secret).update(`msg_3.${ts}.${late}`).digest("base64");
await fetch(API + "/webhooks/resend", { method: "POST", headers: { "Content-Type": "application/json", "svix-id": "msg_3", "svix-timestamp": ts, "svix-signature": `v1,${sig2}` }, body: late });
check("a late 'sent' doesn't undo 'delivered'", (await sql(`select status from message_deliveries where provider_message_id='${RID}'`)) === "delivered");
const params = { MessageSid: SID, MessageStatus: "undelivered", ErrorCode: "30005" };
const url = `${process.env.PUBLIC_API_URL ?? "http://127.0.0.1:4100"}/webhooks/twilio/status`;
const tsig = createHmac("sha1", "local-twilio-test-token-123").update(Object.keys(params).sort().reduce((a, k) => a + k + params[k], url)).digest("base64");
const tw = await fetch(API + "/webhooks/twilio/status", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": tsig }, body: new URLSearchParams(params).toString() });
check("signed Twilio callback applies", tw.status === 204 && (await sql(`select status||' '||error from message_deliveries where provider_message_id='${SID}'`)) === "failed Twilio: 30005");
const twBad = await fetch(API + "/webhooks/twilio/status", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "nope" }, body: new URLSearchParams(params).toString() });
check("forged Twilio callback refused", twBad.status === 401);

// Export
const ex = await call(s.token, "GET", "/account/export");
check("student export has their record", ex.status === 200 && ex.body.kind === "student" && ex.body.records.guardians?.length === 1, Object.keys(ex.body.records ?? {}).join(","));
await sql(`insert into student_private_notes (student_id, body, updated_by) values ('${s.id}', 'counselor-only note', '${c.id}') on conflict do nothing`);
const ex2 = await call(s.token, "GET", "/account/export");
check("a student's export leaves out the counselor's private note", !ex2.body.records.student_private_notes);
const cex = await call(c.token, "GET", `/account/students/${s.id}/export`);
check("the counselor's export of the student includes it", cex.status === 200 && cex.body.records.student_private_notes?.length === 1, `status ${cex.status} ${Object.keys(cex.body.records ?? {}).join(",")}`);
const oex = await call(stranger.token, "GET", `/account/students/${s.id}/export`);
check("another counselor can't export them", oex.status === 404 || oex.status === 403, `status ${oex.status}`);

// Delete
const cdel = await call(c.token, "DELETE", "/account", { confirm: "delete my account" });
check("counselor with a roster can't delete", cdel.status === 409, JSON.stringify(cdel.body));
const nope = await call(s.token, "DELETE", "/account", { confirm: "yes" });
check("needs the confirmation phrase", nope.status === 400);
const sdel = await call(s.token, "DELETE", "/account", { confirm: "delete my account" });
check("student deletes their account", sdel.status === 204 && (await sql(`select count(*) from profiles where id='${s.id}'`)) === "0" && (await sql(`select count(*) from guardians where student_id='${s.id}'`)) === "0");

// Status
const st = await fetch(API + "/internal/status", { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const sj = await st.json();
check("status lists every job", sj.jobs?.length === 4, JSON.stringify(sj));
const noauth = await fetch(API + "/internal/status");
check("status needs the cron secret", noauth.status === 401);
