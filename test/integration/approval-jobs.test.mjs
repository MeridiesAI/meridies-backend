// Counselor approval gate: work queued before a revoke does not run after it.
import { API, CRON_SECRET, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const cron = (path) => fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const noQuietHours = (c) => sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${c.id}', 'UTC', null, null)`);
const scheduled = (c, s) => sql(`with m as (insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status, scheduled_for)
  values ('${s.id}', '${c.id}', 'student', 'email', '[{"kind":"student","id":"${s.id}","name":"S","email":"${s.email}","phone":null}]'::jsonb,
          'Hello', 'Scheduled before the revoke', 'scheduled', now() - interval '1 minute') returning id) select id from m`);
const statusOf = (id) => sql(`select status from public.student_messages where id = '${id}'`);

// ---- Scheduled message --------------------------------------------------------------
const rev = await user("jobs-revoked");
const revStudent = await studentOf(rev, "jobs-revoked-student");
const ok = await user("jobs-approved");
const okStudent = await studentOf(ok, "jobs-approved-student");
await noQuietHours(rev);
await noQuietHours(ok);
const revMsg = await scheduled(rev, revStudent);
const okMsg = await scheduled(ok, okStudent);
await sql(`insert into public.red_flags (student_id, title, message, trigger, issued_by, issued_by_id, escalate_at)
  values ('${revStudent.id}', 'GATE-FLAG', 'm', 'manual', 'counselor', '${rev.id}', now() - interval '1 hour')`);
await sql(`select private.revoke_counselor_access('${rev.id}')`);

const disp = await cron("/communication/internal/dispatch");
check("the dispatch cron ran", disp.status === 200, `status ${disp.status}`);
check("a queued message from a revoked counselor doesn't send", (await statusOf(revMsg)) === "cancelled");
check("...and records why", /not approved/i.test(await sql(`select coalesce(hold_reason, '') from public.student_messages where id = '${revMsg}'`)));
check("nothing was delivered for it", Number(await sql(`select count(*) from public.message_deliveries where student_id = '${revStudent.id}'`)) === 0);
const okStatus = await statusOf(okMsg);
check("an approved counselor's message still leaves the queue", okStatus !== "cancelled" && okStatus !== "scheduled", okStatus);

// ---- Accountability sweep --------------------------------------------------------------
const sweep = await cron("/internal/accountability/sweep");
const sweepBody = await sweep.json().catch(() => ({}));
check("the scheduled sweep ran and skipped the revoked counselor", sweep.status === 200 && sweepBody.unapproved >= 1, JSON.stringify(sweepBody));
check("the revoked counselor's flag was not escalated", (await sql(`select status from public.red_flags where title = 'GATE-FLAG' and student_id = '${revStudent.id}'`)) === "open");
