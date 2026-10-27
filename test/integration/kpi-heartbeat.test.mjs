// Time saved: server-timed heartbeats. Needs the API started with KPI_TRACKING_ENABLED=true.
// Server time is simulated by backdating the stored last-heartbeat time before each call.
import { check, call, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const a = await user("kpi-hb-a");
const b = await user("kpi-hb-b");
const student = await studentOf(a, "kpi-hb-student");
const hb = (u, taskType, subjectId) => call(u.token, "POST", "/kpi/heartbeat", { taskType, subjectId });
const session = (u, type, subject) =>
  sql(`select coalesce((select active_seconds from public.kpi_task_sessions where counselor_id='${u.id}' and task_type='${type}' and subject_id='${subject}')::text, 'none')`);
const backdate = (u, type, subject, secs) =>
  sql(`update public.kpi_task_sessions set last_heartbeat_at = now() - interval '${secs} seconds' where counselor_id='${u.id}' and task_type='${type}' and subject_id='${subject}'`);

// ---- Two tabs over the same 5 minutes count 5 minutes --------------------------
{
  const first = await hb(a, "college_list", student.id);
  check("first heartbeat starts a session", first.status === 202 && first.body.tracked === true && first.body.result === "started", JSON.stringify(first.body));
  // Tab A beats at 30,60,...,300 s; tab B at 15,45,...,285 s. Events in time order.
  const events = [];
  for (let t = 15; t <= 300; t += 15) events.push(t);
  let lastCounted = 0;
  const results = [];
  for (const t of events) {
    await backdate(a, "college_list", student.id, t - lastCounted);
    const r = await hb(a, "college_list", student.id);
    results.push(r.body.result);
    if (r.body.result === "counted") lastCounted = t;
  }
  const secs = Number(await session(a, "college_list", student.id));
  check("two tabs over the same 5 minutes count 5 minutes", secs >= 270 && secs <= 300, `active_seconds=${secs}`);
  check("beats under 30 s apart are throttled", results.filter((x) => x === "throttled").length >= 9, results.join(","));
}

// ---- A 2-hour gap adds nothing ---------------------------------------------------
{
  await hb(a, "activity_list", student.id);
  await backdate(a, "activity_list", student.id, 7200);
  const r = await hb(a, "activity_list", student.id);
  check("a 2-hour gap adds nothing", (await session(a, "activity_list", student.id)) === "0" && r.body.result === "idle-reset", JSON.stringify(r.body));
}

// ---- Another consultant's task is rejected -------------------------------------
{
  const r = await hb(b, "family_report", student.id);
  check("heartbeat for another consultant's student is rejected", r.status === 403 || r.status === 404, `status ${r.status}`);
  check("...and no session exists for them", (await session(b, "family_report", student.id)) === "none");
  const meetingId = await sql(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at) values ('${student.id}', '${a.id}', 'Check-in', now() - interval '1 hour') returning id) select id from m`);
  const r2 = await hb(b, "meeting", meetingId);
  check("heartbeat for another consultant's meeting is rejected", r2.status === 403 || r2.status === 404, `status ${r2.status}`);
  const own = await hb(a, "meeting", meetingId);
  check("the owner's meeting heartbeat is tracked", own.status === 202 && own.body.tracked === true, JSON.stringify(own.body));
  await sql(`delete from public.meetings where id = '${meetingId}'`);
  await sql(`delete from public.kpi_task_sessions where subject_id = '${meetingId}'`);
  const gone = await hb(a, "meeting", meetingId);
  check("a deleted meeting answers 404", gone.status === 404, `status ${gone.status}`);
  check("...and creates no session", (await session(a, "meeting", meetingId)) === "none");
}

// ---- Bad input -------------------------------------------------------------------
{
  const r = await call(a.token, "POST", "/kpi/heartbeat", { taskType: "nap", subjectId: student.id });
  check("an unknown task type is a 400", r.status === 400, `status ${r.status}`);
  const r2 = await call(a.token, "POST", "/kpi/heartbeat", { taskType: "meeting", subjectId: student.id, seconds: 999 });
  check("a duration in the body is refused", r2.status === 400, `status ${r2.status}`);
  const s = await user("kpi-hb-stu", "student");
  const r3 = await call(s.token, "POST", "/kpi/heartbeat", { taskType: "college_list", subjectId: s.id });
  check("a student gets 403", r3.status === 403, `status ${r3.status}`);
}

// ---- A client that lost heartbeats says so; the server remembers it for the task ----
{
  const s2 = await studentOf(a, "kpi-hb-int");
  await hb(a, "college_list", s2.id);
  const r = await call(a.token, "POST", "/kpi/heartbeat", { taskType: "college_list", subjectId: s2.id, interrupted: true });
  check("a heartbeat can report an interruption", r.status === 202 && r.body.tracked === true, JSON.stringify(r.body));
  check("...and the task is flagged", (await sql(`select interrupted::text from public.kpi_task_sessions where counselor_id='${a.id}' and subject_id='${s2.id}'`)) === "true");
  const bad = await call(a.token, "POST", "/kpi/heartbeat", { taskType: "college_list", subjectId: s2.id, interrupted: "yes" });
  check("interrupted must be a boolean", bad.status === 400, `status ${bad.status}`);
}
