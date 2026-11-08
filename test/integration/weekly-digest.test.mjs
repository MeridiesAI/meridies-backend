// The weekly family digest (Task 8b): the draft job on the dispatch cron, the review queue, and approve-and-send.
// Needs 20261111000003 applied and an API with the service role key and CRON_SECRET; no email/SMS provider
// (deliveries record without sending). Fixtures are namespaced `digest8b-` and removed at the end.
import { API, CRON_SECRET, call, check, sql } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";
import { user as baseUser } from "./harness.mjs";

const TAG = "digest8b";
const user = (tag, role, opts) => baseUser(`${TAG}-${tag}`, role, opts);
const SENTINEL = `SENTINEL-ESSAY-${Math.random().toString(36).slice(2)}`;
const count = async (q) => Number(await sql(q));
const q = (s) => s.replace(/'/g, "''");

/** The dispatch cron, with the digest's hourly lease cleared first so every call runs the job. */
async function dispatch({ clearLease = true } = {}) {
  if (clearLease) await sql(`delete from private.job_leases where name = 'weekly-digest'`);
  // The route allows 10 calls a minute; other suites call it too, so wait out a 429.
  for (let i = 0; ; i++) {
    const r = await fetch(`${API}/communication/internal/dispatch`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    if (r.status !== 429 || i >= 15) return { status: r.status, body: await r.json().catch(() => ({})) };
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// The last completed Monday-Sunday week in UTC (every counselor here is on UTC).
const W0 = await sql(`select (date_trunc('week', now() at time zone 'UTC')::date - 7)::text`);
const NM = await sql(`select date_trunc('week', now() at time zone 'UTC')::date::text`);
const inWeek = `'${W0}'::date + interval '2 days 12 hours'`;
const beforeWeek = `'${W0}'::date - interval '5 days'`;

async function counselor(tag, digest, opts) {
  const c = await user(tag, "counselor", opts);
  await sql(`update public.profiles set timezone = 'UTC', full_name = 'Dana ${q(tag)}' where id = '${c.id}'`);
  if (digest) {
    await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end, weekly_digest)
               values ('${c.id}', 'UTC', null, null, '${digest}')`);
  }
  return c;
}
async function student(c, tag, fullName) {
  const s = await studentOf(c, `${TAG}-${tag}`);
  await sql(`update public.profiles set full_name = '${q(fullName)}' where id = '${s.id}'`);
  return s;
}
const task = (s, title, { status = "not-started", due = null, visible = true, updatedAt = null } = {}) =>
  sql(`insert into public.deliverables (student_id, kind, title, status, due_date, visible_to_student, source${updatedAt ? ", updated_at" : ""})
       values ('${s.id}', 'custom', '${q(title)}', '${status}', ${due ? `'${due}'::date` : "null"}, ${visible}, 'counselor'${updatedAt ? `, ${updatedAt}` : ""})`);
const doneInWeek = (s, title, visible = true) => task(s, title, { status: "complete", visible, updatedAt: inWeek });
const reports = (s) => count(`select count(*) from public.family_reports where student_id = '${s.id}' and kind = 'weekly' and period_start = '${W0}'`);
const reportOf = async (s) => JSON.parse((await sql(`select row_to_json(r) from public.family_reports r where student_id = '${s.id}' and kind = 'weekly' and period_start = '${W0}'`)) || "null");
const messages = (s) => count(`select count(*) from public.student_messages where student_id = '${s.id}'`);

// ---- Fixtures -------------------------------------------------------------------------------------------------
const A = await counselor("a", "draft");
const ana = await student(A, "ana", "Ana María Lopez");
await doneInWeek(ana, "Upload transcript");
await doneInWeek(ana, "HIDDEN-COUNSELOR-ONLY", false);
await task(ana, "Ask for a recommendation", { due: `${NM}`, updatedAt: beforeWeek });
await task(ana, "Brag sheet", { due: W0, updatedAt: beforeWeek });
await sql(`insert into public.student_colleges (student_id, name, status, deadline) values ('${ana.id}', 'Boston University', 'not-started', '${NM}'::date + 5)`);
await sql(`insert into public.student_colleges (student_id, name, status, deadline) values ('${ana.id}', 'Submitted College', 'submitted', '${NM}'::date + 5)`);
const essayId = await sql(`with e as (insert into public.essays (student_id, title, prompt, body, essay_kind, created_at)
  values ('${ana.id}', '${SENTINEL} title', '${SENTINEL} prompt', '${SENTINEL} body text', 'personal-statement', ${beforeWeek}) returning id) select id from e`);
await sql(`insert into public.progress_events (student_id, entity_type, entity_id, event, word_count, actor_id, created_at, metadata) values
  ('${ana.id}', 'essay', '${essayId}', 'word-count-changed', 327, '${ana.id}', ${beforeWeek}, '{}'),
  ('${ana.id}', 'essay', '${essayId}', 'word-count-changed', 412, '${ana.id}', ${inWeek}, '{"note":"${SENTINEL}"}')`);
for (const [name, email, phone, channel, alerts, reportsOn] of [
  ["Rosa Lopez", `${TAG}-rosa@test.local`, null, "email", true, true],
  ["Luis Lopez", null, "+15555550142", "sms", true, true],
  ["Opted Reports", `${TAG}-noreports@test.local`, null, "email", true, false],
  ["Opted Alerts", `${TAG}-noalerts@test.local`, null, "email", false, true],
  ["No Phone", `${TAG}-nophone@test.local`, null, "sms", true, true],
]) {
  await sql(`insert into public.guardians (student_id, full_name, email, phone, preferred_channel, alerts_enabled, receives_reports)
             values ('${ana.id}', '${name}', ${email ? `'${email}'` : "null"}, ${phone ? `'${phone}'` : "null"}, '${channel}', ${alerts}, ${reportsOn})`);
}

const quiet = await student(A, "quiet", "Quinn Quiet");
await task(quiet, "Far away", { due: `${NM}`, updatedAt: beforeWeek });
await sql(`update public.deliverables set due_date = '${NM}'::date + 30 where student_id = '${quiet.id}'`);
const archived = await student(A, "archived", "Archie Archived");
await doneInWeek(archived, "Done but archived");
await sql(`update public.profiles set archived_at = now() where id = '${archived.id}'`);
const optedOut = await student(A, "override-off", "Olive Override");
await doneInWeek(optedOut, "Done, digest off for me");
await sql(`insert into public.accountability_settings (counselor_id, student_id, timezone, weekly_digest) values ('${A.id}', '${optedOut.id}', 'UTC', 'off')`);
const parentsOff = await student(A, "parents-off", "Pat Parentsoff");
await doneInWeek(parentsOff, "Done, parents switched off");
await sql(`insert into public.guardians (student_id, full_name, email, preferred_channel) values ('${parentsOff.id}', 'Parent Off', '${TAG}-poff@test.local', 'email')`);
await sql(`insert into public.student_alert_prefs (student_id, copy_parents) values ('${parentsOff.id}', false)`);
const dismissMe = await student(A, "dismiss", "Dee Dismiss");
await doneInWeek(dismissMe, "Done, to be dismissed");

const B = await counselor("b", "off");
const bea = await student(B, "bea", "Bea Override");
await doneInWeek(bea, "Done, digest on for me only");
await sql(`insert into public.accountability_settings (counselor_id, student_id, timezone, weekly_digest) values ('${B.id}', '${bea.id}', 'UTC', 'draft')`);
const bob = await student(B, "bob", "Bob Default");
await doneInWeek(bob, "Done, counselor has digest off");

const P = await counselor("pending", "draft", { approved: false });
const pia = await student(P, "pia", "Pia Pending");
await doneInWeek(pia, "Done, counselor unapproved");

const O = await counselor("other", "draft");
const delMe = await student(A, "delete", "Del Deleted");
await doneInWeek(delMe, "Done, report to be deleted");
const late = await student(A, "late", "Lee Late");
await doneInWeek(late, "Done, parent opts out after approval");
await sql(`insert into public.guardians (student_id, full_name, email, preferred_channel) values ('${late.id}', 'Late Parent', '${TAG}-late@test.local', 'email')`);

// ---- The job ------------------------------------------------------------------------------------------------------
{
  const r1 = await dispatch();
  check("the dispatch cron ran the digest job", r1.status === 200 && r1.body.weeklyDigest?.ran === true, JSON.stringify(r1.body.weeklyDigest ?? r1.body));
  check("a student with something to report gets one draft for last week", (await reports(ana)) === 1);
  const rep = await reportOf(ana);
  check("...a weekly draft for Monday to Sunday", rep.status === "draft" && rep.kind === "weekly" && rep.period_start === W0 && rep.period_end === (await sql(`select ('${W0}'::date + 6)::text`)));
  check("...belonging to the student's counselor", rep.counselor_id === A.id);
  check("...with the finished task, the overdue and due-soon tasks, the deadline and the word count", /Upload transcript/.test(rep.body) && /Overdue since .*: Brag sheet/.test(rep.body) && /Due .*: Ask for a recommendation/.test(rep.body) && /Boston University: /.test(rep.body) && /Personal statement: 412 words, \+85 this week/.test(rep.body), rep.body);
  check("...not a task hidden from the student, nor a school already submitted", !/HIDDEN-COUNSELOR-ONLY/.test(rep.body) && !/Submitted College/.test(rep.body));
  check("...first name only", /Ana's week/.test(rep.title) && !/María|Lopez/.test(JSON.stringify(rep)));
  check("...with a summary and highlights", typeof rep.summary === "string" && rep.summary.length > 0 && rep.highlights.length > 0);
  check("nothing to report: no draft", (await reports(quiet)) === 0);
  check("an archived student: no draft", (await reports(archived)) === 0);
  check("a per-student row switching the digest off: no draft", (await reports(optedOut)) === 0);
  check("a per-student row switching it on under a counselor who has it off: a draft", (await reports(bea)) === 1);
  check("a counselor with the digest off: no draft", (await reports(bob)) === 0);
  check("an unapproved counselor: no draft", (await reports(pia)) === 0);
  check("no other counselor gets a report for this student", (await count(`select count(*) from public.family_reports where student_id = '${ana.id}' and counselor_id <> '${A.id}'`)) === 0);
  check("the counselor's work item is on the queue", (await count(`select count(*) from public.counselor_work_items w join public.family_reports r on r.id = w.family_report_id where r.student_id = '${ana.id}' and w.kind = 'report' and w.counselor_id = '${A.id}' and not w.done`)) === 1);
  check("the job sends nothing: no message rows", (await messages(ana)) === 0);
  check("...and no deliveries", (await count(`select count(*) from public.message_deliveries where student_id = '${ana.id}'`)) === 0);

  await dispatch();
  await dispatch();
  check("repeated runs add no second draft or work item", (await reports(ana)) === 1 && (await count(`select count(*) from public.counselor_work_items w join public.family_reports r on r.id = w.family_report_id where r.student_id = '${ana.id}'`)) === 1);
  await sql(`delete from private.job_leases where name = 'weekly-digest'`);
  const [x, y] = await Promise.all([dispatch({ clearLease: false }), dispatch({ clearLease: false })]);
  check("two overlapping runs: one holds the lease", [x, y].filter((r) => r.body.weeklyDigest?.ran === true).length <= 1, JSON.stringify([x.body.weeklyDigest, y.body.weeklyDigest]));
  check("...and still one draft per student", (await reports(ana)) === 1 && (await reports(bea)) === 1);
  const held = await dispatch({ clearLease: false });
  check("a run inside the hour after one ran skips (the lease is kept for the hour)", held.body.weeklyDigest?.ran === false && held.body.weeklyDigest?.reason === "locked", JSON.stringify(held.body.weeklyDigest));
}

// ---- The review queue ----------------------------------------------------------------------------------------------
const rep = await reportOf(ana);
{
  const list = await call(A.token, "GET", `/reports/family?studentId=${ana.id}&status=draft`);
  const mine = Array.isArray(list.body) ? list.body.find((r) => r.id === rep.id) : null;
  check("the draft shows in the review queue", list.status === 200 && mine && mine.kind === "weekly" && mine.status === "draft", JSON.stringify(list.body).slice(0, 300));
  check("...with its week", mine?.periodStart === W0);
  const items = await call(A.token, "GET", `/work-items?studentId=${ana.id}&includeDerived=true`);
  check("...and on My Work Queue, once", items.status === 200 && items.body.filter((i) => i.familyReportId === rep.id).length === 1, JSON.stringify(items.body).slice(0, 300));
}

// ---- Who would receive it -------------------------------------------------------------------------------------------
{
  const r = await call(A.token, "GET", `/reports/family/${rep.id}/recipients`);
  check("recipients answers", r.status === 200, JSON.stringify(r.body));
  const names = (r.body.recipients ?? []).map((x) => `${x.name}:${x.channels.join("+")}`).sort();
  check("only guardians with alerts on and reports on, on their preferred channel", JSON.stringify(names) === JSON.stringify(["Luis Lopez:sms", "Rosa Lopez:email"]), JSON.stringify(names));
  check("skips are counted with the reason", r.body.skipped?.optedOut === 2 && r.body.skipped?.noContact === 1 && r.body.skipped?.parentsOff === 0, JSON.stringify(r.body.skipped));
  const email = (r.body.messages ?? []).find((m) => m.channel === "email");
  const text = (r.body.messages ?? []).find((m) => m.channel === "sms");
  check("the exact email text: greeting, report, footer", email && /Dear Rosa,/.test(email.text) && email.text.includes("Upload transcript") && /Sent by Dana a through Meridies/.test(email.text), JSON.stringify(email));
  check("the exact text message: opener and summary", text && text.text.startsWith("Hi Luis, it's Dana a about Ana:") && text.to === "+15555550142", JSON.stringify(text));
  check("the essay text is nowhere in it", !JSON.stringify(r.body).includes(SENTINEL));
  check("canSend says yes", r.body.canSend === true);

  const off = await reportOf(parentsOff);
  const r2 = await call(A.token, "GET", `/reports/family/${off.id}/recipients`);
  check("with copy_parents off nobody would receive it", r2.status === 200 && r2.body.recipients.length === 0 && r2.body.skipped.parentsOff === 1 && r2.body.canSend === false, JSON.stringify(r2.body));
  const send2 = await call(A.token, "POST", `/reports/family/${off.id}/approve-send`, { confirm: true });
  check("...and approve-send refuses it", send2.status === 400 && (await messages(parentsOff)) === 0, `status ${send2.status} ${JSON.stringify(send2.body)}`);
  check("...leaving the draft a draft", (await reportOf(parentsOff)).status === "draft");

  const foreign = await call(O.token, "GET", `/reports/family/${rep.id}/recipients`);
  check("a counselor of another practice can't see the recipients", foreign.status === 403 || foreign.status === 404, `status ${foreign.status}`);
  const asStudent = await call(ana.token, "GET", `/reports/family/${rep.id}/recipients`);
  check("the student can't either", asStudent.status === 403 || asStudent.status === 404, `status ${asStudent.status}`);
}

// ---- Approve and send -------------------------------------------------------------------------------------------------
{
  for (const [label, body] of [["no body", undefined], ["confirm false", { confirm: false }], ["an extra key", { confirm: true, to: "x@y.z" }]]) {
    const r = await call(A.token, "POST", `/reports/family/${rep.id}/approve-send`, body);
    check(`approve-send refuses ${label}`, r.status === 400, `status ${r.status}`);
  }
  check("...and sent nothing", (await messages(ana)) === 0);

  const foreign = await call(O.token, "POST", `/reports/family/${rep.id}/approve-send`, { confirm: true });
  check("a counselor of another practice gets 403/404", foreign.status === 403 || foreign.status === 404, `status ${foreign.status}`);
  const piaReport = await sql(`with r as (insert into public.family_reports (student_id, counselor_id, title, kind, body, status) values ('${pia.id}', '${P.id}', 'Pending report', 'ad-hoc', 'Body', 'draft') returning id) select id from r`);
  await sql(`insert into public.guardians (student_id, full_name, email, preferred_channel) values ('${pia.id}', 'Pia Parent', '${TAG}-pia@test.local', 'email')`);
  const pending = await call(P.token, "POST", `/reports/family/${piaReport}/approve-send`, { confirm: true });
  check("an unapproved counselor can't approve-send", pending.status === 403, `status ${pending.status}`);
  check("...and nothing was written", (await messages(pia)) === 0);
  check("nothing sent by anyone yet", (await messages(ana)) === 0);

  const ok = await call(A.token, "POST", `/reports/family/${rep.id}/approve-send`, { confirm: true });
  check("the counselor approves and sends", ok.status === 200, `status ${ok.status} ${JSON.stringify(ok.body)}`);
  const rows = JSON.parse(await sql(`select coalesce(json_agg(m order by channel), '[]') from public.student_messages m where student_id = '${ana.id}'`));
  check("one scheduled parent row per channel", rows.length === 2 && rows.every((m) => m.audience === "parent" && m.status === "scheduled" && m.counselor_id === A.id), JSON.stringify(rows.map((m) => [m.channel, m.status])));
  const em = rows.find((m) => m.channel === "email");
  const sm = rows.find((m) => m.channel === "sms");
  check("...the email to the email guardian only, with the report's title and body", em && em.recipients.length === 1 && em.recipients[0].name === "Rosa Lopez" && em.subject === rep.title && em.body === rep.body);
  check("...the text to the text guardian only, with the summary", sm && sm.recipients.length === 1 && sm.recipients[0].name === "Luis Lopez" && sm.body === rep.summary);
  check("...nobody who opted out or has no contact", !JSON.stringify(rows).match(/Opted Reports|Opted Alerts|No Phone/));
  const after = await reportOf(ana);
  check("the report is marked sent, with when", after.status === "sent" && after.sent_at);
  check("the work item is done", (await count(`select count(*) from public.counselor_work_items where family_report_id = '${rep.id}' and done and done_at is not null`)) === 1);
  check("who approved it is recorded", (await count(`select count(*) from public.audit_log where action = 'family_report.approve_send' and entity_id = '${rep.id}' and actor_id = '${A.id}'`)) === 1);
  const ids = rows.map((m) => m.id).sort();
  const audited = JSON.parse(await sql(`select coalesce(metadata->'messageIds', 'null'::jsonb) from public.audit_log where action = 'family_report.approve_send' and entity_id = '${rep.id}'`));
  check("...with the message ids it created", JSON.stringify([...(audited ?? [])].sort()) === JSON.stringify(ids), JSON.stringify(audited));
  check("every message row names its family report", rows.every((m) => m.family_report_id === rep.id));

  const again = await call(A.token, "POST", `/reports/family/${rep.id}/approve-send`, { confirm: true });
  check("a second approve is a 409", again.status === 409, `status ${again.status}`);
  const [p1, p2] = await Promise.all([
    call(A.token, "POST", `/reports/family/${(await reportOf(dismissMe)).id}/approve-send`, { confirm: true }),
    call(A.token, "POST", `/reports/family/${(await reportOf(dismissMe)).id}/approve-send`, { confirm: true }),
  ]);
  check("(a student with no guardian is refused both times)", p1.status === 400 && p2.status === 400, `${p1.status} ${p2.status}`);
  check("...and never a double send", (await messages(ana)) === 2);

  // The existing dispatcher sends them, re-checking everything; no provider is set, so the rows record that.
  await dispatch();
  const sentRows = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('channel', channel, 'status', status)), '[]') from public.student_messages where student_id = '${ana.id}'`));
  check("the dispatcher picked both rows up", sentRows.every((m) => m.status !== "scheduled"), JSON.stringify(sentRows));
  check("...the email went to the email guardian only", (await count(`select count(*) from public.message_deliveries where student_id = '${ana.id}' and channel = 'email'`)) === 1);
}

// ---- Two approvals at once, and a parent who opts out of reports after approval ---------------------------------------
{
  const lr = await reportOf(late);
  const [a1, a2] = await Promise.all([
    call(A.token, "POST", `/reports/family/${lr.id}/approve-send`, { confirm: true }),
    call(A.token, "POST", `/reports/family/${lr.id}/approve-send`, { confirm: true }),
  ]);
  check("two approvals at once: exactly one 200 and one 409", [a1.status, a2.status].sort().join(",") === "200,409", `${a1.status} ${a2.status}`);
  check("...and exactly one message row", (await messages(late)) === 1);
  await sql(`update public.guardians set receives_reports = false where student_id = '${late.id}'`);
  await dispatch();
  const m = JSON.parse((await sql(`select row_to_json(m) from public.student_messages m where student_id = '${late.id}'`)) || "{}");
  check("a parent who turned reports off after approval: the message is cancelled, with the reason", m.status === "cancelled" && /reports/i.test(m.hold_reason ?? ""), JSON.stringify([m.status, m.hold_reason]));
  check("...and nothing was delivered", (await count(`select count(*) from public.message_deliveries where student_id = '${late.id}'`)) === 0);
}

// ---- Deleting a weekly draft archives it ----------------------------------------------------------------------------------
{
  const d = await reportOf(delMe);
  const r = await call(A.token, "DELETE", `/reports/family/${d.id}`);
  check("deleting a weekly draft answers ok", r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  check("...and keeps it, archived", (await count(`select count(*) from public.family_reports where id = '${d.id}' and status = 'archived'`)) === 1);
  check("...its work item is done", (await count(`select count(*) from public.counselor_work_items where family_report_id = '${d.id}' and done`)) === 1);
  await dispatch();
  check("the next run doesn't draft that week again", (await reports(delMe)) === 1 && (await reportOf(delMe))?.id === d.id && (await reportOf(delMe))?.status === "archived");
  const adhoc = await sql(`with r as (insert into public.family_reports (student_id, counselor_id, title, kind, body, status) values ('${delMe.id}', '${A.id}', 'Ad hoc', 'ad-hoc', 'Body', 'draft') returning id) select id from r`);
  const r2 = await call(A.token, "DELETE", `/reports/family/${adhoc}`);
  check("another kind of report is still deleted", r2.status === 200 && (await count(`select count(*) from public.family_reports where id = '${adhoc}'`)) === 0);
}

// ---- One student's failure doesn't stop the rest of the roster -------------------------------------------------------------
{
  const F = await counselor("fail", "draft");
  const fs = [];
  for (const n of ["one", "two", "three", "four"]) {
    const s = await student(F, `fail-${n}`, `Fay ${n}`);
    await doneInWeek(s, `Done ${n}`);
    fs.push(s);
  }
  const broken = fs[1];
  const fn = `${TAG.replace(/[^a-z0-9]/g, "")}_fail_${Date.now()}`;
  await sql(`create function public.${fn}() returns trigger language plpgsql as $$ begin raise exception 'digest test failure'; end $$`);
  await sql(`create trigger ${fn} before insert on public.family_reports for each row when (new.student_id = '${broken.id}') execute function public.${fn}()`);
  let r;
  try {
    r = await dispatch();
  } finally {
    await sql(`drop trigger if exists ${fn} on public.family_reports`);
    await sql(`drop function if exists public.${fn}()`);
  }
  check("one student failing is counted alone", r.body.weeklyDigest?.failedStudents === 1 && r.body.weeklyDigest?.failedCounselors === 0, JSON.stringify(r.body.weeklyDigest));
  const others = fs.filter((s) => s !== broken);
  const drafted = await Promise.all(others.map(reports));
  check("...the rest of that counselor's roster still gets drafts", drafted.every((n) => n === 1), JSON.stringify(drafted));
  check("...the failing student has none", (await reports(broken)) === 0);
  check("...and the hourly lease stays held", (await count(`select count(*) from private.job_leases where name = 'weekly-digest' and expires_at > now() + interval '50 minutes'`)) === 1);
}

// ---- Dismiss ---------------------------------------------------------------------------------------------------------
{
  const d = await reportOf(dismissMe);
  const foreign = await call(O.token, "POST", `/reports/family/${d.id}/dismiss`);
  check("a counselor of another practice can't dismiss", foreign.status === 403 || foreign.status === 404, `status ${foreign.status}`);
  const r = await call(A.token, "POST", `/reports/family/${d.id}/dismiss`);
  check("the counselor dismisses a draft", r.status === 200 && r.body.status === "archived", JSON.stringify(r.body));
  check("...its work item is done", (await count(`select count(*) from public.counselor_work_items where family_report_id = '${d.id}' and done`)) === 1);
  check("...and nothing is sent", (await messages(dismissMe)) === 0);
  const twice = await call(A.token, "POST", `/reports/family/${d.id}/dismiss`);
  check("dismissing it again is a 409", twice.status === 409, `status ${twice.status}`);
  const send = await call(A.token, "POST", `/reports/family/${d.id}/approve-send`, { confirm: true });
  check("a dismissed report can't be sent", send.status === 409, `status ${send.status}`);
  await dispatch();
  check("a dismissed week isn't drafted again", (await reports(dismissMe)) === 1);
}

// ---- The essay text never left the essay -------------------------------------------------------------------------------
check(
  "the sentinel essay text is in no family report, message or delivery",
  (await count(`select count(*) from public.family_reports where (title || coalesce(summary,'') || coalesce(body,'') || array_to_string(highlights, ' ')) like '%${SENTINEL}%'`)) === 0 &&
    (await count(`select count(*) from public.student_messages where (coalesce(subject,'') || body || recipients::text) like '%${SENTINEL}%'`)) === 0 &&
    (await count(`select count(*) from public.counselor_work_items where (title || coalesce(detail,'')) like '%${SENTINEL}%'`)) === 0
);

// ---- Clean up -------------------------------------------------------------------------------------------------------------
await sql(`delete from private.job_leases where name = 'weekly-digest'`);
await sql(`delete from public.message_deliveries where student_id in (select id from public.profiles where email like '${TAG}-%')`);
await sql(`delete from auth.users where email like '${TAG}-%@test.local'`);
check("(fixtures removed)", (await count(`select count(*) from public.profiles where email like '${TAG}-%'`)) === 0);
