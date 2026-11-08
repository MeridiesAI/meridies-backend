// Counselor alerts (20261111000003): the settings, the inactivity alert on the scheduled sweep, the essay
// notice, and the last-active mark. Needs the migration applied and an API with the service role key and
// CRON_SECRET; no email provider (deliveries record without sending).
import { API, CRON_SECRET, call, check, sql, sqlAsync, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = `ESSAY-TEXT-${Math.random().toString(36).slice(2)}`;

/** The scheduled sweep; another suite's run may hold the lease, so try a few times. */
async function sweep() {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${API}/internal/accountability/sweep`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    if (r.status !== 409) return { status: r.status, body: await r.json().catch(() => ({})) };
    await wait(500);
  }
  return { status: 409, body: {} };
}
const count = async (q) => Number(await sql(q));
const alerts = (s) => count(`select count(*) from public.student_inactivity_alerts where student_id = '${s.id}'`);
const notices = (c, s, like = "%") =>
  count(`select count(*) from public.notifications where recipient_id = '${c.id}' and student_id = '${s.id}' and kind = 'system' and title like '${like.replace(/'/g, "''")}'`);
const deliveries = (c, s, template) =>
  count(`select count(*) from public.message_deliveries where recipient_id = '${c.id}' and student_id = '${s.id}' and template = '${template}'`);
const inactiveSince = (s, joinedDays, activeDays) =>
  sql(`update public.profiles set created_at = now() - interval '${joinedDays} days', last_active_at = ${activeDays === null ? "null" : `now() - interval '${activeDays} days'`} where id = '${s.id}'`);
