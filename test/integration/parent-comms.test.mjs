// Parent communication from the student page (migrations 20261103000001-02):
// the email a parent gets is written for a parent, a parent can be texted from
// the Communication composer, a scheduled text is re-checked against the phone
// on file, and the family's replies are readable by the student's counselor only.
//
//   C   a counselor with student S and a guardian (email + phone)
//   X   a counselor elsewhere
//
// Texts are recorded `queued` when Twilio isn't configured (as in CI): this
// checks who is written to and how, not Twilio.
import { API, CLIENT, CRON_SECRET, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = Date.now();
const C = await user("pc-counselor");
const X = await user("pc-outsider");
const S = await studentOf(C, "pc-student");
const guardianId = await sql(
  `with g as (insert into public.guardians (student_id, full_name, email, phone) values ('${S.id}', 'Pat Parent', 'pat-${tag}@families.test', '(415) 555-0142') returning id) select id from g`
);
const noPhoneId = await sql(
  `with g as (insert into public.guardians (student_id, full_name, email) values ('${S.id}', 'Sam Parent', 'sam-${tag}@families.test') returning id) select id from g`
);
const send = (over) =>
  call(C.token, "POST", `/communication/${S.id}/messages`, { audience: "parent", channel: "email", subject: "Fall plan", body: "Maya finished her first draft.", overrideQuietHours: true, ...over });
const dispatch = async () => {
  const r = await fetch(`${API}/communication/internal/dispatch`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ---- the email a parent gets ----------------------------------------------------------------
const mail = await send({});
check("emailing the parents works", mail.status === 201 && mail.body.status === "sent", JSON.stringify(mail.body).slice(0, 200));
const delivered = await sql(
  `select body from public.message_deliveries where student_id = '${S.id}' and recipient_id = '${guardianId}' and template = 'student-message' and channel = 'email' order by created_at desc limit 1`
);
check("the parent is greeted by name", /Dear Pat,/.test(delivered), delivered.slice(0, 120));
check("the footer tells the parent a reply reaches the counselor", /Reply to this email and pc-counselor will receive it directly/.test(delivered), delivered.slice(-160));
check("it no longer says 'your counselor directly' to a parent", !/Reply to your counselor directly/.test(delivered));
const routes = await sql(`select count(*) from public.messaging_routes where student_id = '${S.id}' and guardian_id = '${guardianId}' and party = 'parent'`);
// Reply routing is on only when the API runs with REPLY_DOMAIN (the inbound suite does); off, Reply-To is the counselor's own address.
check("a reply address is minted for that guardian when routing is on", routes === (process.env.REPLY_DOMAIN ? "1" : "0"), `routes=${routes}`);

// ---- texting a parent ------------------------------------------------------------------------------
const text = await send({ channel: "sms", subject: undefined, body: "Quick update: Maya's draft is in." });
check("a parent can be texted from the composer", text.status === 201 && ["queued", "sent"].includes(text.body.status), JSON.stringify(text.body).slice(0, 240));
const row = JSON.parse(await sql(`select row_to_json(m) from public.student_messages m where student_id = '${S.id}' and channel = 'sms' and audience = 'parent'`));
check("it is stored as a text to a parent, to the guardian with a phone", row?.audience === "parent" && row?.channel === "sms" && row.recipients?.length === 1 && row.recipients[0].id === guardianId);
const sms = await sql(`select body from public.message_deliveries where student_id = '${S.id}' and channel = 'sms' and recipient_id = '${guardianId}'`);
check("the text says who it is from and which student it is about", /^Hi Pat, it's pc-counselor about pc-student: Quick update/.test(sms), sms.slice(0, 120));
check("a guardian with no phone is not texted", !(await sql(`select 1 from public.message_deliveries where recipient_id = '${noPhoneId}' and channel = 'sms'`)));

await sql(`update public.guardians set phone = null where id = '${guardianId}'`);
const none = await send({ channel: "sms", subject: undefined, body: "Hello" });
await sql(`update public.guardians set phone = '(415) 555-0142' where id = '${guardianId}'`);
const noPhone = await send({ channel: "sms", subject: undefined, body: "Hello" }); // restored: fine
check("with no parent phone on file the composer says so", none.status === 400 && /phone number/i.test(JSON.stringify(none.body)), JSON.stringify(none.body));
check("with a phone on file it works again", noPhone.status === 201);

// A forged row can't name a phone the guardian doesn't have (the client guard in the database).
const forged = await fetch(`${process.env.SUPABASE_URL}/rest/v1/student_messages`, {
  method: "POST",
  headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${C.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    student_id: S.id, counselor_id: C.id, audience: "parent", channel: "sms", kind: "message", status: "queued", body: "hi",
    recipients: [{ kind: "guardian", id: guardianId, name: "Pat Parent", email: null, phone: "(999) 000-0000" }],
  }),
});
check("a client can't aim a text at a phone the guardian doesn't have", forged.status >= 400, String(forged.status));

// ---- a scheduled text is re-checked when it goes ---------------------------------------------------------------
const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
const sched = await send({ channel: "sms", subject: undefined, body: "Reminder for Friday.", scheduleFor: later });
check("a text can be scheduled", sched.status === 201 && sched.body.status === "scheduled", JSON.stringify(sched.body).slice(0, 160));
await sql(`update public.guardians set phone = '(415) 555-0199' where id = '${guardianId}'`);
await sql(`update public.student_messages set scheduled_for = now() - interval '1 minute' where id = '${sched.body.id}'`);
await dispatch();
const after = await sql(`select status from public.student_messages where id = '${sched.body.id}'`);
check("a phone that changed since scheduling is not texted at the new one", after === "cancelled", after);

// ---- what the family answered -----------------------------------------------------------------------------------------
await sql(`insert into public.inbound_messages (channel, counselor_id, student_id, guardian_id, party, from_addr, subject, body, provider_message_id, sender_known, authenticated)
  values ('email', '${C.id}', '${S.id}', '${guardianId}', 'parent', 'pat-${tag}@families.test', 'Re: Fall plan', 'Thanks, that helps.', 'test:${tag}', true, true)`);
const replies = await call(C.token, "GET", `/communication/${S.id}/replies`);
check("the counselor reads the family's replies", replies.status === 200 && replies.body.replies?.length === 1 && replies.body.unread === 1, JSON.stringify(replies.body).slice(0, 240));
check("a reply is named by the guardian on file", replies.body.replies?.[0]?.fromName === "Pat Parent" && replies.body.replies[0].body === "Thanks, that helps.");
await call(C.token, "POST", `/communication/${S.id}/replies/read`, {});
check("marking them read clears the count", (await call(C.token, "GET", `/communication/${S.id}/replies`)).body.unread === 0);
const out = await call(X.token, "GET", `/communication/${S.id}/replies`);
check("another counselor can't read this student's replies", out.status === 403 || out.status === 404, String(out.status));
const asStudent = await call(S.token, "GET", `/communication/${S.id}/replies`);
check("the student can't read their family's replies", asStudent.status === 403, String(asStudent.status));
