// The Communication composer writes to the student's sign-in email, never to
// the contact email in student_personal_details, which the student can write
// through PostgREST (lib/studentMessages.ts loadStudentContact). A scheduled
// message whose frozen address isn't the sign-in email any more is cancelled
// at dispatch, not sent.
import { API, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const planted = `planted-${tag}@evil.test`;

const c = await user("compose-c");
const s = await studentOf(c, "compose-s");
await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${c.id}', 'UTC', null, null)`);

const plant = await rest(s.token, "POST", "/rest/v1/student_personal_details?on_conflict=student_id",
  { student_id: s.id, contact_email: planted }, { Prefer: "resolution=merge-duplicates,return=minimal" });
check("the student can write their own contact email (the precondition)", plant.status < 300, `status ${plant.status}`);

const composer = await call(c.token, "GET", `/communication/${s.id}/composer`);
check("the composer names the student's sign-in email", composer.status === 200 && composer.body?.student?.email === s.email, JSON.stringify(composer.body?.student));

const sent = await call(c.token, "POST", `/communication/${s.id}/messages`, { audience: "student", channel: "email", subject: "Hello", body: "Checking in." });
check("a message to the student is accepted", sent.status < 300, `status ${sent.status} ${JSON.stringify(sent.body)}`);
const frozen = await sql(`select recipients->0->>'email' from public.student_messages where student_id = '${s.id}' order by created_at desc limit 1`);
check("…its frozen recipient is the sign-in email", frozen.trim() === s.email, frozen);
await sleep(500);
check("…the delivery went to the sign-in email",
  Number(await sql(`select count(*) from public.message_deliveries where student_id = '${s.id}' and lower(to_email) = lower('${s.email}')`)) >= 1);
check("…and nothing went to the address the student typed",
  Number(await sql(`select count(*) from public.message_deliveries where lower(to_email) = lower('${planted}')`)) === 0);

// A message scheduled before this rule, frozen with the planted address.
const legacy = await sql(`with m as (insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status, scheduled_for)
  values ('${s.id}', '${c.id}', 'student', 'email', '[{"kind":"student","id":"${s.id}","name":"S","email":"${planted}","phone":null}]'::jsonb,
          'Hello', 'Scheduled with the old rule', 'scheduled', now() - interval '1 minute') returning id) select id from m`);
const disp = await fetch(`${API}/communication/internal/dispatch`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
check("the dispatch cron ran", disp.status === 200, `status ${disp.status}`);
check("a scheduled message frozen with another address is cancelled", (await sql(`select status from public.student_messages where id = '${legacy}'`)).trim() === "cancelled");
check("…with the reason", /address on file has changed/i.test(await sql(`select coalesce(hold_reason, '') from public.student_messages where id = '${legacy}'`)));
check("…and still nothing went to the planted address",
  Number(await sql(`select count(*) from public.message_deliveries where lower(to_email) = lower('${planted}')`)) === 0);
