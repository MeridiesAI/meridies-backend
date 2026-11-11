// What a student's parents receive (lib/familyVisibility.ts), against the running API and database.
// Runs in either state:
//  - before the migration that adds student_alert_prefs.parents_get_* : the GET answers available: false with
//    everything on, a save answers 503 family_visibility_unavailable, and the weekly report goes out exactly as
//    before;
//  - after it: a switch saved here is what the weekly report preview, approve-send, the dispatch re-check and the
//    escalation sweep follow.
// Needs an API with the service role key and CRON_SECRET; no email/SMS provider. Fixtures are namespaced `famvis-`.
import { API, CRON_SECRET, call, check, sql } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";
import { user as baseUser } from "./harness.mjs";

const TAG = "famvis";
const user = (tag, role, opts) => baseUser(`${TAG}-${tag}`, role, opts);
const count = async (q) => Number(await sql(q));
const q = (s) => s.replace(/'/g, "''");

async function dispatch() {
  for (let i = 0; ; i++) {
    const r = await fetch(`${API}/communication/internal/dispatch`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    if (r.status !== 429 || i >= 15) return { status: r.status, body: await r.json().catch(() => ({})) };
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// A weekly report shaped exactly as lib/weeklyDigestContent.ts writes one.
const BODY = [
  "Here is Maya's week, Monday Nov 2 to Sunday Nov 8.",
  "Finished this week (1):\n- Upload transcript",
  "Coming up or overdue:\n- Due Nov 12: Ask for a recommendation",
  "College deadlines in the next two weeks:\n- Boston University: Nov 15",
  "Essays (word counts only):\n- Personal statement: 412 words, +85 this week",
].join("\n\n");
const SUMMARY = "Maya's week (Nov 2 to Nov 8): 1 task finished, 1 due in the next two weeks, 1 college deadline coming up, essays +85 words.";
let week = 0;
async function weeklyReport(s, c) {
  // A distinct period per report: one weekly report per student per week.
  week += 1;
  return sql(`with r as (insert into public.family_reports (student_id, counselor_id, title, kind, period_start, period_end, summary, highlights, body, status)
    values ('${s.id}', '${c.id}', 'Maya''s week: Nov 2 to Nov 8', 'weekly', '2020-01-06'::date + ${7 * week}, '2020-01-12'::date + ${7 * week}, '${q(SUMMARY)}',
            array['1 task finished', 'Personal statement: 412 words, +85 this week'], '${q(BODY)}', 'draft') returning id) select id from r`);
}

const A = await user("a", "counselor");
await sql(`update public.profiles set full_name = 'Dana Famvis', timezone = 'UTC' where id = '${A.id}'`);
await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${A.id}', 'UTC', null, null)`);
const maya = await studentOf(A, `${TAG}-maya`);
await sql(`update public.profiles set full_name = 'Maya Chen' where id = '${maya.id}'`);
await sql(`insert into public.guardians (student_id, full_name, email, phone, preferred_channel, alerts_enabled, receives_reports)
           values ('${maya.id}', 'Rosa Chen', '${TAG}-rosa@test.local', '+15555550199', 'both', true, true)`);
const O = await user("other", "counselor");

// ---- Reading and saving the switches --------------------------------------------------------------------------------
const first = await call(A.token, "GET", `/accountability/family-visibility?studentId=${maya.id}`);
check("GET answers the student's switches", first.status === 200 && first.body.studentId === maya.id, JSON.stringify(first.body));
check("...all on by default (what is sent today)", JSON.stringify(first.body.categories) === JSON.stringify({ tasks: true, colleges: true, essays: true }), JSON.stringify(first.body));
check("...and reading writes no row", (await count(`select count(*) from public.student_alert_prefs where student_id = '${maya.id}'`)) === 0);
const available = first.body.available === true;
console.log(`# the migration is ${available ? "applied: testing the switches" : "not applied: testing the not-switched-on state"}`);

const asStudent = await call(maya.token, "GET", `/accountability/family-visibility?studentId=${maya.id}`);
check("the student can read what their parents receive (it isn't a secret)", asStudent.status === 200, `status ${asStudent.status}`);
const studentPut = await call(maya.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { essays: false } });
check("...but can't change it", studentPut.status === 403, `status ${studentPut.status}`);
const foreignPut = await call(O.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { essays: false } });
check("another practice's counselor can't change it", foreignPut.status === 403 || foreignPut.status === 404, `status ${foreignPut.status}`);
const foreignGet = await call(O.token, "GET", `/accountability/family-visibility?studentId=${maya.id}`);
check("...or read it", foreignGet.status === 403 || foreignGet.status === 404, `status ${foreignGet.status}`);
for (const [label, body] of [
  ["an unknown kind", { studentId: maya.id, categories: { grades: false } }],
  ["no kind at all", { studentId: maya.id, categories: {} }],
  ["a non-boolean", { studentId: maya.id, categories: { essays: "no" } }],
]) {
  const r = await call(A.token, "PUT", "/accountability/family-visibility", body);
  check(`a save with ${label} is refused`, r.status === 400, `status ${r.status}`);
}

const save = await call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { essays: false } });
if (!available) {
  check("before the migration a save answers 503 family_visibility_unavailable", save.status === 503 && save.body.code === "family_visibility_unavailable", JSON.stringify(save.body));
  const rep = await weeklyReport(maya, A);
  const r = await call(A.token, "GET", `/reports/family/${rep}/recipients`);
  const email = r.body.messages?.find((m) => m.channel === "email");
  check("...and the weekly report preview is exactly as before", r.status === 200 && email?.text.includes("Personal statement: 412 words") && r.body.familyVisibility?.available === false && r.body.familyVisibility.leftOut.length === 0, JSON.stringify(r.body.familyVisibility));
  const ok = await call(A.token, "POST", `/reports/family/${rep}/approve-send`, { confirm: true });
  const body = await sql(`select body from public.student_messages where family_report_id = '${rep}' and channel = 'email'`);
  check("...approve-send writes the stored text, untouched", ok.status === 200 && body === BODY, `status ${ok.status}`);
} else {
  check("the counselor switches essays off", save.status === 200 && save.body.categories.essays === false && save.body.categories.tasks === true, JSON.stringify(save.body));
  const again = await call(A.token, "GET", `/accountability/family-visibility?studentId=${maya.id}`);
  check("...and it is still off when read again", again.body.categories?.essays === false && again.body.available === true, JSON.stringify(again.body));
  check("...one column per kind: copy_parents is untouched", (await sql(`select copy_parents::text from public.student_alert_prefs where student_id = '${maya.id}'`)) === "true");
  const [x, y] = await Promise.all([
    call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { colleges: false } }),
    call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { tasks: false } }),
  ]);
  const both = await call(A.token, "GET", `/accountability/family-visibility?studentId=${maya.id}`);
  check("two switches saved at once both hold", x.status === 200 && y.status === 200 && both.body.categories.colleges === false && both.body.categories.tasks === false, JSON.stringify(both.body));
  await call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { colleges: true, tasks: true } });

  const composer = await call(A.token, "GET", `/communication/${maya.id}/composer`);
  check("the composer carries the switches as a reminder", composer.status === 200 && composer.body.familyVisibility?.categories?.essays === false, JSON.stringify(composer.body.familyVisibility));

  // ---- The weekly report, decided at send time ----------------------------------------------------------------------
  const rep = await weeklyReport(maya, A);
  const r = await call(A.token, "GET", `/reports/family/${rep}/recipients`);
  const email = r.body.messages?.find((m) => m.channel === "email");
  const text = r.body.messages?.find((m) => m.channel === "sms");
  check("the preview leaves the essays out of the email", r.status === 200 && email && !/Essays|412 words/.test(email.text) && email.text.includes("Upload transcript") && email.text.includes("Boston University"), email?.text);
  check("...and out of the text", text && !/essays/i.test(text.text) && text.text.includes("1 task finished"), text?.text);
  check("...and says what was left out", JSON.stringify(r.body.familyVisibility?.leftOut) === JSON.stringify([{ category: "essays", label: "Essay progress" }]), JSON.stringify(r.body.familyVisibility));
  check("...the recipients are unchanged", r.body.recipients?.length === 1 && r.body.canSend === true);
  check("...and the stored draft keeps its text (the switches decide at send time)", (await sql(`select body from public.family_reports where id = '${rep}'`)) === BODY);

  const ok = await call(A.token, "POST", `/reports/family/${rep}/approve-send`, { confirm: true });
  const rows = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('channel', channel, 'body', body)), '[]') from public.student_messages where family_report_id = '${rep}'`));
  check("approve-send writes the filtered text on both rows", ok.status === 200 && rows.length === 2 && rows.every((m) => !/essays|412 words/i.test(m.body)), JSON.stringify(rows));
  await dispatch();
  const sent = JSON.parse(await sql(`select coalesce(json_agg(status), '[]') from public.student_messages where family_report_id = '${rep}'`));
  check("...and the dispatcher sends them (nothing hidden is left in them)", sent.every((s) => s !== "scheduled" && s !== "cancelled"), JSON.stringify(sent));

  // A switch turned off after approval holds the message.
  await call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { essays: true } });
  const rep2 = await weeklyReport(maya, A);
  const ok2 = await call(A.token, "POST", `/reports/family/${rep2}/approve-send`, { confirm: true });
  check("(approved with every switch on)", ok2.status === 200 && (await sql(`select body from public.student_messages where family_report_id = '${rep2}' and channel = 'email'`)) === BODY);
  await call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { colleges: false } });
  const deliveriesBefore = await count(`select count(*) from public.message_deliveries where student_id = '${maya.id}'`);
  await dispatch();
  const held = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('status', status, 'reason', hold_reason)), '[]') from public.student_messages where family_report_id = '${rep2}'`));
  check("college deadlines switched off before dispatch: both messages are cancelled with the reason", held.length === 2 && held.every((m) => m.status === "cancelled" && /College deadlines switched off/.test(m.reason ?? "")), JSON.stringify(held));
  check("...and nothing was delivered for it", (await count(`select count(*) from public.message_deliveries where student_id = '${maya.id}'`)) === deliveriesBefore);

  // Everything off: nothing to send.
  await call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { tasks: false, colleges: false, essays: false } });
  const rep3 = await weeklyReport(maya, A);
  const r3 = await call(A.token, "GET", `/reports/family/${rep3}/recipients`);
  check("every kind off: the preview says nothing is left and can't send", r3.body.familyVisibility?.nothingLeft === true && r3.body.canSend === false && r3.body.messages.length === 0, JSON.stringify(r3.body.familyVisibility));
  const s3 = await call(A.token, "POST", `/reports/family/${rep3}/approve-send`, { confirm: true });
  check("...and approve-send refuses with 409, leaving the draft a draft", s3.status === 409 && s3.body.code === "report_nothing_to_send" && (await sql(`select status from public.family_reports where id = '${rep3}'`)) === "draft", JSON.stringify(s3.body));

  // ---- The escalation sweep ------------------------------------------------------------------------------------------
  await sql(`update public.profiles set full_name = 'Maya Chen' where id = '${maya.id}'`);
  const flag = await sql(`with f as (insert into public.red_flags (student_id, title, message, severity, status, escalate_at)
    values ('${maya.id}', 'Personal statement stalled', 'No progress in 9 days', 'high', 'open', now() - interval '1 hour') returning id) select id from f`).catch((e) => {
    console.log(`# red flag fixture not written (${String(e.message).split("\n")[0]}): sweep check skipped`);
    return null;
  });
  if (flag) {
    const sw = await call(A.token, "POST", "/accountability/sweep");
    const mine = (sw.body.skipped ?? []).find((s) => s.id === flag);
    check("the sweep sends no alert to the parents with tasks off, and says why", sw.status === 200 && mine && /switched off for the parents/.test(mine.reason), JSON.stringify(sw.body));
    check("...no parent alert row, and the flag stays open", (await count(`select count(*) from public.parent_alerts where red_flag_id = '${flag}'`)) === 0 && (await sql(`select status from public.red_flags where id = '${flag}'`)) === "open");
    await call(A.token, "PUT", "/accountability/family-visibility", { studentId: maya.id, categories: { tasks: true } });
    const sw2 = await call(A.token, "POST", "/accountability/sweep");
    check("tasks back on: the next sweep alerts the parents", sw2.status === 200 && (await count(`select count(*) from public.parent_alerts where red_flag_id = '${flag}' and guardian_id is not null`)) === 1, JSON.stringify(sw2.body));
  }
}
