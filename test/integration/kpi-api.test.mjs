// Time saved: signup figures API and the meeting "Notes sent" mark.
import { check, call, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("kpi-api");
const g0 = await call(c.token, "GET", "/kpi/baselines");
check("GET baselines with no row: defaults and the prompt", g0.status === 200 && g0.body.needsPrompt === true && g0.body.tasks.college_list.manual === 240, JSON.stringify(g0.body));

const put = await call(c.token, "PUT", "/kpi/baselines", {
  tasks: { college_list: { manual: 300, manualEdited: true }, meeting: { meridies: 5, meridiesEdited: true } },
  hourlyRate: 220, rateEdited: true,
});
check("PUT baselines saves", put.status === 200, JSON.stringify(put.body));
const g1 = await call(c.token, "GET", "/kpi/baselines");
check("edited figures round-trip", g1.body.tasks.college_list.manual === 300 && g1.body.tasks.college_list.manualEdited === true && g1.body.tasks.meeting.meridies === 5 && g1.body.tasks.meeting.meridiesEdited === true, JSON.stringify(g1.body.tasks));
check("untouched figures stay defaults, unedited", g1.body.tasks.family_report.manual === 60 && g1.body.tasks.family_report.manualEdited === false);
check("rate saved and edited", g1.body.hourlyRate === 220 && g1.body.rateEdited === true && g1.body.needsPrompt === false);
const bad = await call(c.token, "PUT", "/kpi/baselines", { tasks: { college_list: { manual: 5000 } } });
check("out-of-range minutes refused", bad.status === 400, `status ${bad.status}`);
const extra = await call(c.token, "PUT", "/kpi/baselines", { tasks: {}, sneaky: 1 });
check("unknown fields refused", extra.status === 400, `status ${extra.status}`);

const d = await user("kpi-api-dismiss");
await call(d.token, "PUT", "/kpi/baselines", { dismissPrompt: true });
const gd = await call(d.token, "GET", "/kpi/baselines");
check("dismissing the prompt hides it and keeps defaults unedited", gd.body.needsPrompt === false && gd.body.rateEdited === false && gd.body.hourlyRate === 150, JSON.stringify(gd.body));

// ---- Notes sent ----------------------------------------------------------------------
const s = await studentOf(c, "kpi-api-student");
const scheduled = await sql(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at) values ('${s.id}', '${c.id}', 'Upcoming', now() + interval '1 day') returning id) select id from m`);
const r0 = await call(c.token, "POST", `/meetings/${scheduled}/notes-sent`);
check("notes-sent on a meeting that isn't held is a 409", r0.status === 409, `status ${r0.status}`);
const held = await sql(`with m as (insert into public.meetings (student_id, counselor_id, title, starts_at, status) values ('${s.id}', '${c.id}', 'Done', now() - interval '1 day', 'held') returning id) select id from m`);
const r1 = await call(c.token, "POST", `/meetings/${held}/notes-sent`);
check("notes-sent marks a held meeting", r1.status === 200 && typeof r1.body.notesSentAt === "string", JSON.stringify(r1.body));
check("...and records a completion", (await sql(`select count(*) from public.kpi_completions where dedupe_key='${held}'`)) === "1");
const collab = await user("kpi-api-collab");
await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${s.id}', '${collab.id}', 'write')`);
const r2 = await call(collab.token, "POST", `/meetings/${held}/notes-sent`);
check("a write collaborator can't mark someone else's meeting", r2.status === 403, `status ${r2.status}`);
const r3 = await call(c.token, "DELETE", `/meetings/${held}/notes-sent`);
check("un-marking clears it", r3.status === 200 && r3.body.notesSentAt === null, JSON.stringify(r3.body));
check("...and removes the completion", (await sql(`select count(*) from public.kpi_completions where dedupe_key='${held}'`)) === "0");

// ---- A pending counselor fills these in during signup ------------------------------
const pend = await user("kpi-api-pending", "counselor", { approved: false });
const pp = await call(pend.token, "PUT", "/kpi/baselines", { hourlyRate: 175, rateEdited: true });
check("a pending counselor can save their own signup figures", pp.status === 200 && pp.body.hourlyRate === 175, `status ${pp.status} ${JSON.stringify(pp.body).slice(0, 120)}`);
const pg = await call(pend.token, "GET", "/kpi/baselines");
check("...and read them back", pg.status === 200 && pg.body.hourlyRate === 175, `status ${pg.status}`);
const ph = await call(pend.token, "GET", "/kpi/report");
check("...but nothing else in Time saved", ph.status === 403, `status ${ph.status}`);
