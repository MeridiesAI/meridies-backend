// Import pipeline step 1, Task 8: provenance survives compaction; deletion removes fingerprints.
import { check, sql, user, rest, SB } from "./harness.mjs";
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

// Close cycle copies only 4/5-point GPAs into admission_outcomes (mirrors fourPointGpa).
const cc = await user("imp-prov-cycle");
const cases = [
  { tag: "blank-small", scale: null, gpa: 3.9, want: 3.9 },
  { tag: "blank-big", scale: null, gpa: 9, want: null },
  { tag: "five", scale: "5.0 weighted", gpa: 4.8, want: 4.8 },
  { tag: "ten", scale: "10", gpa: 8.5, want: null },
  { tag: "hundred", scale: "100", gpa: 92, want: null },
];
for (const k of cases) {
  const st = await studentOf(cc, `imp-cycle-${k.tag}`);
  k.id = st.id;
  await sql(`update public.profiles set grad_year = '2031' where id = '${st.id}'`);
  await sql(`insert into public.student_academics (student_id, gpa_scale, gpa_weighted, gpa_unweighted)
    values ('${st.id}', ${k.scale === null ? "null" : `'${k.scale}'`}, ${k.gpa}, ${k.gpa})`);
  await sql(`insert into public.student_colleges (student_id, name, status) values ('${st.id}', 'Cycle U', 'accepted')`);
}
const closed = await rest(cc.token, "POST", "/rest/v1/rpc/close_admission_cycle", { p_cycle: "2030-2031" });
check("close_admission_cycle runs with mixed GPA scales", closed.status === 200, `status ${closed.status} ${JSON.stringify(closed.body)}`);
for (const k of cases) {
  const got = await sql(`select coalesce(gpa_weighted::text, 'null') || ',' || coalesce(gpa_unweighted::text, 'null') from public.admission_outcomes where student_id = '${k.id}'`);
  const [w, u] = got.split(",").map((x) => (x === "null" ? null : Number(x)));
  check(`close cycle GPA (${k.tag}) is ${k.want ?? "unknown"}`, w === k.want && u === k.want, got);
}
