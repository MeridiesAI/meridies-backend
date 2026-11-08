// School-specific scholarships (20261111000006): a counselor types in a school's own award; their practice and
// their students see it, nobody else does. Never curated by Meridies: a counselor's row is unverified until an
// editor (service role) stamps source_verified_at. Real accounts on a local Supabase against a running API
// (see harness.mjs).
import { call, check, rest, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const stanford = await sql(`select id from colleges where slug = 'stanford' limit 1`);
const mit = await sql(`select id from colleges where slug = 'mit' limit 1`);
check("the catalog has Stanford and MIT", Boolean(stanford && mit), `${stanford} ${mit}`);

// Practice 1: a firm (owner A, colleague A2). Practice 2: a solo counselor B. Each has a student with Stanford listed.
const A = await user("sch-a");
const A2 = await user("sch-a2");
const B = await user("sch-b");
const firm = await firmWith(A, [A2]);
const SA = await studentOf(A, "sch-sa");
const SA2 = await studentOf(A2, "sch-sa2");
const SB = await studentOf(B, "sch-sb");
for (const s of [SA, SA2, SB]) {
  await sql(`insert into student_colleges (student_id, college_id, name) values ('${s.id}', '${stanford}', 'Stanford University')`);
}

const tag = Date.now();
const deadline = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
const body = (extra = {}) => ({
  name: `Stanford Knight-Hennessy ${tag}`,
  collegeId: stanford,
  amountCents: 500000,
  amountNote: "Full cost of attendance",
  deadline,
  url: "https://knight-hennessy.stanford.edu/",
  eligibility: "Admitted first-years with leadership",
  notes: "Ask the student to start early",
  ...extra,
});

// ---- Create ----------------------------------------------------------------------------------------------------
const created = await call(A.token, "POST", "/scholarships/internal", body());
check("a counselor adds a school's award", created.status === 201, `${created.status} ${JSON.stringify(created.body)}`);
const row = created.body;
check("…as their own, unverified, counselor-sourced", row?.source === "counselor" && row?.ownedBy === "you" && row?.verified === false && row?.collegeId === stanford, JSON.stringify(row));
check("…with the eligibility and notes text kept", row?.eligibility === "Admitted first-years with leadership" && row?.notes === "Ask the student to start early", JSON.stringify(row));
const firmIdOnRow = await sql(`select coalesce(firm_id::text, 'null') from scholarships where id = '${row?.id}'`);
check("the database pins the row to the counselor's firm", firmIdOnRow === firm, firmIdOnRow);

const mitRow = await call(A.token, "POST", "/scholarships/internal", body({ name: `MIT award ${tag}`, collegeId: mit }));
check("a second award at a school the student hasn't listed", mitRow.status === 201, `${mitRow.status}`);

// ---- Validation --------------------------------------------------------------------------------------------------
const empty = await call(A.token, "POST", "/scholarships/internal", body({ name: "   " }));
check("an empty name is refused", empty.status === 400, `${empty.status}`);
const noCollege = await call(A.token, "POST", "/scholarships/internal", body({ collegeId: undefined }));
check("a school is required", noCollege.status === 400, `${noCollege.status}`);
const http = await call(A.token, "POST", "/scholarships/internal", body({ url: "http://example.edu/award" }));
check("an http link is refused (https only)", http.status === 400, `${http.status}`);
const js = await call(A.token, "POST", "/scholarships/internal", body({ url: "javascript:alert(1)" }));
check("a javascript: link is refused", js.status === 400, `${js.status}`);
const long = await call(A.token, "POST", "/scholarships/internal", body({ notes: "x".repeat(2001) }));
check("an over-long note is refused", long.status === 400, `${long.status}`);
const forged = await call(A.token, "POST", "/scholarships/internal", body({ source: "catalog" }));
check("the API takes no source from the client", forged.status === 400, `${forged.status}`);
const ghost = await call(A.token, "POST", "/scholarships/internal", body({ collegeId: "00000000-0000-4000-8000-000000000000" }));
check("an unknown school is refused", ghost.status === 400 || ghost.status === 404, `${ghost.status}`);

// ---- Students and their counselors -------------------------------------------------------------------------------
const scan = (token, student) => call(token, "GET", `/student-aid/${student.id}/scholarships/scan`);
const has = (r, id) => [...(r.body?.matches ?? []), ...(r.body?.held ?? [])].some((m) => m.id === id);

const saScan = await scan(SA.token, SA);
check("the counselor's student sees the award for a school on their list", saScan.status === 200 && has(saScan, row.id), `${saScan.status} ${JSON.stringify(saScan.body?.matches?.map((m) => m.name))}`);
const hit = saScan.body?.matches?.find((m) => m.id === row.id);
check("…matched on 'school', unverified", hit?.matchedOn === "school" && hit?.verified === false && hit?.source === "counselor", JSON.stringify(hit));
check("…and not the award for a school they haven't listed", !has(saScan, mitRow.body.id));

const sa2Scan = await scan(SA2.token, SA2);
check("a firm colleague's student sees it too (firm sharing)", has(sa2Scan, row.id), JSON.stringify(sa2Scan.body?.matches?.map((m) => m.name)));
const sbScan = await scan(SB.token, SB);
check("another practice's student, same school listed, never sees it", sbScan.status === 200 && !has(sbScan, row.id));
const bOnOwn = await scan(B.token, SB);
check("…nor does their counselor reading that student's scan", bOnOwn.status === 200 && !has(bOnOwn, row.id));
const aOnOwn = await scan(A.token, SA);
check("the owner reading their student's scan sees it", has(aOnOwn, row.id));

// A collaborator from another practice on A's student. The API's view check reads the student's profile, which a
// collaborator can't today, so the scan answers 404 (no leak). The scan's own rule takes the student's practice from
// scholarship_practice, which names A's practice to the collaborator (so B's own rows would be filtered out; the
// unit tests hold that rule) and nothing to a counselor with no tie to the student.
const bRow = await call(B.token, "POST", "/scholarships/internal", body({ name: `B's Stanford award ${tag}` }));
check("B adds their own Stanford award", bRow.status === 201, `${bRow.status}`);
await sql(`insert into student_collaborators (student_id, counselor_id) values ('${SA.id}', '${B.id}') on conflict do nothing`);
const collab = await scan(B.token, SA);
check("a collaborator from another practice gets no school row of A's on A's student", collab.status === 404 || (collab.status === 200 && !has(collab, row.id) && !has(collab, bRow.body.id)), `${collab.status}`);
const practiceForB = await rest(B.token, "POST", "/rest/v1/rpc/scholarship_practice", { p_student: SA.id });
check("scholarship_practice names the student's practice to a collaborator", practiceForB.body?.counselorId === A.id && practiceForB.body?.firmId === firm, JSON.stringify(practiceForB.body));
await sql(`delete from student_collaborators where student_id = '${SA.id}' and counselor_id = '${B.id}'`);
const practiceAfter = await rest(B.token, "POST", "/rest/v1/rpc/scholarship_practice", { p_student: SA.id });
check("…and nothing once the tie is gone", practiceAfter.status === 200 && practiceAfter.body === null, `${practiceAfter.status} ${JSON.stringify(practiceAfter.body)}`);
const practiceForSA = await rest(SA.token, "POST", "/rest/v1/rpc/scholarship_practice", { p_student: SA.id });
check("…and the student's own to the student", practiceForSA.body?.counselorId === A.id, JSON.stringify(practiceForSA.body));

// ---- PostgREST directly (RLS is the backstop) --------------------------------------------------------------------
const read = async (token, id) => (await rest(token, "GET", `/rest/v1/scholarships?id=eq.${id}&select=id`)).body;
check("B cannot read A's row through PostgREST", Array.isArray(await read(B.token, row.id)) && (await read(B.token, row.id)).length === 0);
check("B's student cannot read A's row through PostgREST", (await read(SB.token, row.id)).length === 0);
check("A's student can (their counselor's row)", (await read(SA.token, row.id)).length === 1);
check("A's colleague can (the firm's row)", (await read(A2.token, row.id)).length === 1);

const bPatch = await rest(B.token, "PATCH", `/rest/v1/scholarships?id=eq.${row.id}`, { name: "hijacked" }, { Prefer: "return=representation" });
check("B cannot change A's row through PostgREST", Array.isArray(bPatch.body) && bPatch.body.length === 0, JSON.stringify(bPatch.body));
const a2Patch = await rest(A2.token, "PATCH", `/rest/v1/scholarships?id=eq.${row.id}`, { name: "colleague edit" }, { Prefer: "return=representation" });
check("…nor can A's colleague (owner-only writes)", Array.isArray(a2Patch.body) && a2Patch.body.length === 0, JSON.stringify(a2Patch.body));
const saPatch = await rest(SA.token, "PATCH", `/rest/v1/scholarships?id=eq.${row.id}`, { name: "student edit" }, { Prefer: "return=representation" });
check("…nor can A's student", Array.isArray(saPatch.body) && saPatch.body.length === 0, JSON.stringify(saPatch.body));
const del = await rest(A.token, "DELETE", `/rest/v1/scholarships?id=eq.${row.id}`);
check("nobody hard-deletes through PostgREST, the owner included", del.status === 401 || del.status === 403, `${del.status}`);

const forge = await rest(A.token, "POST", "/rest/v1/scholarships", { name: `Forged ${tag}`, college_id: stanford, owner_counselor_id: A.id, source: "catalog" });
check("a client can't write a 'catalog' row", forge.status >= 400, `${forge.status} ${JSON.stringify(forge.body)}`);
const forgeOwner = await rest(A.token, "POST", "/rest/v1/scholarships", { name: `Forged ${tag}`, college_id: stanford, owner_counselor_id: B.id, source: "counselor" });
check("…nor one owned by someone else", forgeOwner.status >= 400, `${forgeOwner.status}`);
const forgeVerified = await rest(A.token, "POST", "/rest/v1/scholarships", { name: `Forged ${tag}`, college_id: stanford, owner_counselor_id: A.id, source: "counselor", source_verified_at: new Date().toISOString() });
check("…nor one already verified", forgeVerified.status >= 400, `${forgeVerified.status}`);
const forgeNoCollege = await rest(A.token, "POST", "/rest/v1/scholarships", { name: `Forged ${tag}`, owner_counselor_id: A.id, source: "counselor" });
check("…nor a counselor row without a school (the CHECK)", forgeNoCollege.status >= 400, `${forgeNoCollege.status}`);
const forgeHttp = await rest(A.token, "POST", "/rest/v1/scholarships", { name: `Forged ${tag}`, college_id: stanford, owner_counselor_id: A.id, source: "counselor", url: "http://example.edu" });
check("…nor an http link (the CHECK)", forgeHttp.status >= 400, `${forgeHttp.status}`);
const forgeFirm = await rest(B.token, "POST", "/rest/v1/scholarships", { name: `Forged firm ${tag}`, college_id: stanford, owner_counselor_id: B.id, source: "counselor", firm_id: firm }, { Prefer: "return=representation" });
check("a counselor can't file a row into another practice's firm", forgeFirm.status >= 400, `${forgeFirm.status} ${JSON.stringify(forgeFirm.body)}`);
const studentInsert = await rest(SA.token, "POST", "/rest/v1/scholarships", { name: `Student ${tag}`, college_id: stanford, owner_counselor_id: SA.id, source: "counselor" });
check("a student can't add one", studentInsert.status >= 400, `${studentInsert.status}`);
const catalogEdit = await rest(A.token, "PATCH", `/rest/v1/scholarships?owner_counselor_id=is.null&limit=1`, { name: "renamed" }, { Prefer: "return=representation" });
check("catalog rows stay service-role only", Array.isArray(catalogEdit.body) ? catalogEdit.body.length === 0 : catalogEdit.status >= 400, `${catalogEdit.status} ${JSON.stringify(catalogEdit.body).slice(0, 120)}`);

// ---- Update ------------------------------------------------------------------------------------------------------
const patched = await call(A.token, "PATCH", `/scholarships/internal/${row.id}`, { amountCents: 750000, notes: "Updated" });
check("the owner edits their row", patched.status === 200 && patched.body?.amountCents === 750000 && patched.body?.notes === "Updated", `${patched.status} ${JSON.stringify(patched.body)}`);
const verifyAttempt = await call(A.token, "PATCH", `/scholarships/internal/${row.id}`, { sourceVerifiedAt: new Date().toISOString() });
check("a client can't mark it verified", verifyAttempt.status === 400, `${verifyAttempt.status}`);
const restVerify = await rest(A.token, "PATCH", `/rest/v1/scholarships?id=eq.${row.id}`, { source_verified_at: new Date().toISOString() });
check("…not through PostgREST either", restVerify.status >= 400, `${restVerify.status}`);
const restSource = await rest(A.token, "PATCH", `/rest/v1/scholarships?id=eq.${row.id}`, { source: "catalog" });
check("…and can't turn it into a catalog row", restSource.status >= 400, `${restSource.status}`);
const bApi = await call(B.token, "PATCH", `/scholarships/internal/${row.id}`, { name: "hijacked" });
check("another practice's counselor gets a 404 through the API", bApi.status === 404, `${bApi.status}`);
const a2Api = await call(A2.token, "PATCH", `/scholarships/internal/${row.id}`, { name: "colleague" });
check("…and so does a firm colleague (owner-only)", a2Api.status === 404, `${a2Api.status}`);
const badUrl = await call(A.token, "PATCH", `/scholarships/internal/${row.id}`, { url: "http://insecure.example.edu" });
check("an http link is refused on edit too", badUrl.status === 400, `${badUrl.status}`);
const stName = await sql(`select name from scholarships where id = '${row.id}'`);
check("nothing above changed the name", stName === `Stanford Knight-Hennessy ${tag}`, stName);

// An editor verifies (service role), then the owner's edit clears it: the stamp named what the editor checked.
await sql(`update scholarships set source_verified_at = now() where id = '${row.id}'`);
const verifiedList = await call(A.token, "GET", `/colleges/${stanford}/scholarships`);
check("an editor's stamp reads verified", verifiedList.body?.scholarships?.find((x) => x.id === row.id)?.verified === true, JSON.stringify(verifiedList.body).slice(0, 300));
await call(A.token, "PATCH", `/scholarships/internal/${row.id}`, { amountNote: "Changed after the check" });
const clearedAt = await sql(`select coalesce(source_verified_at::text, 'null') from scholarships where id = '${row.id}'`);
check("the owner's edit after verification clears the stamp", clearedAt === "null", clearedAt);

// ---- College list ------------------------------------------------------------------------------------------------
const listA = await call(A.token, "GET", `/colleges/${stanford}/scholarships`);
const mine = listA.body?.scholarships?.find((x) => x.id === row.id);
check("GET /colleges/:id/scholarships lists the owner's row as theirs", listA.status === 200 && mine?.ownedBy === "you" && mine?.source === "counselor", `${listA.status} ${JSON.stringify(mine)}`);
check("…and not B's", !listA.body?.scholarships?.some((x) => x.id === bRow.body.id));
const listA2 = await call(A2.token, "GET", `/colleges/${stanford}/scholarships`);
check("a firm colleague sees it as the firm's", listA2.body?.scholarships?.find((x) => x.id === row.id)?.ownedBy === "firm", JSON.stringify(listA2.body).slice(0, 300));
const listB = await call(B.token, "GET", `/colleges/${stanford}/scholarships`);
check("another practice's counselor doesn't see it", listB.status === 200 && !listB.body?.scholarships?.some((x) => x.id === row.id) && listB.body?.scholarships?.some((x) => x.id === bRow.body.id));
const listMit = await call(A.token, "GET", `/colleges/${mit}/scholarships`);
check("per college: MIT lists the MIT row only", listMit.body?.scholarships?.length === 1 && listMit.body.scholarships[0].id === mitRow.body.id, JSON.stringify(listMit.body).slice(0, 300));
const listStudent = await call(SA.token, "GET", `/colleges/${stanford}/scholarships`);
check("the college list is a counselor's route", listStudent.status === 403, `${listStudent.status}`);

// ---- Delete (soft) -----------------------------------------------------------------------------------------------
const bDel = await call(B.token, "DELETE", `/scholarships/internal/${row.id}`);
check("another practice can't remove it", bDel.status === 404, `${bDel.status}`);
const aDel = await call(A.token, "DELETE", `/scholarships/internal/${row.id}`);
check("the owner removes it", aDel.status === 200 && aDel.body?.removed === true, `${aDel.status} ${JSON.stringify(aDel.body)}`);
const active = await sql(`select is_active from scholarships where id = '${row.id}'`);
check("…softly (is_active false, the row kept)", active === "f", active);
const afterDel = await scan(SA.token, SA);
check("the student no longer sees it", !has(afterDel, row.id));
const revive = await rest(A.token, "PATCH", `/rest/v1/scholarships?id=eq.${row.id}`, { is_active: true });
check("a removed row can't be brought back through PostgREST (the cap)", revive.status >= 400, `${revive.status}`);
const othersRemoved = await rest(B.token, "GET", `/rest/v1/scholarships?id=eq.${row.id}&select=id`);
check("a removed row stays invisible to everyone but its owner", Array.isArray(othersRemoved.body) && othersRemoved.body.length === 0);
const again = await call(A.token, "DELETE", `/scholarships/internal/${row.id}`);
check("removing it twice is a 404", again.status === 404, `${again.status}`);

// ---- Cap and rate limit ------------------------------------------------------------------------------------------
const C = await user("sch-cap");
await sql(`insert into scholarships (name, college_id, owner_counselor_id, source)
           select 'Cap ' || g, '${stanford}', '${C.id}', 'counselor' from generate_series(1, 200) g`);
const overCap = await call(C.token, "POST", "/scholarships/internal", body({ name: `One too many ${tag}` }));
check("the 201st active row is refused", overCap.status === 409 && overCap.body?.code === "scholarship_cap", `${overCap.status} ${JSON.stringify(overCap.body)}`);
const overCapRest = await rest(C.token, "POST", "/rest/v1/scholarships", { name: `Rest too many ${tag}`, college_id: stanford, owner_counselor_id: C.id, source: "counselor" });
check("…and through PostgREST too", overCapRest.status >= 400, `${overCapRest.status}`);

const D = await user("sch-rate");
let limited = null;
for (let i = 0; i < 65 && !limited; i++) {
  const r = await call(D.token, "POST", "/scholarships/internal", body({ name: `Rate ${i} ${tag}` }));
  if (r.status === 429) limited = i;
}
check("writes are throttled (60 an hour)", limited === 60, `first 429 at ${limited}`);

// ---- Unapproved counselors ---------------------------------------------------------------------------------------
const P = await user("sch-pending", "counselor", { approved: false });
const pending = await call(P.token, "POST", "/scholarships/internal", body());
check("a pending counselor can't add one", pending.status === 403, `${pending.status}`);
