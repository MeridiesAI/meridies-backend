// Import pipeline step 1, Task 11: random import / edit / undo sequences never
// corrupt a record (spec §9 "Undo properties"). The model: an import writes
// a value if the field still holds what staging saw; undo restores the old
// value only where the field still holds what that import wrote.
import fc from "fast-check";
import { check, sql, user } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange } from "./imports-helpers.mjs";

const c = await user("imp-prop");
const FIELDS = ["sat_superscore", "act_composite"];
const VALUES = { sat_superscore: [1200, 1300, 1400, 1500], act_composite: [24, 28, 32, 35] };

const op = fc.oneof(
  fc.record({ kind: fc.constant("import"), field: fc.constantFrom(...FIELDS), pick: fc.nat(3) }),
  fc.record({ kind: fc.constant("edit"), field: fc.constantFrom(...FIELDS), pick: fc.nat(3) }),
  fc.record({ kind: fc.constant("undo"), back: fc.nat(3) })
);

let failures = 0;
await fc.assert(
  fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
    const s = await studentOf(c, "imp-prop-student");
    const model = { sat_superscore: null, act_composite: null };
    const committed = []; // { imp, field, wrote, old }
    for (const o of ops) {
      if (o.kind === "import") {
        const value = VALUES[o.field][o.pick];
        const imp = await makeImport(c);
        const item = await addItem(imp, { studentId: s.id });
        await addChange(imp, item, { target: "student_academics", field: o.field, value, studentId: s.id });
        await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
        await sql(`select public.commit_import('${imp}', '${c.id}')`);
        const old = model[o.field];
        if (old !== value) {
          model[o.field] = value;
          committed.push({ imp, field: o.field, wrote: value, old, undone: false });
        }
      } else if (o.kind === "edit") {
        const value = VALUES[o.field][o.pick] + 1;
        await sql(`insert into public.student_academics (student_id) values ('${s.id}') on conflict do nothing`);
        await sql(`update public.student_academics set ${o.field} = ${value} where student_id = '${s.id}'`);
        model[o.field] = value;
      } else {
        const live = committed.filter((x) => !x.undone);
        const target = live[live.length - 1 - (o.back % Math.max(live.length, 1))];
        if (!target) continue;
        await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${target.imp}'`);
        await sql(`select public.undo_import('${target.imp}', '${c.id}')`);
        target.undone = true;
        if (model[target.field] === target.wrote) model[target.field] = target.old;
      }
    }
    const raw = await sql(`select coalesce(row_to_json(a)::text, '{}') from public.student_academics a where student_id = '${s.id}'`);
    const db = JSON.parse(raw || "{}");
    const ok = FIELDS.every((f) => (db[f] ?? null) === model[f]);
    if (!ok) failures++;
    return ok;
  }),
  { numRuns: 20 }
).catch((err) => {
  console.error(err.message);
  failures++;
});
check("random import/edit/undo sequences match the model", failures === 0);
