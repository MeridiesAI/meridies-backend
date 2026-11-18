// Accessibility & Support (20261127000003), as real accounts on a local Supabase against a running API.
//   A, A2  Consultants in different solo practices; Stu is A's student; Peer is another student; X an unapproved Consultant.
//   Needs the API started with ACCESSIBILITY_FAKE=fixture (the research job runs on a canned page, no network or model).
import { call, check, rest, sql, user } from "./harness.mjs";

const A = await user("acc-a");
const A2 = await user("acc-a2");
const Stu = await user("acc-stu", "student");
const Peer = await user("acc-peer", "student");
await sql(`update public.profiles set counselor_id = '${A.id}', full_name = 'Sam Student' where id = '${Stu.id}'`);
const college = (await sql(`select id from public.colleges order by id limit 1`)).trim();
check("the catalog has a college to test against", /^[0-9a-f-]{36}$/.test(college), college);

// ---- Shared record -----------------------------------------------------------------------------------------------
await sql(`delete from public.college_accessibility where college_id = '${college}'`);
const empty = await call(A.token, "GET", `/colleges/${college}/accessibility`);
check("no record yet: null, stale, not researching", empty.status === 200 && empty.body.record === null && empty.body.stale === true && empty.body.researching === false, `${empty.status} ${JSON.stringify(empty.body)}`);
check("a student reads the shared record too", (await call(Stu.token, "GET", `/colleges/${college}/accessibility`)).status === 200);
check("a client can't write the shared table", (await rest(A.token, "POST", "/rest/v1/college_accessibility", { college_id: college, data_source: "consultant" })).status >= 400);

const researched = await call(A.token, "POST", `/colleges/${college}/accessibility/research`, {});
check("research fills the record from the page it read, every field sourced", researched.status === 200 && researched.body.record?.dsEmail === "arc@fixture.example.edu" && researched.body.record.supportLevel === "comprehensive" && researched.body.record.dataSource === "axis", `${researched.status} ${JSON.stringify(researched.body).slice(0, 300)}`);
const srcs = await sql(`select jsonb_object_keys(field_sources) from public.college_accessibility where college_id = '${college}'`);
check("field_sources names every field set", srcs.includes("dsEmail") && srcs.includes("supportLevel"), srcs);
check("research never writes the IPEDS percent", (await sql(`select pct_registered_ds is null and pct_three_or_less = false from public.college_accessibility where college_id = '${college}'`)).trim() === "t");
check("a fresh record isn't researched again unless forced", (await call(A.token, "POST", `/colleges/${college}/accessibility/research`, {})).body.stale === false);
check("a student can't run research", (await call(Stu.token, "POST", `/colleges/${college}/accessibility/research`, {})).status === 403);