const settings = (c, cols) =>
  sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end${Object.keys(cols).map((k) => `, ${k}`).join("")})
       values ('${c.id}', 'UTC', null, null${Object.values(cols).map((v) => `, ${v}`).join("")})`);

// ---- Settings -----------------------------------------------------------------------------------------------
{
  const c = await user("alerts-settings");
  const s = await studentOf(c, "alerts-settings-student");
  const fresh = await call(c.token, "GET", "/accountability/settings");
  check("settings read the alert defaults", fresh.status === 200 && fresh.body.inactive_alert_days === null && fresh.body.notify_on_essay === false && fresh.body.weekly_digest === "off", JSON.stringify(fresh.body));

  const put = await call(c.token, "PUT", "/accountability/settings", { inactiveAlertDays: 7, notifyOnEssay: true, weeklyDigest: "draft" });
  check("a counselor saves the alert settings", put.status === 200 && put.body.inactive_alert_days === 7 && put.body.notify_on_essay === true && put.body.weekly_digest === "draft", JSON.stringify(put.body));
  const back = await call(c.token, "GET", "/accountability/settings");
  check("...and reads them back", back.body.inactive_alert_days === 7 && back.body.notify_on_essay === true && back.body.weekly_digest === "draft");
  check("...keeping the other settings", back.body.stall_after_days === 7 && back.body.enabled === true);

  const own = await call(c.token, "PUT", "/accountability/settings", { studentId: s.id, inactiveAlertDays: 3 });
  check("a per-student override saves", own.status === 200 && own.body.inactive_alert_days === 3, JSON.stringify(own.body));
  check("...seeded from the counselor-wide alert settings", own.body.notify_on_essay === true && own.body.weekly_digest === "draft");
  const forStudent = await call(c.token, "GET", `/accountability/settings?studentId=${s.id}`);
  const wide = await call(c.token, "GET", "/accountability/settings");
  check("the override applies to that student only", forStudent.body.inactive_alert_days === 3 && wide.body.inactive_alert_days === 7);

  const off = await call(c.token, "PUT", "/accountability/settings", { inactiveAlertDays: null });
  check("null switches the inactivity alert off", off.status === 200 && off.body.inactive_alert_days === null);

  for (const [label, body] of [
    ["an unknown key", { inactiveAlertDay: 3 }],
    ["snake_case", { inactive_alert_days: 3 }],
    ["zero days", { inactiveAlertDays: 0 }],
    ["91 days", { inactiveAlertDays: 91 }],
    ["a digest mode that sends", { weeklyDigest: "send" }],
    ["a non-boolean essay switch", { notifyOnEssay: "yes" }],
  ]) {
    const r = await call(c.token, "PUT", "/accountability/settings", body);
    check(`the strict body refuses ${label}`, r.status === 400, `status ${r.status}`);
  }
  const asStudent = await call(s.token, "PUT", "/accountability/settings", { inactiveAlertDays: 3 });
  check("a student can't change the alert settings", asStudent.status === 403, `status ${asStudent.status}`);
  const other = await user("alerts-settings-other");
  const foreign = await call(other.token, "PUT", "/accountability/settings", { studentId: s.id, inactiveAlertDays: 3 });
  check("a counselor can't override another counselor's student", foreign.status === 403 || foreign.status === 404, `status ${foreign.status}`);
}

// ---- Inactivity alert on the sweep ------------------------------------------------------------------------
{
  const c = await user("alerts-inactive");
  await settings(c, { inactive_alert_days: 7 });
  const idle = await studentOf(c, "Idle");
  const busy = await studentOf(c, "busy");
  const evented = await studentOf(c, "evented");
  const newcomer = await studentOf(c, "newcomer");
  const archived = await studentOf(c, "archived");
  await inactiveSince(idle, 30, 10);
  await inactiveSince(busy, 30, 1);
  await inactiveSince(evented, 30, 20);
  await sql(`insert into public.progress_events (student_id, entity_type, event, actor_id, created_at) values ('${evented.id}', 'essay', 'created', '${evented.id}', now() - interval '2 days')`);
  await inactiveSince(newcomer, 3, null);
  await inactiveSince(archived, 30, 10);
  await sql(`update public.profiles set archived_at = now() where id = '${archived.id}'`);

  const quiet = await user("alerts-quiet");
  const h = Number(await sql(`select extract(hour from now() at time zone 'UTC')::int`));
  await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end, inactive_alert_days)
             values ('${quiet.id}', 'UTC', ${h}, ${(h + 1) % 24}, 7)`);
  const hushed = await studentOf(quiet, "hushed");
  await inactiveSince(hushed, 30, 10);

  const offCounselor = await user("alerts-off");
  await settings(offCounselor, {});
  const unwatched = await studentOf(offCounselor, "unwatched");
  await inactiveSince(unwatched, 30, 10);

  const pending = await user("alerts-pending", "counselor", { approved: false });
  await settings(pending, { inactive_alert_days: 7 });
  const pendingStudent = await studentOf(pending, "pending-student");
  await inactiveSince(pendingStudent, 30, 10);

  const r1 = await sweep();
  check("the sweep ran", r1.status === 200, `status ${r1.status} ${JSON.stringify(r1.body)}`);
  check("an inactive student gets one alert row", (await alerts(idle)) === 1);
  check("...and the counselor one bell notice naming the days", (await notices(c, idle, "Idle hasn't been active in 10 days")) === 1);
  check("...and one email record", (await deliveries(c, idle, "inactivity-alert")) === 1);
  check("an active student gets none", (await alerts(busy)) === 0);
  check("a recent progress event counts as activity", (await alerts(evented)) === 0);
  check("a student on the roster fewer than N days gets none", (await alerts(newcomer)) === 0);
  check("an archived student gets none", (await alerts(archived)) === 0);
  check("nothing inside the counselor's quiet hours", (await alerts(hushed)) === 0 && (await notices(quiet, hushed)) === 0);
  check("nothing for a counselor with the alert off", (await alerts(unwatched)) === 0);
  check("nothing for an unapproved counselor", (await alerts(pendingStudent)) === 0 && (await notices(pending, pendingStudent)) === 0);
  check("no other counselor hears about this student", (await count(`select count(*) from public.notifications where student_id = '${idle.id}' and recipient_id <> '${c.id}'`)) === 0);

  await sweep();
  check("a second sweep in the same streak adds nothing", (await alerts(idle)) === 1 && (await notices(c, idle)) === 1 && (await deliveries(c, idle, "inactivity-alert")) === 1);

  // New activity ends the streak; going quiet again starts a new one.
  await sql(`update public.profiles set last_active_at = now() - interval '8 days' where id = '${idle.id}'`);
  await sweep();
  check("a new streak after new activity alerts again", (await alerts(idle)) === 2 && (await notices(c, idle)) === 2);

  // The counselor reads the alert rows; another counselor and the student don't.
  const mine = await call(c.token, "GET", "/accountability/settings");
  check("(the counselor's session works)", mine.status === 200);
  const restAs = async (token) => {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/student_inactivity_alerts?student_id=eq.${idle.id}`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    return r.json();
  };
  check("the counselor reads the student's alert rows", (await restAs(c.token)).length === 2);
  check("another counselor reads none", (await restAs(offCounselor.token)).length === 0);
  check("the student reads none", (await restAs(idle.token)).length === 0);
  const write = await fetch(`${process.env.SUPABASE_URL}/rest/v1/student_inactivity_alerts`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ student_id: idle.id, last_activity_at: new Date().toISOString() }),
  });
  check("a counselor can't write an alert row", write.status >= 400, `status ${write.status}`);
}

// ---- Essay notice -----------------------------------------------------------------------------------------
{
  const c = await user("alerts-essay");
  await settings(c, { notify_on_essay: true });
  const s = await studentOf(c, "Writer");

  const created = await call(s.token, "POST", "/application/essays", { studentId: s.id, title: "Why us", body: `${SECRET} first draft words` });
  check("a student creates an essay", created.status === 201, `status ${created.status}`);
  await wait(300);
  check("the counselor gets one essay notice", (await notices(c, s, "Writer hasn't%")) === 0 && (await notices(c, s, "Writer worked on an essay")) === 1);
  check("...and an email, since notify_on_essay is on", (await deliveries(c, s, "essay-notice")) === 1);

  const again = await call(s.token, "PATCH", `/application/essays/${created.body.id}`, { body: `${SECRET} second draft words` });
  check("the student edits it again", again.status === 200, `status ${again.status}`);
  await wait(300);
  check("a second edit within six hours adds no notice", (await notices(c, s)) === 1 && (await deliveries(c, s, "essay-notice")) === 1);

  const leak = await count(`select count(*) from public.notifications where title like '%${SECRET}%' or coalesce(body, '') like '%${SECRET}%' or array_to_string(action_items, ' ') like '%${SECRET}%'`);
  const leakMail = await count(`select count(*) from public.message_deliveries where coalesce(subject, '') like '%${SECRET}%' or coalesce(body, '') like '%${SECRET}%'`);
  check("no essay text in any notification", leak === 0);
  check("no essay text in any delivery record", leakMail === 0);

  // The counselor editing the essay tells nobody.
  const c2 = await user("alerts-essay-counselor-edit");
  await settings(c2, { notify_on_essay: true });
  const s2 = await studentOf(c2, "Edited");
  const byCounselor = await call(c2.token, "POST", "/application/essays", { studentId: s2.id, title: "Draft", body: "counselor words" });
  check("the counselor creates an essay for the student", byCounselor.status === 201, `status ${byCounselor.status}`);
  await wait(300);
  check("...and no notice is made", (await count(`select count(*) from public.notifications where student_id = '${s2.id}' and kind = 'system'`)) === 0);

  // Bell only when notify_on_essay is off; nothing when the body didn't change.
  const c3 = await user("alerts-essay-bell");
  const s3 = await studentOf(c3, "Bell");
  const empty = await call(s3.token, "POST", "/application/essays", { studentId: s3.id, title: "Empty" });
  const titled = await call(s3.token, "PATCH", `/application/essays/${empty.body.id}`, { title: "Renamed" });
  const sameBody = await call(s3.token, "PATCH", `/application/essays/${empty.body.id}`, { body: "" });
  await wait(300);
  check("an essay with no text, a rename and an unchanged body make no notice", empty.status === 201 && titled.status === 200 && sameBody.status === 200 && (await notices(c3, s3)) === 0);
  const wrote = await call(s3.token, "PATCH", `/application/essays/${empty.body.id}`, { body: "now some words" });
  await wait(300);
  check("writing in it makes the bell notice", wrote.status === 200 && (await notices(c3, s3, "Bell worked on an essay")) === 1);
  check("...with no email while notify_on_essay is off", (await deliveries(c3, s3, "essay-notice")) === 0);

  // An unapproved counselor hears nothing.
  const c4 = await user("alerts-essay-revoked");
  await settings(c4, { notify_on_essay: true });
  const s4 = await studentOf(c4, "Orphan");
  await sql(`update public.profiles set counselor_approved_at = null where id = '${c4.id}'`);
  const orphan = await call(s4.token, "POST", "/application/essays", { studentId: s4.id, title: "Mine", body: "words of mine" });
  await wait(300);
  check("a student of an unapproved counselor makes no notice", orphan.status === 201 && (await count(`select count(*) from public.notifications where student_id = '${s4.id}'`)) === 0, `status ${orphan.status}`);
}

// ---- last_active_at ---------------------------------------------------------------------------------------
{
  const c = await user("alerts-last-active");
  const s = await studentOf(c, "active");
  const stamp = () => sql(`select coalesce(last_active_at::text, '') from public.profiles where id = '${s.id}'`);
  check("no mark before the student signs in to the API", (await stamp()) === "");
  await call(s.token, "GET", "/auth/me");
  await wait(500);
  const first = await stamp();
  check("a student's request marks them active", first !== "");
  await call(s.token, "GET", "/auth/me");
  await wait(500);
  check("a second request within the hour doesn't write again", (await stamp()) === first);
  await sql(`update public.profiles set last_active_at = now() - interval '2 hours' where id = '${s.id}'`);
  const old = await stamp();
  await call(s.token, "GET", "/auth/me");
  await wait(500);
  const later = await stamp();
  check("an hour on, the next request writes it again", later !== old && Date.parse(later) > Date.parse(old));
  await call(c.token, "GET", "/auth/me");
  await wait(500);
  check("a counselor's request doesn't mark them", (await sql(`select coalesce(last_active_at::text, '') from public.profiles where id = '${c.id}'`)) === "");
}

// ---- family_reports: room for the weekly digest -----------------------------------------------------------
{
  const c = await user("alerts-weekly");
  const s = await studentOf(c, "weekly");
  const ins = (kind, start) =>
    sqlAsync(`with i as (insert into public.family_reports (student_id, counselor_id, title, kind, period_start, period_end)
         values ('${s.id}', '${c.id}', 'Week', '${kind}', '${start}', '${start}'::date + 6)
         on conflict do nothing returning id) select count(*) from i`).then(Number);
  check("a weekly report can be written", (await ins("weekly", "2026-11-02")) === 1);
  check("a second weekly report for the same week is not", (await ins("weekly", "2026-11-02")) === 0);
  check("the next week is its own report", (await ins("weekly", "2026-11-09")) === 1);
  check("other kinds are not held to one per period", (await ins("progress", "2026-11-02")) === 1 && (await ins("progress", "2026-11-02")) === 1);
  let refused = false;
  try { await ins("fortnightly", "2026-11-02"); } catch { refused = true; }
  check("an unknown kind is still refused", refused);
}
