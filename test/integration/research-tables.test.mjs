import { check, sql, user, rest, call, API, CRON_SECRET } from "./harness.mjs";
import { studentOf, firmWith } from "./imports-helpers.mjs";

const c = await user("res-tables");
const s = await studentOf(c, "res-tables-student");
const task = await sql(`with t as (insert into public.deliverables (student_id, kind, title, source, visible_to_student)
  values ('${s.id}', 'custom', 'HIDDEN-TASK', 'counselor', false) returning id) select id from t`);
const pg = await rest(s.token, "GET", `/rest/v1/deliverables?select=id&id=eq.${task}`);
check("a student can't read a hidden task through PostgREST", (pg.body ?? []).length === 0);
const api = await call(s.token, "GET", "/tasks");
check("…or through /tasks", !JSON.stringify(api.body).includes("HIDDEN-TASK"));
const me = await call(s.token, "GET", "/me/overview");
check("…or through /me", !JSON.stringify(me.body).includes("HIDDEN-TASK"));
const cs = await call(c.token, "GET", `/tasks?studentId=${s.id}`);
check("the counselor sees it", JSON.stringify(cs.body).includes("HIDDEN-TASK"));
check("the task DTO carries visibleToStudent", (cs.body ?? []).find((t) => t.id === task)?.visibleToStudent === false);

// A student can't change a hidden task either.
const patchPg = await rest(s.token, "PATCH", `/rest/v1/deliverables?id=eq.${task}`, { status: "complete" }, { Prefer: "return=representation" });
check("a student's PostgREST PATCH on a hidden task changes no rows", Array.isArray(patchPg.body) && patchPg.body.length === 0);
const delPg = await rest(s.token, "DELETE", `/rest/v1/deliverables?id=eq.${task}`, undefined, { Prefer: "return=representation" });
check("a student's PostgREST DELETE on a hidden task changes no rows", Array.isArray(delPg.body) && delPg.body.length === 0);
check("the hidden task is untouched", (await sql(`select status from public.deliverables where id = '${task}'`)) === "not-started");
const ghost = await call(s.token, "PATCH", `/tasks/00000000-0000-4000-8000-000000000001`, { status: "complete" });
const hid = await call(s.token, "PATCH", `/tasks/${task}`, { status: "complete" });
check("PATCH /tasks/:id by the student answers as for a missing task", hid.status === ghost.status && hid.status === 404, `${hid.status}/${ghost.status}`);

// Side records about a hidden task.
await sql(`insert into public.progress_events (student_id, deliverable_id, entity_type, entity_id, event) values ('${s.id}', '${task}', 'deliverable', '${task}', 'created')`);
await sql(`insert into public.deliverable_tracker_checks (student_id, deliverable_id, verdict, note, source) values ('${s.id}', '${task}', 'no-activity', 'n', 'system')`);
check("a student can't read the task's activity log rows", ((await rest(s.token, "GET", `/rest/v1/progress_events?select=id&deliverable_id=eq.${task}`)).body ?? []).length === 0);
check("…or its tracker checks", ((await rest(s.token, "GET", `/rest/v1/deliverable_tracker_checks?select=id&deliverable_id=eq.${task}`)).body ?? []).length === 0);
check("the counselor still reads the activity log row", ((await rest(c.token, "GET", `/rest/v1/progress_events?select=id&deliverable_id=eq.${task}`)).body ?? []).length === 1);

// visibleToStudent is the counselor's.
const stuCreate = await call(s.token, "POST", "/tasks", { title: "mine", visibleToStudent: false });
check("a student sending visibleToStudent on create gets 403", stuCreate.status === 403, `status ${stuCreate.status}`);
const visibleOne = await call(c.token, "POST", "/tasks", { studentId: s.id, title: "VISIBLE-ONE", notifyEmail: false });
const stuPatch = await call(s.token, "PATCH", `/tasks/${visibleOne.body.id}`, { visibleToStudent: false });
check("a student sending visibleToStudent on patch gets 403", stuPatch.status === 403, `status ${stuPatch.status}`);

// Counselor creates a hidden task: no stages mirror, no notification.
const made = await call(c.token, "POST", "/tasks", {
  studentId: s.id, title: "HIDDEN-CREATED", visibleToStudent: false, notifyEmail: true,
  stages: [{ name: "STAGE-X", dueDate: "2030-01-01" }],
});
check("a counselor creates a hidden task", made.status === 201 && made.body.visibleToStudent === false, `status ${made.status}`);
check("it mirrors no deadline and sends no notification", Number(await sql(`select count(*) from public.deadlines where student_id = '${s.id}' and title like 'HIDDEN-CREATED%'`)) === 0
  && Number(await sql(`select count(*) from public.notifications where recipient_id = '${s.id}' and title like '%HIDDEN-CREATED%'`)) === 0);
