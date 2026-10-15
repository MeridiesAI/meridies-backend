// A student's due-tomorrow reminders reach the student and nobody else: email
// only at their sign-in address, a text only at the number their counselor
// recorded (and the student chose), a few a day at most, and never a title
// the student wrote inside a text. Before, a student could aim Meridies'
// email and Twilio at any address or number with text of their choosing.
import { API, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const dispatch = () => fetch(`${API}/communication/internal/dispatch`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const stranger = `stranger-${Date.now()}@victim.test`;
const strangerPhone = "+15550009999";
const studentPhone = "+15550001111";

const c = await user("remind-counselor");
const s = await studentOf(c, "remind-student");
await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${c.id}', 'UTC', null, null)`);
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(Date.now() + 86_400_000));
const template = `task-due-reminder:${tomorrow}`;

const prefs = await call(s.token, "PATCH", "/me/preferences", { emailEnabled: true, emailAddress: stranger, smsEnabled: true, smsPhone: strangerPhone });
check("the student turns both channels on, naming someone else", prefs.status === 200, `status ${prefs.status} ${JSON.stringify(prefs.body).slice(0, 200)}`);

for (let i = 0; i < 7; i++) {
  const t = await call(s.token, "POST", "/tasks", { title: `Verify your account at https://evil.example/login ${i}`, dueDate: tomorrow });
  if (t.status !== 201) throw new Error(`task ${t.status} ${JSON.stringify(t.body)}`);
}

let d = await dispatch();
check("the dispatch cron runs the reminders", d.status === 200, `status ${d.status}`);
const rows = async (where) => Number(await sql(`select count(*) from public.message_deliveries where student_id = '${s.id}' and template = '${template}' and ${where}`));
check("nothing is emailed to the address typed in Settings", (await rows(`to_email = '${stranger}'`)) === 0, String(await rows(`to_email = '${stranger}'`)));
check("nothing is texted to the number typed in Settings", (await rows(`channel = 'sms'`)) === 0, String(await rows(`channel = 'sms'`)));
const emailed = await rows(`channel = 'email'`);
check("email reminders go to the student's sign-in address", emailed > 0 && (await rows(`channel = 'email' and to_email = '${s.email}'`)) === emailed, String(emailed));
check("…at most five a day", emailed <= 5, String(emailed));

const hasColumn = (await sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone_recorded_by_counselor'`)) === "1";
if (!hasColumn) {
  console.log("SKIP  counselor-recorded phone checks: 20261024000042 is not applied (no texts are sent at all)");
} else {
  const self = await rest(s.token, "PATCH", `/rest/v1/profiles?id=eq.${s.id}`, { phone_recorded_by_counselor: strangerPhone }, { Prefer: "return=representation" });
  check("a student can't write the recorded number", self.status >= 400, `status ${self.status}`);
  const counselorSaves = await call(c.token, "PATCH", `/student-page/${s.id}/info`, { phone: "(555) 000-1111" });
  check("the counselor saves the student's phone", counselorSaves.status === 200, `status ${counselorSaves.status} ${JSON.stringify(counselorSaves.body).slice(0, 160)}`);
  check("…which records it", (await sql(`select coalesce(phone_recorded_by_counselor, '') from public.profiles where id = '${s.id}'`)) === "(555) 000-1111");
  const studentSaves = await call(s.token, "PATCH", `/student-page/${s.id}/info`, { phone: strangerPhone });
  check("the student may change their own phone", studentSaves.status === 200, `status ${studentSaves.status}`);
  check("…but not the recorded one", (await sql(`select coalesce(phone_recorded_by_counselor, '') from public.profiles where id = '${s.id}'`)) === "(555) 000-1111");

  // Still the stranger's number in Settings: no text.
  await dispatch();
  check("a number the counselor didn't record gets no text", (await rows(`channel = 'sms'`)) === 0, String(await rows(`channel = 'sms'`)));

  await call(s.token, "PATCH", "/me/preferences", { smsPhone: studentPhone });
  const counselorTask = await call(c.token, "POST", "/tasks", { studentId: s.id, kind: "custom", title: "Common App essay draft", dueDate: tomorrow });
  check("the counselor sets a task due tomorrow", counselorTask.status === 201, `status ${counselorTask.status}`);
  await dispatch();
  const texts = await rows(`channel = 'sms'`);
  check("with the recorded number chosen, texts go to it", texts > 0 && (await rows(`channel = 'sms' and to_phone = '${studentPhone}'`)) === texts, String(texts));
  check("…at most five a day", texts <= 5, String(texts));
  check("…a text never carries the student's own title", (await rows(`channel = 'sms' and body like '%evil%'`)) === 0);
  check("…a counselor's title still shows", (await rows(`channel = 'sms' and body like '%Common App essay draft%'`)) === 1);
  check("email stays capped at five", (await rows(`channel = 'email'`)) <= 5, String(await rows(`channel = 'email'`)));
}
