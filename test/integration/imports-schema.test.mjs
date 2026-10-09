// Import pipeline step 1, Task 1: the schema exists and enforces its shape.
import { check, sql, user, rest } from "./harness.mjs";
import { makeImport, studentOf, firmWith, q } from "./imports-helpers.mjs";

const tables = await sql(`select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'
  and tablename in ('import_fields','import_templates','import_files','import_items','import_changes')`);
check("all five import tables exist", tables === "import_changes,import_fields,import_files,import_items,import_templates", tables);

const rls = await sql(`select count(*) from pg_tables where schemaname = 'public' and tablename like 'import_%' and rowsecurity = false`);
check("RLS is on for every import table", rls === "0", rls);

const fields = await sql(`select count(*) from public.import_fields`);
check("import_fields is seeded (17 fields + 3 row targets)", fields === "20", fields);
const star = await sql(`select string_agg(target_table, ',' order by target_table) from public.import_fields where field = '*'`);
check("each multi-row target has a '*' row", star === "activities,courses,test_scores", star);

const c = await user("imp-schema");
const s = await studentOf(c);
// 100-point GPA fits once the scale says so…
await sql(`insert into public.student_academics (student_id, gpa_scale, gpa_weighted) values ('${s.id}', '100', 92.5)`);
check("a 92.5 GPA is stored on a 100-point scale", (await sql(`select gpa_weighted from public.student_academics where student_id = '${s.id}'`)) === "92.500");
// …and is refused on a 4-point scale.
let refused = false;
try { await sql(`update public.student_academics set gpa_scale = '4.0' where student_id = '${s.id}'`); } catch { refused = true; }
check("a 92.5 GPA is refused on a 4.0 scale", refused);

const ts = await sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name in ('test_scores','courses') and column_name = 'source'`);
check("test_scores and courses carry a source column", ts === "source,source", ts);

// Firm stamping: an import created by a firm member records the firm.
const owner = await user("imp-schema-owner");
const member = await user("imp-schema-member");
const firmId = await firmWith(owner, [member]);
const imp = await makeImport(member);
check("an import records its firm at creation", (await sql(`select firm_id from public.roster_imports where id = '${imp}'`)) === firmId);
const solo = await makeImport(c);
check("a solo counselor's import has no firm", (await sql(`select coalesce(firm_id::text, 'null') from public.roster_imports where id = '${solo}'`)) === "null");

// The change list refuses a field that isn't on the list.
const item = await sql(`with i as (insert into public.import_items (import_id, match_status, student_id) values ('${solo}', 'matched_email', '${s.id}') returning id) select id from i`);
let fk = false;
try { await sql(`insert into public.import_changes (import_id, item_id, target_table, field, op, new_value) values ('${solo}', '${item}', 'profiles', 'role', 'set_field', '"counselor"')`); } catch { fk = true; }
check("a change to a field not in import_fields can't be stored", fk);

const hb = await sql(`select count(*) from public.job_heartbeats where job = 'import-sweep'`);
check("the import-sweep heartbeat row exists", hb === "1");

// A counselor can't reset server-owned columns through PostgREST.
const spendImp = await makeImport(c);
await sql(`update public.roster_imports set ai_spend_cents = 150 where id = '${spendImp}'`);
const patch = await rest(c.token, "PATCH", `/rest/v1/roster_imports?id=eq.${spendImp}`, { ai_spend_cents: 0 });
check("a counselor can't reset ai_spend_cents", patch.status >= 400 && (await sql(`select ai_spend_cents from public.roster_imports where id = '${spendImp}'`)) === "150", String(patch.status));

// ---- Task 2: who can see what ----------------------------------------------
const ownerA = await user("imp-acl-owner");
const counselorA = await user("imp-acl-member");
const outsider = await user("imp-acl-outsider");
await firmWith(ownerA, [counselorA]);
const studentA = await studentOf(counselorA, "imp-acl-student");
const impA = await makeImport(counselorA);
const itemA = await sql(`with i as (insert into public.import_items (import_id, match_status, student_id) values ('${impA}', 'matched_email', '${studentA.id}') returning id) select id from i`);

const seen = async (u, table, col = "import_id") => {
  const r = await rest(u.token, "GET", `/rest/v1/${table}?select=id&${col}=eq.${impA}`);
  return Array.isArray(r.body) ? r.body.length : -1;
};
check("the uploader sees their import", (await seen(counselorA, "roster_imports", "id")) === 1);
check("the uploader sees its items", (await seen(counselorA, "import_items")) === 1);
check("the firm owner (admin) sees the import", (await seen(ownerA, "roster_imports", "id")) === 1);
check("the firm owner sees its items", (await seen(ownerA, "import_items")) === 1);
check("a counselor outside the firm sees nothing", (await seen(outsider, "roster_imports", "id")) === 0);
check("the student sees nothing", (await seen(studentA, "import_items")) === 0);

const ins = await rest(counselorA.token, "POST", "/rest/v1/import_changes", {
  import_id: impA, item_id: itemA, target_table: "student_academics", field: "gpa_weighted", op: "set_field", new_value: 4,
});
check("the browser can't insert a change", ins.status === 401 || ins.status === 403, `status ${ins.status}`);

const bump = await rest(counselorA.token, "PATCH", `/rest/v1/roster_imports?id=eq.${impA}`, { status: "committed" });
check("the browser can't move an import to committed", bump.status >= 400, `status ${bump.status}`);

const fieldsSeen = await rest(counselorA.token, "GET", "/rest/v1/import_fields?select=field");
check("counselors can read the field list", Array.isArray(fieldsSeen.body) && fieldsSeen.body.length === 20);

// Leaving the firm: the uploader loses access, the owner keeps it.
await sql(`delete from public.firm_members where profile_id = '${counselorA.id}'`);
await sql(`update public.profiles set firm_id = null where id = '${counselorA.id}'`);
check("an uploader who left the firm no longer sees the import", (await seen(counselorA, "roster_imports", "id")) === 0);
check("the firm owner still sees it", (await seen(ownerA, "roster_imports", "id")) === 1);

// Students can't create imports (final review fix 9).
const stuIns = await user("imp-acl-student", "student");
const stuImp = await rest(stuIns.token, "POST", "/rest/v1/roster_imports", { counselor_id: stuIns.id, filename: "x.csv", source: "csv" });
check("a student can't create a roster import", stuImp.status >= 400 && stuImp.body?.code === "42501", `status ${stuImp.status} ${JSON.stringify(stuImp.body)}`);
const ctrIns = await user("imp-acl-ctr");
const ctrImp = await rest(ctrIns.token, "POST", "/rest/v1/roster_imports", { counselor_id: ctrIns.id, filename: "x.csv", source: "csv" });
check("a counselor can still create a roster import", ctrImp.status === 201, `status ${ctrImp.status} ${JSON.stringify(ctrImp.body)}`);

// Storage: upload only into your own draft import.
const soloAcl = await user("imp-acl-soloAcl");
const draft = await makeImport(soloAcl, { status: "draft" });
const csv = new TextEncoder().encode("name,email\nA,a@test.local\n");
const up = await rest(soloAcl.token, "POST", `/storage/v1/object/imports/${soloAcl.id}/${draft}/f1-test.csv`, csv, { "Content-Type": "text/csv" });
check("a counselor can upload into their own draft import", up.status === 200, `status ${up.status} ${JSON.stringify(up.body)}`);
const reviewImp = await makeImport(soloAcl, { status: "review" });
const up2 = await rest(soloAcl.token, "POST", `/storage/v1/object/imports/${soloAcl.id}/${reviewImp}/f2-test.csv`, csv, { "Content-Type": "text/csv" });
check("uploading into an import that isn't a draft is refused", up2.status >= 400, `status ${up2.status}`);
const up3 = await rest(outsider.token, "POST", `/storage/v1/object/imports/${soloAcl.id}/${draft}/f3-test.csv`, csv, { "Content-Type": "text/csv" });
check("uploading into someone else's folder is refused", up3.status >= 400, `status ${up3.status}`);
const read = await rest(outsider.token, "GET", `/storage/v1/object/imports/${soloAcl.id}/${draft}/f1-test.csv`);
check("someone else can't read the file", read.status >= 400, `status ${read.status}`);

// import_worker holds no standing privileges.
const wk = await sql(`select rolsuper::text || ',' || rolbypassrls::text from pg_roles where rolname = 'import_worker'`);
check("import_worker is not a superuser and doesn't bypass RLS", wk === "false,false", wk);
const wkGrants = await sql(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'import\\_%' or c.relname = 'roster_imports')
    and has_table_privilege('import_worker', c.oid, 'select,insert,update,delete,truncate,references,trigger')`);