const resend = await call(c.token, "POST", `/tasks/${made.body.id}/notify`, {});
check("re-sending a hidden task's notification is refused", resend.status === 409, `status ${resend.status}`);

// Student-facing feeds.
const calVisible = await call(c.token, "POST", "/tasks", { studentId: s.id, title: "CAL-VISIBLE", dueDate: "2030-03-16", notifyEmail: false });
await sql(`update public.deliverables set due_date = '2030-03-15' where id = '${task}'`);
await sql(`update public.deliverables set due_date = '2030-03-17' where id = '${made.body.id}'`);
const feed = await call(s.token, "GET", "/calendar/feed?from=2030-03-01&to=2030-03-31&tz=UTC");
check("the student's calendar feed has the visible task in the window", JSON.stringify(feed.body).includes("CAL-VISIBLE"), `status ${feed.status}`);
check("…and not the hidden ones dated in the same window", !JSON.stringify(feed.body).includes("HIDDEN"));
const cfeed = await call(c.token, "GET", `/calendar/feed?from=2030-03-01&to=2030-03-31&tz=UTC&studentId=${s.id}`);
check("the counselor's feed has the hidden task", JSON.stringify(cfeed.body).includes("HIDDEN-TASK"));

// Accountability: a hidden task never makes the student look stalled.
await sql(`update public.deliverables set last_activity_at = now() - interval '60 days' where id = '${task}'`);
const stalledVisible = await call(c.token, "POST", "/tasks", { studentId: s.id, title: "STALLED-VISIBLE", notifyEmail: false });
await sql(`update public.deliverables set last_activity_at = now() - interval '60 days' where id = '${stalledVisible.body.id}'`);
const over = await call(c.token, "GET", "/accountability/overview");
const mine = (over.body.students ?? []).find((x) => x.studentId === s.id);
check("the alert list counts a stalled visible task", JSON.stringify(mine?.stalled ?? []).includes("STALLED-VISIBLE"));
check("…and never a stalled hidden one", !JSON.stringify(over.body).includes("HIDDEN-TASK"));
const flagHidden = await call(c.token, "POST", "/accountability/red-flags", { studentId: s.id, deliverableId: task, title: "API-FLAG-HIDDEN", message: "m" });
check("flagging a hidden task is refused (409)", flagHidden.status === 409, `status ${flagHidden.status}`);
check("…with no flag and no student notification", Number(await sql(`select count(*) from public.red_flags where title = 'API-FLAG-HIDDEN'`)) === 0
  && Number(await sql(`select count(*) from public.notifications where recipient_id = '${s.id}' and title = 'API-FLAG-HIDDEN'`)) === 0);
// The API refuses this now, so the row for the sweep check is written with sql() directly.
await sql(`insert into public.red_flags (student_id, deliverable_id, title, message, trigger, issued_by, issued_by_id, escalate_at)
  values ('${s.id}', '${task}', 'FLAG-HIDDEN', 'm', 'manual', 'counselor', '${c.id}', now() - interval '1 hour')`);
