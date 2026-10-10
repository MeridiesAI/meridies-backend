// Context layer Task 1: document kinds, AI access, waived letters, student visibility.
import { check, sql, user, rest, call } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("ctx-docs");
const s = await studentOf(c, "ctx-docs-student");
const doc = async (kind, { waived = false, owner = c.id } = {}) =>
  sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind${waived ? ", ferpa_waived" : ""})
       values ('${s.id}', '${owner}', 'x/${kind}-${Date.now()}-${Math.random()}', '${kind}.pdf', '${kind}'${waived ? ", true" : ""}) returning id) select id from d`);

const letter = await doc("recommendation-letter", { waived: true });
const iep = await doc("iep-504");
const only = await doc("counselor-only");
const transcript = await doc("transcript");
check("new kinds are accepted", [letter, iep, only, transcript].every((x) => /^[0-9a-f-]{36}$/.test(x)));

let refused = false;
try { await sql(`update public.documents set ai_access = 'allowed' where id = '${letter}'`); } catch { refused = true; }
check("a waived letter can never be allowed for AI", refused);

const seen = await rest(s.token, "GET", `/rest/v1/documents?select=id&student_id=eq.${s.id}`);
const ids = (seen.body ?? []).map((r) => r.id);
check("the student sees their transcript", ids.includes(transcript));
check("the student can't see a waived letter", !ids.includes(letter));
check("the student can't see an IEP/504 document", !ids.includes(iep));
check("the student can't see a counselor-only document", !ids.includes(only));

const own = await doc("counselor-only", { owner: s.id });
const seen2 = await rest(s.token, "GET", `/rest/v1/documents?select=id&id=eq.${own}`);
check("a student still sees a file they uploaded themselves", (seen2.body ?? []).length === 1);

const cSeen = await rest(c.token, "GET", `/rest/v1/documents?select=id&student_id=eq.${s.id}`);
check("the counselor sees all of them", (cSeen.body ?? []).length >= 4);

const patch = await call(c.token, "PATCH", `/files/documents/${transcript}`, { aiAccess: "excluded" });
check("the counselor can set AI access", patch.status === 200 && patch.body.aiAccess === "excluded", JSON.stringify(patch.body));
const patch2 = await call(c.token, "PATCH", `/files/documents/${letter}`, { aiAccess: "allowed" });
check("the API refuses allowing a waived letter", patch2.status === 400, `status ${patch2.status}`);

// Path 2: the student's "My documents" list (/files/documents).
const list = await call(s.token, "GET", "/files/documents");
const listIds = Array.isArray(list.body) ? list.body.map((r) => r.id) : [];
check("/files: the student's list has their transcript", list.status === 200 && listIds.includes(transcript), `status ${list.status}`);
check("/files: no waived letter, IEP/504 or counselor-only document in the student's list",
  ![letter, iep, only].some((id) => listIds.includes(id)));

// Path 3: Storage signed URLs. Put real objects behind the rows so "refused" can't be "not found".
const attach = async (id) => {
  const path = `${s.id}/ctx-${id}.pdf`;
  const up = await rest(c.token, "POST", `/storage/v1/object/student-documents/${path}`, new Uint8Array([37, 80, 68, 70]), { "Content-Type": "application/pdf" });
  if (up.status !== 200) throw new Error(`counselor upload ${up.status} ${JSON.stringify(up.body)}`);
  await sql(`update public.documents set storage_path = '${path}' where id = '${id}'`);
  return path;
};
const transcriptPath = await attach(transcript);
const letterPath = await attach(letter);
const iepPath = await attach(iep);
const sign = (path) => rest(s.token, "POST", `/storage/v1/object/sign/student-documents/${path}`, { expiresIn: 60 });
const okSign = await sign(transcriptPath);
check("Storage: the student gets a signed URL for their transcript", okSign.status === 200 && !!okSign.body?.signedURL, `status ${okSign.status}`);
const badLetter = await sign(letterPath);
check("Storage: no signed URL for a waived letter", badLetter.status !== 200 && !badLetter.body?.signedURL, `status ${badLetter.status}`);
const badIep = await sign(iepPath);
check("Storage: no signed URL for an IEP/504 document", badIep.status !== 200 && !badIep.body?.signedURL, `status ${badIep.status}`);

// ---- Restricted documents: gaps beyond SELECT -------------------------------------------------
// (a) A waived letter is filed in one call and the student never sees it.
const created = await call(c.token, "POST", "/files/documents", {
  studentId: s.id, storagePath: `${s.id}/one-call-${Date.now()}.pdf`, filename: "one-call-letter.pdf",
  kind: "recommendation-letter", ferpaWaived: true, aiAccess: "excluded",
});
check("a counselor creates a waived letter with its settings in one call",
  created.status === 201 && created.body.ferpaWaived === true && created.body.aiAccess === "excluded", JSON.stringify(created.body));
const afterCreate = await rest(s.token, "GET", `/rest/v1/documents?select=id&id=eq.${created.body.id}`);
check("the student never sees it, not even between create and a later patch", (afterCreate.body ?? []).length === 0);
const afterCreateList = await call(s.token, "GET", "/files/documents");
check("/files: nor in the student's list", Array.isArray(afterCreateList.body) && !afterCreateList.body.some((r) => r.id === created.body.id));
// (c) The upload's activity-log entry (which the student can read) doesn't carry a restricted file's name.
const ev = await sql(`select coalesce(metadata::text, '') from public.progress_events where entity_id = '${created.body.id}'`);
check("a restricted upload's progress event has no filename", ev !== "" && !ev.includes("one-call-letter"), ev);
const plain = await call(c.token, "POST", "/files/documents", { studentId: s.id, storagePath: `${s.id}/plain-${Date.now()}.pdf`, filename: "plain-resume.pdf", kind: "resume" });
const evPlain = await sql(`select metadata::text from public.progress_events where entity_id = '${plain.body.id}'`);
check("an ordinary upload's progress event still names the file", evPlain.includes("plain-resume.pdf"), evPlain);

// (b) Only a counselor sets aiAccess / ferpaWaived.
const stPatch = await call(s.token, "PATCH", `/files/documents/${transcript}`, { aiAccess: "allowed" });
check("a student PATCH of aiAccess through the API gets 403", stPatch.status === 403, `status ${stPatch.status}`);
const stPatch2 = await call(s.token, "PATCH", `/files/documents/${transcript}`, { ferpaWaived: true });
check("a student PATCH of ferpaWaived through the API gets 403", stPatch2.status === 403, `status ${stPatch2.status}`);
const stCreate = await call(s.token, "POST", "/files/documents", { storagePath: `${s.id}/st-${Date.now()}.pdf`, filename: "st.pdf", kind: "other", aiAccess: "allowed" });
check("a student creating a document with aiAccess gets 403", stCreate.status === 403, `status ${stCreate.status}`);
const before = await sql(`select ai_access from public.documents where id = '${transcript}'`);
const stRest = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${transcript}`, { ai_access: "allowed" }, { Prefer: "return=representation" });
const after = await sql(`select ai_access from public.documents where id = '${transcript}'`);
check("a student PATCH of ai_access through PostgREST is rejected and the value is unchanged",
  stRest.status >= 400 && before === after, `status ${stRest.status} ${before} -> ${after}`);
