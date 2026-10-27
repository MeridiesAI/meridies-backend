// Time saved: completions are recorded (and undone) by triggers on the source tables.
import { check, call, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("kpi-c");
const student = await studentOf(c, "kpi-c-student");
const MONTH = () => sql(`select private.kpi_month_of('${c.id}', now())::text`);

const report = () => sql(`with r as (insert into public.family_reports (student_id, counselor_id, title) values ('${student.id}', '${c.id}', 'Progress') returning id) select id from r`);
const sent = (id) => call(c.token, "POST", `/reports/family/${id}/sent`);
const unsend = (id) => rest(c.token, "PATCH", `/rest/v1/family_reports?id=eq.${id}`, { status: "draft" });
const rows = (where) => sql(`select count(*) from public.kpi_completions where counselor_id='${c.id}' ${where}`);
const field = (col, dedupe) => sql(`select ${col} from public.kpi_completions where counselor_id='${c.id}' and dedupe_key='${dedupe}'`);
const session = (type, subject, secs) =>
  sql(`insert into public.kpi_task_sessions (counselor_id, task_type, subject_id, active_seconds, last_active_on) values ('${c.id}', '${type}', '${subject}', ${secs}, current_date)
       on conflict (counselor_id, task_type, subject_id) do update set active_seconds = excluded.active_seconds`);

// ---- No session, under 5 measured completions → signup figure, estimated ----------
{
  const id = await report();
  const r = await sent(id);
  check("marking a report sent works", r.status === 200, JSON.stringify(r.body));
  check("one completion recorded", (await rows(`and dedupe_key='${id}'`)) === "1");
  check("no session → signup figure", (await field("measure_method", id)) === "signup" && Number(await field("meridies_minutes", id)) === 10);
  check("defaults are estimates", (await field("manual_is_estimate", id)) === "t" && (await field("rate_is_estimate", id)) === "t" && Number(await field("manual_minutes", id)) === 60);
  check("saved = 60 − 10", Number(await field("saved_minutes", id)) === 50);
  check("credited to the caller in their month", (await field("month::text", id)) === (await MONTH()));
}

// ---- A month crossing a settings change keeps each row's own snapshot -------------
{
  await sql(`insert into public.kpi_baselines (counselor_id, manual, manual_edited) values ('${c.id}', '{"family_report": 60}', '{"family_report": true}')
             on conflict (counselor_id) do update set manual = excluded.manual, manual_edited = excluded.manual_edited`);
  const before = await report();
  await sent(before);
  await sql(`update public.kpi_baselines set manual = '{"family_report": 90}' where counselor_id = '${c.id}'`);
  const after = await report();
  await sent(after);
  check("settings change mid-month: earlier row keeps 60", Number(await field("manual_minutes", before)) === 60);
  check("...later row uses 90", Number(await field("manual_minutes", after)) === 90);
  check("...and an edited figure is not an estimate", (await field("manual_is_estimate", after)) === "f");
}

// ---- Re-run five times counts once, and its time adds up ---------------------------
{
  const s2 = await studentOf(c, "kpi-c-rerun");
  for (let i = 0; i < 5; i++) {
    await session("college_list", s2.id, 60);
    const v = await rest(c.token, "POST", "/rest/v1/college_list_variants", { student_id: s2.id, name: `AI list ${i}`, generated_by: "ai", created_by: c.id });
    if (i === 0) check("an AI list variant can be saved", v.status === 201, JSON.stringify(v.body));
  }
  const key = `${s2.id}:${(await MONTH()).slice(0, 7)}`;
  check("re-run five times counts once", (await rows(`and task_type='college_list' and student_id='${s2.id}'`)) === "1");
  check("...with all five sessions' time", (await field("measured_seconds", key)) === "300", await field("measured_seconds", key));
  const s4 = await studentOf(c, "kpi-c-hand");
  const hand = await rest(c.token, "POST", "/rest/v1/college_list_variants", { student_id: s4.id, name: "By hand", generated_by: "counselor", created_by: c.id });
  check("a hand-made list counts nothing", hand.status === 201 && (await rows(`and task_type='college_list' and student_id='${s4.id}'`)) === "0", `status ${hand.status}`);
}

// ---- Undo before the month is finalized removes the time --------------------------
{
  const id = await report();
  await sent(id);
  const u = await unsend(id);
  check("un-marking a report sent works", u.status < 300, JSON.stringify(u.body));
  check("undo before finalize removes that task", (await rows(`and dedupe_key='${id}'`)) === "0");
}

// ---- Undo after the report is finalized changes nothing ---------------------------
{
  const id = await report();
  await sent(id);
  await sql(`insert into public.kpi_months (counselor_id, month) values ('${c.id}', '${await MONTH()}') on conflict do nothing`);
  await unsend(id);
  check("undo after finalize changes nothing", (await rows(`and dedupe_key='${id}'`)) === "1");
  const late = await report();
  await sent(late);
  check("a completion in a finalized month is not added", (await rows(`and dedupe_key='${late}'`)) === "0");
  await sql(`delete from public.kpi_months where counselor_id = '${c.id}'`);
}

// ---- A service-role write credits the row's counselor -----------------------------
{
  const id = await report();
  await sql(`update public.family_reports set status = 'sent', sent_at = now() where id = '${id}'`);
  check("service-role write credits the row's counselor", (await rows(`and dedupe_key='${id}'`)) === "1");
}

// ---- Month boundary in the consultant's time zone ---------------------------------
{
  await sql(`update public.profiles set timezone = 'America/Los_Angeles' where id = '${c.id}'`);
  const m = await sql(`select private.kpi_month_of('${c.id}', '2026-11-01 06:30:00+00')::text`);
  check("11:30 pm on Oct 31 in Los Angeles counts in October", m === "2026-10-01", m);
  await sql(`update public.profiles set timezone = 'Not/AZone' where id = '${c.id}'`).catch(() => {});
  const bad = await sql(`select private.kpi_month_of('${c.id}', '2026-11-01 06:30:00+00')::text`);
  check("an unknown time zone falls back to UTC", bad === "2026-11-01", bad);
  await sql(`update public.profiles set timezone = null where id = '${c.id}'`).catch(() => {});
}

// ---- Cap at 3× the median once there are 5 measured completions --------------------
{
  const cap = await user("kpi-cap");
  const s3 = await studentOf(cap, "kpi-cap-student");
  for (let i = 0; i < 5; i++) {
    await sql(`insert into public.kpi_completions (counselor_id, task_type, dedupe_key, month, manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, measure_method, saved_minutes, hourly_rate, rate_is_estimate)
               values ('${cap.id}', 'family_report', 'seed-${i}', date_trunc('month', now())::date, 60, true, 600, 10, 'active', 50, 150, true)`);
  }
  await sql(`insert into public.kpi_task_sessions (counselor_id, task_type, subject_id, active_seconds) values ('${cap.id}', 'family_report', '${s3.id}', 3600)`);
  const id = await sql(`with r as (insert into public.family_reports (student_id, counselor_id, title) values ('${s3.id}', '${cap.id}', 'P') returning id) select id from r`);
  await call(cap.token, "POST", `/reports/family/${id}/sent`);
  const got = await sql(`select measure_method || ' ' || meridies_minutes::text || ' ' || measured_seconds::text from public.kpi_completions where dedupe_key = '${id}'`);
  check("60 measured minutes against a 10-minute median is capped at 30", got === "capped 30.00 3600", got);
  check("the session was consumed", (await sql(`select count(*) from public.kpi_task_sessions where counselor_id='${cap.id}'`)) === "0");
  const id2 = await sql(`with r as (insert into public.family_reports (student_id, counselor_id, title) values ('${s3.id}', '${cap.id}', 'P2') returning id) select id from r`);
  await call(cap.token, "POST", `/reports/family/${id2}/sent`);
  const got2 = await sql(`select measure_method || ' ' || meridies_minutes::text from public.kpi_completions where dedupe_key = '${id2}'`);
  check("no session with 5+ measured → the median", got2 === "median 10.00", got2);
}

// ---- Meetings: "Notes sent" mark and unmark -----------------------------------------
{
  const mid = await sql(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at, status) values ('${student.id}', '${c.id}', 'Check-in', now() - interval '2 hours', 'held') returning id) select id from m`);
  await sql(`update public.meetings set notes_sent_at = now() where id = '${mid}'`);
  check("notes sent records a meeting completion", (await rows(`and task_type='meeting' and dedupe_key='${mid}'`)) === "1");
  await sql(`update public.meetings set notes_sent_at = null where id = '${mid}'`);
  check("un-marking removes it", (await rows(`and task_type='meeting' and dedupe_key='${mid}'`)) === "0");
}

// ---- Activities: accepted recommendation, undone by deleting its task --------------
{
  const run = await sql(`with r as (insert into public.research_runs (student_id, counselor_id, feature, inputs_hash, brief, status, expires_at) values ('${student.id}', '${c.id}', 'activities', 'h-${Date.now()}', '{}', 'succeeded', now() + interval '7 days') returning id) select id from r`);
  const rec = await sql(`with r as (insert into public.recommendations (run_id, student_id, feature, title, why) values ('${run}', '${student.id}', 'activities', 'Robotics camp', 'Fits.') returning id) select id from r`);
  const task = await sql(`with d as (insert into public.deliverables (student_id, kind, title, status, source, created_by, visible_to_student) values ('${student.id}', 'custom', 'Robotics camp', 'not-started', 'counselor', '${c.id}', false) returning id) select id from d`);
  await sql(`update public.recommendations set status = 'accepted', accepted_by = '${c.id}', accepted_at = now() where id = '${rec}'`);
  check("the claim alone records nothing", (await rows(`and task_type='activity_list'`)) === "0");
  await sql(`update public.recommendations set accepted_as = '{"type":"task","id":"${task}"}' where id = '${rec}'`);
  check("an accepted activity records a completion", (await rows(`and task_type='activity_list'`)) === "1");
  await sql(`delete from public.deliverables where id = '${task}'`);
  check("deleting its task undoes it", (await rows(`and task_type='activity_list'`)) === "0");
}

// ---- Essay feedback: first decided mark of a review round ---------------------------
{
  const essay = await sql(`with e as (insert into public.essays (student_id, title, body) values ('${student.id}', 'Why us', 'I like it here. It is nice.') returning id) select id from e`);
  const qc = await sql(`with q as (insert into public.draft_quality_checks (student_id, essay_id) values ('${student.id}', '${essay}') returning id) select id from q`).catch(() => "");
  if (qc) {
    for (let i = 0; i < 2; i++) {
      await sql(`insert into public.essay_marks (student_id, essay_id, quality_check_id, dimension, start_offset, end_offset, quoted_text, comment) values ('${student.id}', '${essay}', '${qc}', 'content', 0, 4, 'I li', 'Say more.')`);
    }
    await sql(`update public.essay_marks set status = 'accepted' where quality_check_id = '${qc}'`);
    check("a review round counts once", (await rows(`and task_type='essay_feedback' and dedupe_key='${essay}:${qc}'`)) === "1");
  } else {
    check("draft_quality_checks fixture insert", false, "could not create a quality check; adjust the fixture");
  }
}

// ---- Interrupted tracking uses the fallback, and never makes savings look bigger ----
{
  const u = await user("kpi-int");
  const s = await studentOf(u, "kpi-int-s");
  const send = async (title) => {
    const id = await sql(`with r as (insert into public.family_reports (student_id, counselor_id, title) values ('${s.id}', '${u.id}', '${title}') returning id) select id from r`);
    await call(u.token, "POST", `/reports/family/${id}/sent`);
    return sql(`select measure_method || ' ' || meridies_minutes::text || ' ' || saved_minutes::text from public.kpi_completions where dedupe_key = '${id}'`);
  };
  await sql(`insert into public.kpi_task_sessions (counselor_id, task_type, subject_id, active_seconds, interrupted) values ('${u.id}', 'family_report', '${s.id}', 120, true)`);
  check("an interrupted task uses the fallback figure (2 min measured, 10 signup)", (await send("A")) === "fallback 10.00 50.00");
  await sql(`insert into public.kpi_task_sessions (counselor_id, task_type, subject_id, active_seconds, interrupted) values ('${u.id}', 'family_report', '${s.id}', 3600, true)`);
  check("...but never less than what was measured (60 min measured)", (await send("B")) === "fallback 60.00 0.00");
}

// ---- Un-marking and re-marking Notes sent keeps the measured time -------------------
{
  const u = await user("kpi-remark");
  const s = await studentOf(u, "kpi-remark-s");
  const mid = await sql(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at, status) values ('${s.id}', '${u.id}', 'R', now() - interval '1 hour', 'held') returning id) select id from m`);
  await sql(`insert into public.kpi_task_sessions (counselor_id, task_type, subject_id, active_seconds) values ('${u.id}', 'meeting', '${mid}', 600)`);
  await call(u.token, "POST", `/meetings/${mid}/notes-sent`);
  await call(u.token, "DELETE", `/meetings/${mid}/notes-sent`);
  await call(u.token, "POST", `/meetings/${mid}/notes-sent`);
  check("re-marking keeps the meeting's measured time", (await sql(`select measured_seconds::text || ' ' || measure_method from public.kpi_completions where dedupe_key='${mid}'`)) === "600 active");
}

// ---- Edge case: an accepted recommendation with no accepted_by records no completion ----
{
  const u = await user("kpi-noactor");
  const s = await studentOf(u, "kpi-noactor-s");
  const run = await sql(`with r as (insert into public.research_runs (student_id, counselor_id, feature, inputs_hash, brief, status, expires_at) values ('${s.id}', '${u.id}', 'activities', 'h-${Date.now()}', '{}', 'succeeded', now() + interval '7 days') returning id) select id from r`);
  const rec = await sql(`with r as (insert into public.recommendations (run_id, student_id, feature, title, why) values ('${run}', '${s.id}', 'activities', 'Camp', 'Fits.') returning id) select id from r`);
  const task = await sql(`with d as (insert into public.deliverables (student_id, kind, title, status, source, created_by, visible_to_student) values ('${s.id}', 'custom', 'Camp', 'not-started', 'counselor', '${u.id}', false) returning id) select id from d`);
  await sql(`update public.recommendations set status = 'accepted', accepted_as = '{"type":"task","id":"${task}"}' where id = '${rec}'`);
  check("no accepted_by → no completion for anyone", (await sql(`select count(*) from public.kpi_completions where task_type='activity_list' and student_id='${s.id}'`)) === "0");
}