check("a student can't see a flag about a hidden task", ((await rest(s.token, "GET", `/rest/v1/red_flags?select=id&deliverable_id=eq.${task}`)).body ?? []).length === 0);
const hiddenFlagId = await sql(`select id from public.red_flags where title = 'FLAG-HIDDEN' and student_id = '${s.id}'`);
const sweep = await call(c.token, "POST", "/accountability/sweep", {});
const skip = (sweep.body.skipped ?? []).find((x) => x.id === hiddenFlagId);
check("the sweep skips a flag on a hidden task, naming that reason", sweep.status < 300 && /isn't shared with the student/.test(skip?.reason ?? ""), JSON.stringify(sweep.body));
check("…and the flag is still open", (await sql(`select status from public.red_flags where id = '${hiddenFlagId}'`)) === "open");

// Reminders: a hidden task due tomorrow is not reminded; a visible one is the control.
await sql(`insert into public.student_preferences (student_id, email_enabled, email_address) values ('${s.id}', true, 'r@test.local')
  on conflict (student_id) do update set email_enabled = true, email_address = 'r@test.local'`);
// Quiet hours default to 21:00-08:00, which would hold every reminder at night:
// give this counselor none, so the visible control can be sent at any hour.
const tz = "America/New_York";
await sql(`insert into public.accountability_settings (counselor_id, timezone, quiet_hours_start, quiet_hours_end) values ('${c.id}', '${tz}', null, null)`);
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + 86_400_000));
await sql(`update public.deliverables set due_date = '${tomorrow}' where id in ('${task}', '${visibleOne.body.id}')`);
const disp = await fetch(`${API}/communication/internal/dispatch`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
const dispBody = await disp.json().catch(() => ({}));
check("the dispatch cron ran the reminders", disp.status === 200 && dispBody.reminders?.ran === true, JSON.stringify(dispBody));
check("the visible task due tomorrow was reminded", Number(await sql(`select count(*) from public.message_deliveries where deliverable_id = '${visibleOne.body.id}' and template like 'task-due-reminder:%'`)) >= 1);
check("no reminder is recorded for the hidden task", Number(await sql(`select count(*) from public.message_deliveries where deliverable_id = '${task}'`)) === 0);

// Sharing is one-way and sets up what creation would have.
const hiddenAgain = await call(c.token, "PATCH", `/tasks/${visibleOne.body.id}`, { visibleToStudent: false });
check("a task the student can see can't be hidden again (409)", hiddenAgain.status === 409, `status ${hiddenAgain.status}`);
check("…and the row is unchanged", (await sql(`select visible_to_student from public.deliverables where id = '${visibleOne.body.id}'`)) === "t");
const noopHide = await call(c.token, "PATCH", `/tasks/${made.body.id}`, { visibleToStudent: false });
check("hiding an already hidden task is a no-op", noopHide.status === 200 && noopHide.body.visibleToStudent === false, `status ${noopHide.status}`);
const mirrored = (id) => sql(`select count(*) from public.deadlines where student_id = '${s.id}' and title like 'HIDDEN-CREATED%'`);
const bells = () => sql(`select count(*) from public.notifications where recipient_id = '${s.id}' and title like '%HIDDEN-CREATED%'`);
check("a task created hidden has no deadlines and no student notification", Number(await mirrored()) === 0 && Number(await bells()) === 0);
const shareMade = await call(c.token, "PATCH", `/tasks/${made.body.id}`, { visibleToStudent: true });
check("sharing it mirrors the deadline and tells the student", shareMade.status === 200 && Number(await mirrored()) === 1 && Number(await bells()) === 1, `status ${shareMade.status}`);
check("the share response is read after the mirror", shareMade.body.stages?.[0]?.deadlineId != null && shareMade.body.notification != null);

const share = await call(c.token, "PATCH", `/tasks/${task}`, { visibleToStudent: true });
check("the counselor can share it", share.status === 200);
const after = await rest(s.token, "GET", `/rest/v1/deliverables?select=id&id=eq.${task}`);
check("then the student sees it", (after.body ?? []).length === 1);
check("existing tasks default to visible", (await sql(`select count(*) from public.deliverables where visible_to_student = false and title not like 'HIDDEN-%' and title <> 'FLAG-HIDDEN'
  and id::text not in (select accepted_as->>'id' from public.recommendations where accepted_as is not null)`)) === "0");

const run = await sql(`with r as (insert into public.research_runs (student_id, counselor_id, feature, inputs_hash, brief, status, created_by, expires_at)
  values ('${s.id}', '${c.id}', 'activities', 'h', '{}'::jsonb, 'succeeded', '${c.id}', now() + interval '7 days') returning id) select id from r`);
await sql(`insert into public.recommendations (run_id, student_id, feature, title, why, sources)
  values ('${run}', '${s.id}', 'activities', 'REC-MARKER', 'fits', '[]'::jsonb)`);
check("the counselor sees the recommendation", ((await rest(c.token, "GET", `/rest/v1/recommendations?select=title&student_id=eq.${s.id}`)).body ?? []).length === 1);
check("the student can't", ((await rest(s.token, "GET", `/rest/v1/recommendations?select=title&student_id=eq.${s.id}`)).body ?? []).length === 0);
const owner = await user("res-owner");
const other = await user("res-other");
await firmWith(owner, [c, other]);
check("a same-firm counselor without access can't", ((await rest(other.token, "GET", `/rest/v1/recommendations?select=title&student_id=eq.${s.id}`)).body ?? []).length === 0);
const ins = await rest(c.token, "POST", "/rest/v1/recommendations", { run_id: run, student_id: s.id, feature: "activities", title: "X", why: "y", sources: [] });
check("the browser can't write recommendations", ins.status >= 400);
const insRun = await rest(c.token, "POST", "/rest/v1/research_runs", { student_id: s.id, counselor_id: c.id, feature: "activities", inputs_hash: "h", brief: {}, status: "succeeded", expires_at: new Date().toISOString() });
check("the browser can't write research runs", insRun.status >= 400);
check("the blocklist is seeded", Number(await sql(`select count(*) from public.research_blocked_domains`)) >= 5);
check("the blocklist is closed to the browser", (await rest(c.token, "GET", "/rest/v1/research_blocked_domains?select=domain")).status >= 400);
