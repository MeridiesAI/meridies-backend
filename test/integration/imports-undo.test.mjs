// Import pipeline step 1, Task 6: undo reverts what nobody edited since.
import { check, sql, user, rest } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, importRow, changeRow, academics } from "./imports-helpers.mjs";

const c = await user("imp-undo");
const s = await studentOf(c, "imp-undo-student");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale, sat_superscore) values ('${s.id}', 3.5, '4.0', 1300)`);

async function committed(changes, studentId = s.id) {
  const imp = await makeImport(c);
  const item = await addItem(imp, { studentId });
  const ids = [];
  for (const ch of changes) ids.push(await addChange(imp, item, { studentId, ...ch }));
  await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
  const out = JSON.parse(await sql(`select public.commit_import('${imp}', '${c.id}')`));
  if (out.status !== "committed") throw new Error("setup commit failed " + JSON.stringify(out));
  return { imp, ids };
}

const { imp, ids } = await committed([
  { target: "student_academics", field: "gpa_weighted", value: 3.9 },
  { target: "student_academics", field: "sat_superscore", value: 1450 },
  { target: "test_scores", field: "*", op: "insert_row", value: { exam: "AP Biology", kind: "ap", score: "5" } },
  { target: "activities", field: "*", op: "insert_row", value: { name: "Robotics" } },
]);
// After the commit the student edits their SAT and the activity.
await sql(`update public.student_academics set sat_superscore = 1500 where student_id = '${s.id}'`);
await sql(`update public.activities set position = 'Captain' where student_id = '${s.id}' and name = 'Robotics'`);

const other = await user("imp-undo-other");
check("another counselor can't request undo", (await rest(other.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: imp })).status >= 400);
const req = await rest(c.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: imp });
check("the uploader can request undo", req.status === 204 || req.status === 200, `status ${req.status} ${JSON.stringify(req.body)}`);
const out = JSON.parse(await sql(`select public.undo_import('${imp}', '${c.id}')`));
check("undo reports what it reverted and kept", out.status === "undone" && out.reverted === 2 && out.kept === 2, JSON.stringify(out));
const a = await academics(s.id);
check("the untouched GPA is restored", Number(a.gpa_weighted) === 3.5);
check("the student's SAT edit is kept", a.sat_superscore === 1500);
check("the kept SAT change is marked undo_skipped", (await changeRow(ids[1])).state === "undo_skipped");
check("the unedited test score is deleted", (await sql(`select count(*) from public.test_scores where student_id = '${s.id}'`)) === "0");
check("the edited activity is kept", (await sql(`select count(*) from public.activities where student_id = '${s.id}'`)) === "1");
const row = await importRow(imp);
check("import is undone with a timestamp", row.status === "undone" && row.undone_at !== null);
check("an audit row is written", (await sql(`select count(*) from public.audit_log where action = 'import.undone' and entity_id = '${imp}'`)) === "1");
check("undo can't run twice", (await rest(c.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: imp })).status >= 400);

// Scale and GPA: GPA reverts before the scale, and a scale undo that would break an edited GPA is skipped.
const s2 = await studentOf(c, "imp-undo-scale");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s2.id}', 3.8, '4.0')`);
const r2 = await committed([
  { target: "student_academics", field: "gpa_scale", value: "100" },
  { target: "student_academics", field: "gpa_weighted", value: 92 },
], s2.id);
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${r2.imp}'`);
const o2 = JSON.parse(await sql(`select public.undo_import('${r2.imp}', '${c.id}')`));
const a2 = await academics(s2.id);
check("undo restores GPA then scale", o2.status === "undone" && Number(a2.gpa_weighted) === 3.8 && a2.gpa_scale === "4.0", JSON.stringify(a2));

const s3 = await studentOf(c, "imp-undo-scale-edited");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s3.id}', 3.8, '4.0')`);
const r3 = await committed([
  { target: "student_academics", field: "gpa_scale", value: "100" },
  { target: "student_academics", field: "gpa_weighted", value: 92 },
], s3.id);
await sql(`update public.student_academics set gpa_weighted = 93 where student_id = '${s3.id}'`);
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${r3.imp}'`);
const o3 = JSON.parse(await sql(`select public.undo_import('${r3.imp}', '${c.id}')`));
const a3 = await academics(s3.id);
check("scale undo that would break the GPA is skipped", o3.status === "undone" && a3.gpa_scale === "100" && Number(a3.gpa_weighted) === 93, JSON.stringify({ o3, a3 }));

// Pending invitations from the import are revoked; held data is dropped.
const s4email = `undo-invite-${Date.now()}@test.local`;
const inv = await sql(`with i as (insert into public.invitations (counselor_id, email, token) values ('${c.id}', '${s4email}', 'tok-${Date.now()}') returning id) select id from i`);
const imp4 = await makeImport(c);
const item4 = await addItem(imp4, { status: "new_invite", invitationId: inv });
await addChange(imp4, item4, { target: "student_academics", field: "sat_superscore", value: 1400, oldValue: null });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp4}'`);
await sql(`select public.commit_import('${imp4}', '${c.id}')`);
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${imp4}'`);
const o4 = JSON.parse(await sql(`select public.undo_import('${imp4}', '${c.id}')`));
check("undo revokes the import's pending invitations", o4.invitationsRevoked === 1 && (await sql(`select status from public.invitations where id = '${inv}'`)) === "revoked");
check("held data for that invitation is dropped", (await sql(`select match_status from public.import_items where id = '${item4}'`)) === "skipped");

// After 30 days: no undo.
const { imp: old } = await committed([{ target: "student_academics", field: "act_composite", value: 33 }]);
await sql(`update public.roster_imports set undo_until = now() - interval '1 minute' where id = '${old}'`);
const late = await rest(c.token, "POST", "/rest/v1/rpc/request_import_undo", { p_import: old });
check("undo after 30 days is refused with a reason", late.status >= 400 && /30 days/.test(JSON.stringify(late.body)), JSON.stringify(late.body));

// A foreign actor can't run someone else's undo job.
const { imp: imp5 } = await committed([{ target: "student_academics", field: "act_composite", value: 30 }]);
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${imp5}'`);
const o5 = JSON.parse(await sql(`select public.undo_import('${imp5}', '${other.id}')`));
check("undo by a foreign actor is not-requested and leaves the import undoing", o5.status === "not-requested" && (await importRow(imp5)).status === "undoing", JSON.stringify(o5));