// ---- A practice's own edits ----------------------------------------------------------------------------------------
const ov = await call(A.token, "PATCH", `/colleges/${college}/accessibility/override`, { fields: { dsEmail: "ours@example.edu", dsPhone: "", accommodations: ["Our own list"] } });
check("a practice overrides fields without touching the shared row", ov.status === 200 && ov.body.record.dsEmail === "ours@example.edu" && ov.body.record.dsPhone === null && ov.body.overriddenFields.includes("dsEmail"), `${ov.status} ${JSON.stringify(ov.body).slice(0, 300)}`);
check("the shared row is unchanged", (await sql(`select ds_email from public.college_accessibility where college_id = '${college}'`)).trim() === "arc@fixture.example.edu");
check("another practice sees only the shared value", (await call(A2.token, "GET", `/colleges/${college}/accessibility`)).body.record.dsEmail === "arc@fixture.example.edu");
check("a student sees only the shared value", (await call(Stu.token, "GET", `/colleges/${college}/accessibility`)).body.record.dsEmail === "arc@fixture.example.edu");
check("another practice can't read the override table", ((await rest(A2.token, "GET", `/rest/v1/college_accessibility_overrides?college_id=eq.${college}`)).body ?? []).length === 0);
check("or write one for the first practice", (await rest(A2.token, "PATCH", `/rest/v1/college_accessibility_overrides?college_id=eq.${college}`, { fields: { dsEmail: "hijack@example.edu" } })).body?.length !== 1);
check("a student can't read or write the override table", ((await rest(Stu.token, "GET", `/rest/v1/college_accessibility_overrides`)).body ?? []).length === 0 && (await rest(Stu.token, "POST", "/rest/v1/college_accessibility_overrides", { counselor_id: Stu.id, college_id: college, fields: {} })).status >= 400);
const cleared = await call(A.token, "PATCH", `/colleges/${college}/accessibility/override`, { fields: { dsEmail: null, dsPhone: null, accommodations: null } });
check("null clears an override back to the shared value", cleared.body.record.dsEmail === "arc@fixture.example.edu" && cleared.body.overriddenFields.length === 0, JSON.stringify(cleared.body).slice(0, 200));
check("bad fields are refused", (await call(A.token, "PATCH", `/colleges/${college}/accessibility/override`, { fields: { dsEmail: "nope" } })).status === 400 && (await call(A.token, "PATCH", `/colleges/${college}/accessibility/override`, { fields: { dsUrl: "javascript:x" } })).status === 400);

// ---- Compare and the list builder ------------------------------------------------------------------------------------
const cmp = await call(A.token, "GET", `/colleges/compare?ids=${college}`);
check("compare carries the accessibility record per column", cmp.status === 200 && cmp.body[0]?.accessibility?.supportLevel === "comprehensive", `${cmp.status} ${JSON.stringify(cmp.body).slice(0, 200)}`);

// ---- A student's private learning support -------------------------------------------------------------------------------
const put = await call(A.token, "PUT", `/students/${Stu.id}/learning-support`, { needLevel: "enhanced", notes: "Extended time; reads slowly." });
check("a Consultant saves it", put.status === 200 && put.body.needLevel === "enhanced" && put.body.notes.startsWith("Extended"), `${put.status} ${JSON.stringify(put.body)}`);
check("and reads it back", (await call(A.token, "GET", `/students/${Stu.id}/learning-support`)).body.needLevel === "enhanced");
for (const [who, t] of [["the student", Stu.token], ["another student", Peer.token]]) {
  check(`${who} gets 403 from the route`, (await call(t, "GET", `/students/${Stu.id}/learning-support`)).status === 403 && (await call(t, "PUT", `/students/${Stu.id}/learning-support`, { needLevel: "none", notes: "" })).status === 403);
  const rows = await rest(t, "GET", "/rest/v1/student_learning_support");
  check(`${who} gets zero rows straight from the database`, rows.status === 200 && (rows.body ?? []).length === 0, `${rows.status} ${JSON.stringify(rows.body)}`);
  check(`${who} can't write it straight to the database`, (await rest(t, "POST", "/rest/v1/student_learning_support", { student_id: Stu.id, need_level: "none" })).status >= 400);
}
check("another practice's Consultant can't read or write it", [403, 404].includes((await call(A2.token, "GET", `/students/${Stu.id}/learning-support`)).status) && [403, 404].includes((await call(A2.token, "PUT", `/students/${Stu.id}/learning-support`, { needLevel: "none", notes: "" })).status));
check("a Consultant gets zero rows for someone else's student", ((await rest(A2.token, "GET", `/rest/v1/student_learning_support?student_id=eq.${Stu.id}`)).body ?? []).length === 0);
check("the notes are not in the student's own data export", !JSON.stringify((await call(Stu.token, "GET", "/account/export")).body).includes("reads slowly"));
check("an over-long note is refused", (await call(A.token, "PUT", `/students/${Stu.id}/learning-support`, { needLevel: "none", notes: "x".repeat(4001) })).status === 400);