const stRest2 = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${transcript}`, { ferpa_waived: true }, { Prefer: "return=representation" });
const waivedNow = await sql(`select ferpa_waived from public.documents where id = '${transcript}'`);
check("a student PATCH of ferpa_waived through PostgREST is rejected", stRest2.status >= 400 && waivedNow === "f", `status ${stRest2.status} ${waivedNow}`);
const stIns = await rest(s.token, "POST", "/rest/v1/documents", { student_id: s.id, owner_id: s.id, storage_path: `${s.id}/ins-${Date.now()}.pdf`, filename: "ins.pdf", kind: "other", ai_access: "allowed" });
check("a student insert with ai_access 'allowed' through PostgREST is rejected", stIns.status >= 400, `status ${stIns.status}`);
const stOwn = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { title: "my own title" }, { Prefer: "return=representation" });
check("a student can still edit an ordinary field of their own document", stOwn.status === 200 && stOwn.body?.[0]?.title === "my own title", `status ${stOwn.status}`);
const stKind = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${transcript}`, { kind: "counselor-only" }, { Prefer: "return=representation" });
const kindNow = await sql(`select kind from public.documents where id = '${transcript}'`);
check("a student can't re-kind a counselor's document as counselor-only", stKind.status >= 400 && kindNow === "transcript", `status ${stKind.status} ${kindNow}`);

// Student PostgREST PATCH and DELETE on a restricted document they don't own change no rows.
for (const [label, id] of [["waived letter", letter], ["IEP/504", iep], ["counselor-only", only]]) {
  const p = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${id}`, { title: "hijack" }, { Prefer: "return=representation" });
  const dd = await rest(s.token, "DELETE", `/rest/v1/documents?id=eq.${id}`, undefined, { Prefer: "return=representation" });
  const row = await sql(`select coalesce(title, '') from public.documents where id = '${id}'`);
  check(`student PATCH and DELETE on the ${label} change no rows`,
    (p.body ?? []).length === 0 && (dd.body ?? []).length === 0 && row !== "hijack", `${p.status} ${dd.status} title=${row}`);
  const still = await sql(`select count(*) from public.documents where id = '${id}'`);
  check(`the ${label} still exists`, still === "1");
}

// (d) The link between a task and a restricted document is hidden from the student; their own submission stays.
const task = await sql(`with t as (insert into public.deliverables (student_id, kind, title, status, source, created_by)
  values ('${s.id}', 'document', 'Hand in a file', 'in-progress', 'counselor', '${c.id}') returning id) select id from t`);
await sql(`insert into public.deliverable_documents (deliverable_id, document_id, student_id, role, note, added_by)
  values ('${task}', '${letter}', '${s.id}', 'reference', 'LINK-NOTE-HIDDEN', '${c.id}')`);
await sql(`insert into public.deliverable_documents (deliverable_id, document_id, student_id, role, added_by)
  values ('${task}', '${transcript}', '${s.id}', 'reference', '${c.id}')`);
await sql(`insert into public.deliverable_documents (deliverable_id, document_id, student_id, role, added_by)
  values ('${task}', '${own}', '${s.id}', 'submission', '${s.id}')`);
const links = await rest(s.token, "GET", `/rest/v1/deliverable_documents?select=document_id,role,note&deliverable_id=eq.${task}`);
const linkDocs = (links.body ?? []).map((r) => r.document_id);
check("the student doesn't see the task link of a restricted document", !linkDocs.includes(letter) && !JSON.stringify(links.body).includes("LINK-NOTE-HIDDEN"), JSON.stringify(links.body));
check("the student still sees a counselor's ordinary reference link", linkDocs.includes(transcript));
check("the student still sees their own submission link", (links.body ?? []).some((r) => r.document_id === own && r.role === "submission"));
const cLinks = await rest(c.token, "GET", `/rest/v1/deliverable_documents?select=document_id&deliverable_id=eq.${task}`);
check("the counselor sees all three links", (cLinks.body ?? []).length === 3);
const taskView = await call(s.token, "GET", `/tasks/${task}`);
check("the student's task view doesn't list the restricted document", taskView.status === 200 && !JSON.stringify(taskView.body).includes(letter), `status ${taskView.status}`);
