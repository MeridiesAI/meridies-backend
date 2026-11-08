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

console.log(process.exitCode ? "student-ai-tools: FAILED" : "student-ai-tools: ok");
