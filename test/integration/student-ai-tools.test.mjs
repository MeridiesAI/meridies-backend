// Students use the consultant AI tools (Build College Lists, Narrative Coherence, Activities Build, the scholarship
// Ask box) only when their counselor's practice has switched "Let students use AI tools" on (20261111000001). Needs
// the API as ci.yml starts it (no ANTHROPIC_API_KEY: a tool call that passes every gate stops before the model).
import { call, check, rest, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const flag = (r) => r.body?.enabled;
const tools = async (who) => flag(await call(who.token, "GET", "/me/ai-tools"));

// ---- S0: the switch ----

// A solo counselor: off by default, on when they say so, and the student can read the answer but not set it.
{
  const c = await user("sat-solo");
  const s = await studentOf(c, "sat-solo-s");

  let r = await call(s.token, "GET", "/me/ai-tools");
  check("a student's AI tools read off by default", r.status === 200 && r.body?.enabled === false, `${r.status} ${JSON.stringify(r.body)}`);

  r = await call(c.token, "GET", "/settings/privacy");
  check("the counselor's settings carry studentAiTools, off", r.status === 200 && r.body?.studentAiTools === false && r.body?.canEdit === true, `${r.status} ${JSON.stringify(r.body)}`);

  r = await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: "yes" });
  check("a non-boolean switch is a 400", r.status === 400, `${r.status}`);

  r = await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: true });
  check("the counselor turns it on", r.status === 200 && r.body?.studentAiTools === true, `${r.status} ${JSON.stringify(r.body)}`);
  check("the other switches are untouched", r.body?.aiSummaries === true && r.body?.autoParseDocuments === true);
  check("their student now reads it on", (await tools(s)) === true);

  r = await call(c.token, "GET", "/me/ai-tools");
  check("a counselor has no student-tools answer to read (403)", r.status === 403, `${r.status}`);

  // A student can't read the practice's row, or write the switch through PostgREST.
  r = await rest(s.token, "GET", "/rest/v1/practice_settings?select=*");
  check("a student reads no practice settings row", r.status === 200 && Array.isArray(r.body) && r.body.length === 0, `${r.status} ${JSON.stringify(r.body)}`);
  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: false });
  await rest(s.token, "PATCH", `/rest/v1/practice_settings?counselor_id=eq.${c.id}`, { student_ai_tools: true }, { Prefer: "return=representation" });
  check("a student can't turn it on for themselves", (await sql(`select student_ai_tools from public.practice_settings where counselor_id = '${c.id}'`)) === "f");
  check("…and reads off", (await tools(s)) === false);
}

// A firm: only an owner or admin changes it; it applies to every consultant's students.
{
  const owner = await user("sat-firm-owner");
  const member = await user("sat-firm-member");
  await firmWith(owner, [member]);
  const ownersStudent = await studentOf(owner, "sat-firm-os");
  const membersStudent = await studentOf(member, "sat-firm-ms");

  let r = await call(member.token, "PATCH", "/settings/privacy", { studentAiTools: true });
  check("a firm member who isn't an admin can't change it", r.status === 403, `${r.status}`);
  check("and nothing turned on for the firm", (await tools(membersStudent)) === false && (await tools(ownersStudent)) === false);

  r = await call(owner.token, "PATCH", "/settings/privacy", { studentAiTools: true });
  check("the firm owner turns it on", r.status === 200 && r.body?.studentAiTools === true, `${r.status}`);
  check("it applies to the member's student too", (await tools(membersStudent)) === true && (await tools(ownersStudent)) === true);

  r = await call(member.token, "GET", "/settings/privacy");
  check("the member reads the firm's answer, can't edit it", r.status === 200 && r.body?.studentAiTools === true && r.body?.canEdit === false, `${r.status} ${JSON.stringify(r.body)}`);
}

// Fail closed: a student whose counselor isn't approved (or who has no counselor) gets off.
{
  const c = await user("sat-pending");
  const s = await studentOf(c, "sat-pending-s");
  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: true });
  check("on, for an approved counselor's student", (await tools(s)) === true);
  await sql(`update public.profiles set counselor_approved_at = null where id = '${c.id}'`);
  check("an unapproved counselor's student reads off", (await tools(s)) === false);

  const loner = await user("sat-no-counselor", "student");
  check("a student with no counselor reads off", (await tools(loner)) === false);
}

