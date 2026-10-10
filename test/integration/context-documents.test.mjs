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
