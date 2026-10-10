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