// ---- S1: Build College Lists ----

const collegeId = (slug) => sql(`select id from public.colleges where slug = '${slug}'`);
const listRows = (studentId) =>
  sql(`select coalesce(json_agg(json_build_object('college', c.slug, 'status', sc.status, 'addedByStudent', sc.added_by = sc.student_id, 'fit', sc.fit) order by c.slug), '[]'::json)
       from public.student_colleges sc join public.colleges c on c.id = sc.college_id where sc.student_id = '${studentId}'`).then(JSON.parse);
const CRITERIA = { majors: [], sizes: [], settings: [], testOptional: null, miles: 500, origin: null, aid: "No preference", diversity: "No preference" };

{
  const c = await user("sat-bl-c");
  const s = await studentOf(c, "sat-bl-s");
  const other = await studentOf(c, "sat-bl-o");
  const caltech = await collegeId("caltech"); // 2.7% admitted: a reach for anyone
  const ithaca = await collegeId("ithaca-college"); // 80% admitted; no scores on file, so read at the published rate: a safety
  const builderCalls = () => [
    ["schools", call(s.token, "GET", "/colleges/list-builder/schools")],
    ["defaults", call(s.token, "GET", `/colleges/list-builder/defaults?studentId=${s.id}`)],
    ["build", call(s.token, "POST", "/colleges/list-builder", { studentId: s.id, criteria: CRITERIA })],
    ["add", call(s.token, "POST", "/colleges/list-builder/add", { collegeIds: [ithaca] })],
    ["chat", call(s.token, "POST", "/ai/college-list-chat", { studentId: s.id, criteria: CRITERIA, view: { perTier: 4, offset: 0, exclude: [] }, message: "closer to home" })],
  ];

  // Off: every part of it is closed to the student.
  for (const [name, p] of builderCalls()) {
    const r = await p;
    check(`switch off: ${name} is refused for a student`, r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  check("switch off: nothing landed on their list", (await listRows(s.id)).length === 0);

  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: true });

  // On: the reads work, for the student themself only.
  let r = await call(s.token, "GET", "/colleges/list-builder/schools");
  check("on: the builder's schools load for a student", r.status === 200 && Array.isArray(r.body) && r.body.length >= 30, `${r.status}`);
  r = await call(s.token, "GET", `/colleges/list-builder/defaults?studentId=${s.id}`);
  check("on: their own defaults load", r.status === 200 && r.body?.criteria && r.body?.student?.id === s.id, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  r = await call(s.token, "POST", "/colleges/list-builder", { studentId: s.id, criteria: CRITERIA });
  check("on: they can build a list", r.status === 200 && r.body?.tiers?.length === 3 && r.body.tiers.some((t) => t.schools.length > 0), `${r.status}`);
  check("on: the builder names no one else", r.body?.student?.id === s.id);
  r = await call(s.token, "POST", "/colleges/list-builder", { studentId: other.id, criteria: CRITERIA });
  check("on: another student's list is refused", r.status === 403, `${r.status}`);
  r = await call(s.token, "GET", `/colleges/list-builder/defaults?studentId=${other.id}`);
  check("on: another student's defaults are refused", r.status === 403, `${r.status}`);
  r = await call(s.token, "POST", "/ai/college-list-chat", { studentId: s.id, criteria: CRITERIA, view: { perTier: 4, offset: 0, exclude: [] }, message: "closer to home" });
  check("on: the chat passes the gates (it stops at the model, which this stack doesn't have)", r.status !== 403 && r.status !== 401, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  r = await call(s.token, "POST", "/ai/college-list-chat", { studentId: other.id, criteria: CRITERIA, view: { perTier: 4, offset: 0, exclude: [] }, message: "closer to home" });
  check("on: the chat refuses another student", r.status === 403, `${r.status}`);

  // Adding: Interested, added by the student, tagged by the server.
  r = await call(s.token, "POST", "/colleges/list-builder/add", { collegeIds: [ithaca, caltech] });
  check("add: two schools", r.status === 200 && r.body?.added?.length === 2 && r.body?.skipped?.length === 0, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  let rows = await listRows(s.id);
  check("add: they are on the list as Interested (not-started), added by the student", rows.length === 2 && rows.every((x) => x.status === "not-started" && x.addedByStudent === true), JSON.stringify(rows));
  const fit = (slug) => rows.find((x) => x.college === slug)?.fit;
  check("add: a 2.7% school is tagged a reach, whatever the student", fit("caltech") === "reach", String(fit("caltech")));
  check("add: an 80% school with no scores on file is tagged a safety", fit("ithaca-college") === "likely", String(fit("ithaca-college")));
  check("add: the answer carries the tags the server chose", r.body?.added?.find((x) => x.collegeId === caltech)?.fit === "reach");

  r = await call(s.token, "POST", "/colleges/list-builder/add", { collegeIds: [ithaca, caltech] });
  check("add again: both are skipped as already on the list", r.status === 200 && r.body?.added?.length === 0 && r.body?.skipped?.length === 2 && r.body.skipped.every((x) => x.reason === "already-on-list"), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  check("add again: no duplicate rows", (await listRows(s.id)).length === 2);

  r = await call(s.token, "POST", "/colleges/list-builder/add", { collegeIds: ["00000000-0000-4000-8000-000000000000"] });
  check("add: a school that isn't in the catalog is skipped, not an error", r.status === 200 && r.body?.skipped?.[0]?.reason === "not-found", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

  // The student can't choose the tag, the stage or whose list it is.
  const stu = await collegeId("stanford");
  for (const [label, body] of [
    ["a fit", { collegeIds: [stu], fit: "likely" }],
    ["a stage", { collegeIds: [stu], stage: "applied" }],
    ["a student id", { collegeIds: [stu], studentId: other.id }],
    ["no schools", { collegeIds: [] }],
    ["37 schools", { collegeIds: Array.from({ length: 37 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }],
    ["a non-uuid", { collegeIds: ["stanford"] }],
  ]) {
    r = await call(s.token, "POST", "/colleges/list-builder/add", body);
    check(`add refuses ${label} (400)`, r.status === 400, `${r.status}`);
  }
  check("none of those added a school", (await listRows(s.id)).length === 2);

  rows = await listRows(s.id);
  const row = await sql(`select id from public.student_colleges where student_id = '${s.id}' and college_id = '${ithaca}'`);
  r = await call(s.token, "PATCH", `/application/college-list/${row}`, { fit: "reach" });
  const after = await listRows(s.id);
  check("a student still can't change a tag afterwards", after.find((x) => x.college === "ithaca-college")?.fit === "likely", `${r.status}`);

  r = await call(c.token, "POST", "/colleges/list-builder/add", { collegeIds: [stu] });
  check("a counselor can't use the student add (403)", r.status === 403, `${r.status}`);

  // The counselor reads the same list.
  r = await call(c.token, "GET", `/application/college-list?studentId=${s.id}`);
  const seen = (r.body?.rows ?? []).map((x) => `${x.name}|${x.stage}|${x.fit}`);
  check("the counselor sees both under Interested with their tags", r.status === 200 && seen.some((x) => /Caltech|California Institute/i.test(x) && /interested\|reach$/.test(x)) && seen.some((x) => /Ithaca/i.test(x) && /interested\|likely$/.test(x)), JSON.stringify(seen));

  // Turning it off closes the add again; what is already on the list stays.
  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: false });
  r = await call(s.token, "POST", "/colleges/list-builder/add", { collegeIds: [stu] });
  check("off again: the add is refused", r.status === 403, `${r.status}`);
  check("off again: the list is as it was", (await listRows(s.id)).length === 2);
}

// ---- S2: scholarships (Track, More info, Apply now; the Ask box is the only AI part) ----
{
  const c = await user("sat-sch-c");
  const s = await studentOf(c, "sat-sch-s");
  const other = await studentOf(c, "sat-sch-o");
  const trackedStatus = (id) => sql(`select status from public.scholarship_matches where student_id = '${s.id}' and scholarship_id = '${id}'`);

  // Off (the default): the scan and Track are the student's own and need no AI; the Ask box does.
  let r = await call(s.token, "GET", `/student-aid/${s.id}/scholarships/scan`);
  const scan = r.body;
  const all = [...(scan?.matches ?? []), ...(scan?.held ?? [])];
  check("off: a student's scholarship scan works", r.status === 200 && Array.isArray(scan?.matches), `${r.status}`);
  check("every scholarship in the scan carries an applyUrl (a link, or null when the catalog has no separate one)", all.length > 0 && all.every((m) => "applyUrl" in m && (m.applyUrl === null || /^https?:\/\//.test(m.applyUrl))), `${all.length} scholarships`);
  check("…and still its url and sourceUrl, as before", all.every((m) => "url" in m && "sourceUrl" in m));

  const pick = (scan?.matches ?? [])[0] ?? (scan?.held ?? [])[0];
  r = await call(s.token, "PUT", `/student-aid/${s.id}/scholarships/${pick?.id}/recommend`, { recommended: true });
  check("off: Track (the recommend call) works for a student with the switch off", r.status === 200 && r.body?.recommended === true, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  check("…and lands on their tracker as To apply (saved)", (await trackedStatus(pick?.id)) === "saved");
  r = await call(c.token, "GET", `/aid/scholarships?studentId=${s.id}`);
  check("the counselor sees the tracked scholarship", r.status === 200 && JSON.stringify(r.body).includes(pick?.name ?? "\u0000"), `${r.status}`);

  const ask = (who, id) => call(who.token, "POST", `/student-aid/${id}/scholarships/ask`, { question: "anything for engineering students" });
  r = await ask(s, s.id);
  check("off: the Ask box is closed (403: the practice hasn't turned on AI tools)", r.status === 403 && /turned on AI tools/.test(JSON.stringify(r.body)), `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: true });
  r = await ask(s, s.id);
  check("on: the Ask box passes the gates (it stops at the model, which this stack doesn't have)", r.status !== 403 && r.status !== 401, `${r.status}`);
  r = await ask(s, other.id);
  check("on: asking about another student is refused", r.status === 403, `${r.status}`);

  // Un-track: still the student's own call.
  r = await call(s.token, "PUT", `/student-aid/${s.id}/scholarships/${pick?.id}/recommend`, { recommended: false });
  check("on: un-tracking works and keeps the row as dismissed", r.status === 200 && (await trackedStatus(pick?.id)) === "dismissed", `${r.status}`);
  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: false });
}

// ---- S3: Narrative Coherence ----
// The model-dependent checks need an API whose model is a local stand-in (FAKE_ANTHROPIC_URL: scratch/fake-anthropic.mjs,
// which also answers /_last?tool=X with the last request it saw); without one they are skipped, the gates and RLS still run.
const FAKE = process.env.FAKE_ANTHROPIC_URL;
const lastPrompt = async (tool) => (await fetch(`${FAKE}/_last?tool=${tool}`)).json();
const modelCalls = async () => (await (await fetch(`${FAKE}/_count`)).json()).calls;
if (!FAKE) console.log("SKIP  Coherence model checks (set FAKE_ANTHROPIC_URL to a stand-in model)");

{
  const c = await user("sat-coh-c");
  const s = await studentOf(c, "sat-coh-s");
  const other = await studentOf(c, "sat-coh-o");
  await sql(`insert into public.activities (student_id, name, organization, position, category, hours_per_week, weeks_per_year, description)
             values ('${s.id}', 'Robotics', 'Lincoln High Robotics', 'Captain', 'Academic', 6, 36, 'Led the build team for two seasons.'),
                    ('${s.id}', 'Tutoring', 'Public Library', 'Tutor', 'Community Service', 2, 30, 'Tutored middle schoolers.')`);
  const body = (id) => ({ studentId: id, statement: false, activities: true, awards: false, supplementEssayIds: [] });
  const reports = (id) => sql(`select count(*) from public.coherence_reports where student_id = '${id}'`);
  const ask = (who, studentId, reportId, question) => call(who.token, "POST", "/application/coherence/ask", { studentId, reportId, question });
  const rid = "00000000-0000-4000-8000-000000000000";

  // Off: nothing of Coherence is open to the student, and nothing is written.
  let r = await call(s.token, "GET", `/application/coherence?studentId=${s.id}`);
  check("off: Coherence is closed to a student (403: the practice hasn't turned on AI tools)", r.status === 403 && /turned on AI tools/.test(JSON.stringify(r.body)), `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  r = await call(s.token, "POST", "/application/coherence", body(s.id));
  check("off: running it is refused before anything is written", r.status === 403 && (await reports(s.id)) === "0", `${r.status}`);
  r = await ask(s, s.id, rid, "what first?");
  check("off: the follow-up chat is refused", r.status === 403, `${r.status}`);
  r = await call(s.token, "PATCH", `/application/coherence/flags/${rid}`, { status: "resolved" });
  check("off: changing a flag is refused", r.status === 403, `${r.status}`);

  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: true });

  r = await call(s.token, "GET", `/application/coherence?studentId=${s.id}`);
  check("on: the student's Coherence page loads, with no report yet", r.status === 200 && r.body?.report === null && r.body?.docs?.activities === 2, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  check("on: no counselor-addressed activity notes for a student", r.body?.alignment === null);
  r = await call(s.token, "GET", `/application/coherence?studentId=${other.id}`);
  check("on: another student's Coherence is refused", r.status === 403, `${r.status}`);
  r = await call(s.token, "POST", "/application/coherence", body(other.id));
  check("on: running it for another student is refused", r.status === 403 && (await reports(other.id)) === "0", `${r.status}`);

  if (FAKE) {
    // The student runs it.
    r = await call(s.token, "POST", "/application/coherence", body(s.id));
    const mine = r.body;
    check("on: the student runs Coherence (201)", r.status === 201 && mine?.ranBy === "student", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check("on: three storyline bullets, the report read the Activities list", mine?.storyline?.length === 3 && mine?.read?.[0] === "Activities list");
    check("on: a flag in the student's own voice is dropped (one of two stays)", mine?.flags?.length === 1 && /robotics team for three years/.test(mine.flags[0].what), JSON.stringify(mine?.flags));
    check("on: the last next step goes to their meeting, not a task assignment", mine?.next?.at(-1) === "Take this report to your next meeting with your counselor.", JSON.stringify(mine?.next));
    const sys = (await lastPrompt("coherence_report"))?.system ?? "";
    check("on: the model was told to speak to the student and never as them", /Address the student directly/.test(sys) && !/counselor/i.test(sys) && /You NEVER write essay prose/.test(sys), sys.slice(0, 120));
    check("on: stored as the student's own report", (await sql(`select count(*) from public.coherence_reports where id = '${mine?.id}' and created_by = student_id`)) === "1");

    r = await call(s.token, "GET", `/application/coherence?studentId=${s.id}`);
    check("on: reopening shows their report", r.status === 200 && r.body?.report?.id === mine?.id && r.body.report.ranBy === "student" && r.body.report.flags.length === 1, `${r.status}`);
    r = await call(other.token, "GET", `/application/coherence?studentId=${other.id}`);
    check("another student sees no report of theirs", r.status === 200 && r.body?.report === null, `${r.status}`);
    r = await call(c.token, "GET", `/application/coherence?studentId=${s.id}`);
    check("the counselor sees the student's report, marked as the student's", r.status === 200 && r.body?.report?.id === mine?.id && r.body.report.ranBy === "student" && r.body.report.flags.length === 1, `${r.status} ${JSON.stringify(r.body?.report).slice(0, 100)}`);

    // The follow-up chat: answered from the report; a request for wording gets questions and no model call.
    const before = await modelCalls();
    r = await ask(s, s.id, mine?.id, "what should I settle first?");
    check("on: the follow-up chat answers from the report", r.status === 200 && r.body?.bullets?.length === 2, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    const askSys = (await lastPrompt("coherence_answer"))?.system ?? "";
    check("on: …told to answer the student, not a counselor", /Answer the student's question/.test(askSys) && !/counselor/i.test(askSys));
    const mid = await modelCalls();
    r = await ask(s, s.id, mine?.id, "please rewrite my first paragraph");
    check("on: a request for wording gets questions about themself and makes no model call", r.status === 200 && r.body?.bullets?.length === 3 && !/counselor/i.test(r.body.bullets.join(" ")) && (await modelCalls()) === mid && mid === before + 1, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    r = await ask(s, s.id, rid, "anything?");
    check("on: a report that isn't theirs is not on file (404)", r.status === 404, `${r.status}`);

    // A flag: resolve it, but only their own report's, and only status and task.
    const flagId = mine?.flags?.[0]?.id;
    r = await call(s.token, "PATCH", `/application/coherence/flags/${flagId}`, { status: "resolved" });
    check("on: the student resolves a flag on their own report", r.status === 200 && r.body?.status === "resolved" && (await sql(`select resolved_by = '${s.id}' from public.narrative_flags where id = '${flagId}'`)) === "t", `${r.status}`);
    r = await call(s.token, "PATCH", `/application/coherence/flags/${flagId}`, { assignedTaskId: rid });
    check("on: a task that isn't theirs can't be linked (400)", r.status === 400, `${r.status}`);

    // The database holds the line even for a hand-made request.
    r = await rest(s.token, "PATCH", `/rest/v1/narrative_flags?id=eq.${flagId}`, { title: "Changed by hand", shared_with_student: true }, { Prefer: "return=representation" });
    check("db: a student can't change a flag's words or share it", (await sql(`select title <> 'Changed by hand' and not shared_with_student from public.narrative_flags where id = '${flagId}'`)) === "t", `${r.status}`);
    r = await rest(s.token, "POST", "/rest/v1/coherence_reports", { student_id: other.id, created_by: s.id, criteria: {}, read_labels: [], storyline: [], next_steps: [] });
    check("db: a student can't write a report onto another student", r.status >= 400 && (await reports(other.id)) === "0", `${r.status}`);

    // The counselor runs it too, exactly as before; the student never sees that one.
    r = await call(c.token, "POST", "/application/coherence", body(s.id));
    const theirs = r.body;
    check("the counselor still runs Coherence (201, marked the counselor's)", r.status === 201 && theirs?.ranBy === "counselor", `${r.status}`);
    check("the counselor's report keeps both flags and the task-assigning next step", theirs?.flags?.length === 2 && /assign each fix as a task/.test(theirs.next.at(-1)), JSON.stringify(theirs?.flags?.length));
    const csys = (await lastPrompt("coherence_report"))?.system ?? "";
    check("the counselor's prompt is still addressed to the counselor", /Address the counselor/.test(csys));
    r = await call(s.token, "GET", `/application/coherence?studentId=${s.id}`);
    check("the student still sees only their own report", r.status === 200 && r.body?.report?.id === mine?.id, `${r.status}`);
    r = await rest(s.token, "GET", `/rest/v1/coherence_reports?student_id=eq.${s.id}&select=id,created_by`);
    check("db: a student reads only the reports they ran", r.status === 200 && r.body?.length === 1 && r.body[0].id === mine?.id, JSON.stringify(r.body));
    r = await rest(s.token, "GET", `/rest/v1/narrative_flags?report_id=eq.${theirs?.id}&select=id`);
    check("db: a student reads no flag of the counselor's report", r.status === 200 && r.body?.length === 0, JSON.stringify(r.body));
    r = await call(c.token, "GET", `/application/coherence?studentId=${s.id}`);
    check("the counselor's Last report is the newest of either", r.body?.report?.id === theirs?.id && r.body.report.ranBy === "counselor");

    // The student can delete the report they ran, and only that one.
    r = await rest(s.token, "DELETE", `/rest/v1/coherence_reports?id=eq.${theirs?.id}`, undefined, { Prefer: "return=representation" });
    check("db: a student can't delete the counselor's report", (await sql(`select count(*) from public.coherence_reports where id = '${theirs?.id}'`)) === "1", `${r.status}`);
    r = await rest(s.token, "DELETE", `/rest/v1/coherence_reports?id=eq.${mine?.id}`, undefined, { Prefer: "return=representation" });
    check("db: a student can delete their own report", (await sql(`select count(*) from public.coherence_reports where id = '${mine?.id}'`)) === "0", `${r.status}`);
  }

  // Off again: closed to the student; the counselor still reads what is there.
  await call(c.token, "PATCH", "/settings/privacy", { studentAiTools: false });
  r = await call(s.token, "GET", `/application/coherence?studentId=${s.id}`);
  check("off again: closed to the student", r.status === 403, `${r.status}`);
  r = await call(c.token, "GET", `/application/coherence?studentId=${s.id}`);
  check("off again: the counselor's Coherence is unchanged", r.status === 200, `${r.status}`);
}

console.log(process.exitCode ? "student-ai-tools: FAILED" : "student-ai-tools: ok");
