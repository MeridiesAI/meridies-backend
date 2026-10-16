// PR 0: documents.kind_confirmed / kind_guess / extraction_requested_at (20261024000001).
import { check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const c = await user("kind-confirm");
const s = await studentOf(c, "kind-confirm-student");

const cols = await sql(`select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by column_name)
  from information_schema.columns where table_schema = 'public' and table_name = 'documents'
  and column_name in ('kind_confirmed', 'kind_guess', 'extraction_requested_at', 'extraction_attempts', 'extraction_lease_until')`);
check("kind_confirmed is boolean, not null, default true", cols.includes("kind_confirmed:boolean:NO:true"), cols);
check("extraction_attempts is smallint, not null, default 0", cols.includes("extraction_attempts:smallint:NO:0"), cols);
check("extraction_lease_until is a nullable timestamp", cols.includes("extraction_lease_until:timestamp with time zone:YES:"), cols);
check("kind_guess is nullable jsonb", cols.includes("kind_guess:jsonb:YES:"), cols);
check("extraction_requested_at is a nullable timestamp", cols.includes("extraction_requested_at:timestamp with time zone:YES:"), cols);

const id = await sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind)
  values ('${s.id}', '${c.id}', 'x/kc-${Date.now()}', 'old.pdf', 'other') returning id) select id from d`);
check("an existing-style insert counts as confirmed", (await sql(`select kind_confirmed::text from public.documents where id = '${id}'`)) === "true");

let refused = false;
try { await sql(`update public.documents set kind_guess = '"text"'::jsonb where id = '${id}'`); } catch { refused = true; }
check("kind_guess must be an object", refused);

await sql(`update public.documents set kind_confirmed = false, kind_guess = '{"kind":"transcript","basis":"filename","matched":"transcript","textFound":false,"keepOut":false}' where id = '${id}'`);
check("the counselor side can mark a file unconfirmed with a guess",
  (await sql(`select kind_confirmed::text || ':' || (kind_guess->>'kind') from public.documents where id = '${id}'`)) === "false:transcript");

const idx = await sql(`select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename = 'documents'
  and indexname in ('documents_unconfirmed_idx', 'documents_extraction_requested_idx')`);
check("both partial indexes exist", idx === "documents_extraction_requested_idx,documents_unconfirmed_idx", idx);

// A student can't set any of the three, on insert or update.
const insert = await rest(s.token, "POST", "/rest/v1/documents", {
  student_id: s.id, owner_id: s.id, storage_path: `${s.id}/kc-${Date.now()}.pdf`, filename: "mine.pdf", kind: "other", kind_confirmed: false,
}, { Prefer: "return=representation" });
check("a student can't insert an unconfirmed document", insert.status >= 400, `status ${insert.status}`);
const own = await sql(`with d as (insert into public.documents (student_id, owner_id, storage_path, filename, kind)
  values ('${s.id}', '${s.id}', '${s.id}/kc-own-${Date.now()}.pdf', 'own.pdf', 'other') returning id) select id from d`);
const patch = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { extraction_requested_at: new Date().toISOString() });
check("a student can't request an extraction", patch.status >= 400, `status ${patch.status}`);
const patch2 = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { kind_guess: { kind: "transcript" } });
check("a student can't write a guess", patch2.status >= 400, `status ${patch2.status}`);
const patch4 = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { extraction_attempts: 5, extraction_lease_until: new Date().toISOString() });
check("a student can't touch the queue lease", patch4.status >= 400, `status ${patch4.status}`);
let badAttempts = false;
try { await sql(`update public.documents set extraction_attempts = 11 where id = '${id}'`); } catch { badAttempts = true; }
check("attempts are bounded", badAttempts);
const patch3 = await rest(s.token, "PATCH", `/rest/v1/documents?id=eq.${own}`, { title: "renamed" });
check("a student can still rename their own file", patch3.status < 300, `status ${patch3.status}`);
