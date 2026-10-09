// Import pipeline step 1, Task 8: provenance survives compaction; deletion removes fingerprints.
import { check, sql, user, SB } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, changeRow } from "./imports-helpers.mjs";

const c = await user("imp-prov");
const s = await studentOf(c, "imp-prov-student");

const imp = await makeImport(c, { sourceSystem: "collegeplannerpro" });
const item = await addItem(imp, { studentId: s.id });
const ch = await addChange(imp, item, { target: "student_academics", field: "gpa_weighted", value: 3.8, studentId: s.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
await sql(`select public.commit_import('${imp}', '${c.id}')`);

const prov = async () => JSON.parse((await sql(`select coalesce(public.import_field_provenance('${s.id}', 'student_academics', 'gpa_weighted')::text, 'null')`)));
let p = await prov();
check("provenance names the source system", p?.sourceSystem === "collegeplannerpro" && p?.importId === imp, JSON.stringify(p));
check("the value is still what the import wrote", p?.matchesCurrent === true);

// 30 days later: compaction drops the values, keeps the fingerprint.
await sql(`update public.roster_imports set undo_until = now() - interval '1 minute' where id = '${imp}'`);
const n = Number(await sql(`select public.compact_imports()`));
check("compaction reports work done", n >= 1, String(n));
const row = await changeRow(ch);
check("compacted change has no values", row.old_value === null && row.new_value === null && row.applied_value === null);
check("compacted change keeps its fingerprint", /^[0-9a-f]{64}$/.test(row.new_value_hash));
check("the import is marked compacted", (await sql(`select (compacted_at is not null)::text from public.roster_imports where id = '${imp}'`)) === "true");
p = await prov();
check("provenance still works after compaction", p?.matchesCurrent === true);

await sql(`update public.student_academics set gpa_weighted = 3.9 where student_id = '${s.id}'`);
p = await prov();
check("after a person edits the value, it no longer matches", p?.matchesCurrent === false);

// Held data waiting for a counselor is not compacted.
const inv = await sql(`with i as (insert into public.invitations (counselor_id, email, token) values ('${c.id}', 'prov-${Date.now()}@test.local', 'prov-${Date.now()}') returning id) select id from i`);
const imp2 = await makeImport(c);
const held = await addItem(imp2, { status: "new_invite", invitationId: inv });
const heldCh = await addChange(imp2, held, { target: "student_academics", field: "act_composite", value: 30, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committed', committed_at = now() - interval '31 days', undo_until = now() - interval '1 day' where id = '${imp2}'`);
await sql(`select public.compact_imports()`);
check("held data is not compacted", (await changeRow(heldCh)).new_value === 30);

// Deleting the student's account deletes their import data and fingerprints.
await sql(`delete from auth.users where id = '${s.id}'`);
check("account deletion removes the student's import changes", (await sql(`select count(*) from public.import_changes where id = '${ch}'`)) === "0");

// Close cycle never copies a 100-point GPA into admission_outcomes.
const fn = await sql(`select pg_get_functiondef('public.close_admission_cycle(text)'::regprocedure)`);
check("close_admission_cycle guards GPAs over 10", fn.includes("sa.gpa_weighted <= 10") && fn.includes("sa.gpa_unweighted <= 10"));