check("import_worker has no table privileges on the import tables", wkGrants === "0", wkGrants);
const wkGrants2 = await sql(`select count(*) from information_schema.role_table_grants where grantee = 'import_worker'`);
check("import_worker has no table grants at all", wkGrants2 === "0", wkGrants2);

// The access functions, called directly.
const ownerB = await user("imp-fn-owner");
const memberB = await user("imp-fn-member");
const otherB = await user("imp-fn-other");
await firmWith(ownerB, [memberB]);
const stuB = await studentOf(memberB, "imp-fn-student");
const impB = await makeImport(memberB);
const fn = (name, ...args) => sql(`select private.${name}(${args.map((a) => `'${a}'`).join(", ")})::text`);
check("can_manage_import: uploader", (await fn("can_manage_import", impB, memberB.id)) === "true");
check("can_manage_import: firm owner", (await fn("can_manage_import", impB, ownerB.id)) === "true");
check("can_manage_import: outsider", (await fn("can_manage_import", impB, otherB.id)) === "false");
check("import_can_write_student: the student's own counselor", (await fn("import_can_write_student", impB, stuB.id, memberB.id)) === "true");
check("import_can_write_student: firm owner, counselor in the firm", (await fn("import_can_write_student", impB, stuB.id, ownerB.id)) === "true");
check("import_can_write_student: outsider counselor", (await fn("import_can_write_student", impB, stuB.id, otherB.id)) === "false");
const stuOut = await studentOf(otherB, "imp-fn-student-out");
check("import_can_write_student: firm owner, counselor not in the firm", (await fn("import_can_write_student", impB, stuOut.id, ownerB.id)) === "false");
check("anon can't execute can_view_import", (await sql(`select has_function_privilege('anon', 'private.can_view_import(uuid, uuid)', 'execute')::text`)) === "false");

// A former firm member can't upload into an old firm-stamped draft.
const ownerC = await user("imp-left-owner");
const memberC = await user("imp-left-member");
await firmWith(ownerC, [memberC]);
const draftC = await makeImport(memberC, { status: "draft" });
await sql(`delete from public.firm_members where profile_id = '${memberC.id}'`);
await sql(`update public.profiles set firm_id = null where id = '${memberC.id}'`);
const upC = await rest(memberC.token, "POST", `/storage/v1/object/imports/${memberC.id}/${draftC}/f9-test.csv`, csv, { "Content-Type": "text/csv" });
check("a former firm member can't upload into an old firm-stamped draft", upC.status >= 400, `status ${upC.status}`);
