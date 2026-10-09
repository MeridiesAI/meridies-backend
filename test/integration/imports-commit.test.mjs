// Import pipeline step 1, Task 5: commit is all-or-nothing, compare-and-set, audited.
import { check, sql, sqlAsync, user, rest } from "./harness.mjs";
import { makeImport, studentOf, addItem, addChange, importRow, changeRow, academics, firmWith } from "./imports-helpers.mjs";

const c = await user("imp-commit");
const s = await studentOf(c, "imp-commit-student");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s.id}', 3.5, '4.0')`);

// Request through the browser path (RLS-checked function).
const imp = await makeImport(c);
const item = await addItem(imp, { studentId: s.id });
const gpa = await addChange(imp, item, { target: "student_academics", field: "gpa_weighted", value: 3.8, studentId: s.id });
const sat = await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1450, studentId: s.id });
const kept = await addChange(imp, item, { target: "student_academics", field: "act_composite", value: 30, studentId: s.id, decision: "keep_old" });
const score = await addChange(imp, item, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "AP Biology", kind: "ap", score: "5", taken_on: "2025-05-10" } });

const other = await user("imp-commit-other");
const denied = await rest(other.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp });
check("another counselor can't request a commit", denied.status >= 400, `status ${denied.status}`);
const req = await rest(c.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp });
check("the uploader can request a commit", req.status === 204 || req.status === 200, `status ${req.status} ${JSON.stringify(req.body)}`);
const again = await rest(c.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp });
check("a second request is refused as already in progress", again.status >= 400 && /already being saved/.test(JSON.stringify(again.body)), JSON.stringify(again.body));

// A student edit between review and commit.
await sql(`update public.student_academics set sat_superscore = 1500 where student_id = '${s.id}'`);

const out = JSON.parse(await sql(`select public.commit_import('${imp}', '${c.id}')`));
check("commit reports committed", out.status === "committed", JSON.stringify(out));
const a = await academics(s.id);
check("the accepted GPA is applied", Number(a.gpa_weighted) === 3.8);
check("the student's SAT edit survives", a.sat_superscore === 1500);
check("the stale change is reported", (await changeRow(sat)).state === "skipped_stale");
check("a keep-old change is not applied", (await changeRow(kept)).state === "staged" && a.act_composite === null);
check("the test score row is inserted", (await sql(`select count(*) from public.test_scores where student_id = '${s.id}' and source = 'import'`)) === "1");
const gpaRow = await changeRow(gpa);
check("applied changes keep a fingerprint of what was written", /^[0-9a-f]{64}$/.test(gpaRow.new_value_hash) && Number(gpaRow.applied_value) === 3.8);
check("applied insert keeps the new row id", /^[0-9a-f-]{36}$/.test((await changeRow(score)).target_row_id));
const row = await importRow(imp);
check("import is committed with a 30-day undo window", row.status === "committed" && Math.round((Date.parse(row.undo_until) - Date.parse(row.committed_at)) / 86400000) === 30);
check("result counts are recorded", row.job_result.applied === 2 && row.job_result.stale === 1, JSON.stringify(row.job_result));
const audit = await sql(`select metadata::text from public.audit_log where action = 'import.committed' and entity_id = '${imp}'`);
check("an audit row is written inside the commit", audit.includes('"applied": 2'), audit);
check("the audit row holds counts, not student ids", !audit.includes(s.id));
check("running the job again changes nothing", JSON.parse(await sql(`select public.commit_import('${imp}', '${c.id}')`)).status === "not-requested");

// Validation: every problem reported, nothing applied, back to review.
const s2 = await studentOf(c, "imp-commit-student2");
const imp2 = await makeImport(c);
const item2 = await addItem(imp2, { studentId: s2.id });
await addChange(imp2, item2, { target: "student_academics", field: "gpa_weighted", value: 92, studentId: s2.id });
await addChange(imp2, item2, { target: "student_personal_details", field: "birthday", value: "1975-01-01", studentId: s2.id });
await addChange(imp2, item2, { target: "student_academics", field: "sat_superscore", value: 1300, studentId: s2.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp2}'`);
const out2 = JSON.parse(await sql(`select public.commit_import('${imp2}', '${c.id}')`));
check("validation problems send the import back to review", out2.status === "review" && out2.problems.length === 2, JSON.stringify(out2));
check("nothing was applied", (await academics(s2.id)) === null);
check("the problems are stored for the review screen", (await importRow(imp2)).job_error.problems.length === 2);

// Skips are rolled back with the rest when validation sends the import back.
const sA = await studentOf(c, "imp-commit-studentA");
const sB = await studentOf(c, "imp-commit-studentB");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${sB.id}', 3.5, '4.0')`);
const impR = await makeImport(c);
const itemA = await addItem(impR, { studentId: sA.id });
const itemB = await addItem(impR, { studentId: sB.id });
await addChange(impR, itemA, { target: "student_academics", field: "sat_superscore", value: 1300, studentId: sA.id });
await addChange(impR, itemB, { target: "student_academics", field: "gpa_weighted", value: 92, studentId: sB.id });
await sql(`update public.profiles set counselor_id = '${other.id}' where id = '${sA.id}'`);
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${impR}'`);
const outR = JSON.parse(await sql(`select public.commit_import('${impR}', '${c.id}')`));
check("problems send it back to review", outR.status === "review", JSON.stringify(outR));
check("the reassigned student's item is not left skipped after a rollback to review", (await sql(`select match_status from public.import_items where id = '${itemA}'`)) === "matched_email");

// A different actor can't run someone else's job.
const impX = await makeImport(c);
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${impX}'`);
const outX = JSON.parse(await sql(`select public.commit_import('${impX}', '${other.id}')`));
check("a different actor gets not-requested", outX.status === "not-requested" && (await importRow(impX)).status === "committing", JSON.stringify(outX));

// A student moved to another counselor is skipped, not a rollback.
const s3 = await studentOf(c, "imp-commit-student3");
const imp3 = await makeImport(c);
const item3 = await addItem(imp3, { studentId: s3.id });
await addChange(imp3, item3, { target: "student_academics", field: "sat_superscore", value: 1300, studentId: s3.id });
await sql(`update public.profiles set counselor_id = '${other.id}' where id = '${s3.id}'`);
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp3}'`);
const out3 = JSON.parse(await sql(`select public.commit_import('${imp3}', '${c.id}')`));
check("a reassigned student's item is skipped and the import still commits", out3.status === "committed" &&
  (await sql(`select match_status from public.import_items where id = '${item3}'`)) === "skipped");

// Two runners at once: exactly one applies.
const s4 = await studentOf(c, "imp-commit-student4");
const imp4 = await makeImport(c);
const item4 = await addItem(imp4, { studentId: s4.id });
await addChange(imp4, item4, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "SAT", kind: "sat", score: "1400" } });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp4}'`);
const [r1, r2] = await Promise.all([
  sqlAsync(`select public.commit_import('${imp4}', '${c.id}')`),
  sqlAsync(`select public.commit_import('${imp4}', '${c.id}')`),
]);
const statuses = [JSON.parse(r1).status, JSON.parse(r2).status].sort().join(",");
check("two runners: one commits, the other is busy or finds it done", statuses === "busy,committed" || statuses === "committed,not-requested", statuses);
check("the row was inserted once", (await sql(`select count(*) from public.test_scores where student_id = '${s4.id}'`)) === "1");

// Scale before value: GPA 92 with the scale change in the same import.
const s5 = await studentOf(c, "imp-commit-student5");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${s5.id}', 3.5, '4.0')`);
const imp5 = await makeImport(c);
const item5 = await addItem(imp5, { studentId: s5.id });
await addChange(imp5, item5, { target: "student_academics", field: "gpa_weighted", value: 92, studentId: s5.id });
await addChange(imp5, item5, { target: "student_academics", field: "gpa_scale", value: "100", studentId: s5.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp5}'`);
const out5 = JSON.parse(await sql(`select public.commit_import('${imp5}', '${c.id}')`));
check("GPA 92 commits when the scale changes to 100 in the same import", out5.status === "committed" && Number((await academics(s5.id)).gpa_weighted) === 92, JSON.stringify(out5));

// Failure bookkeeping and the due-job list.
const imp6 = await makeImport(c);
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}', job_requested_at = now() - interval '5 minutes' where id = '${imp6}'`);
const due = await sql(`select count(*) from public.import_jobs_due(60) where id = '${imp6}' and kind = 'commit'`);
check("a commit requested 5 minutes ago is due for the sweep", due === "1");
await sql(`select public.fail_import_job('commit', '${imp6}', 'Couldn''t save. Nothing was changed. Try again.')`);
const failed = await importRow(imp6);
check("a failed commit goes back to review with the message", failed.status === "review" && /Nothing was changed/.test(failed.job_error.message));

// Firm admin may commit a firm member's import.
const owner = await user("imp-commit-owner");
const member = await user("imp-commit-member");
await firmWith(owner, [member]);
const s7 = await studentOf(member, "imp-commit-student7");
const imp7 = await makeImport(member);
const item7 = await addItem(imp7, { studentId: s7.id });
await addChange(imp7, item7, { target: "student_academics", field: "act_composite", value: 31, studentId: s7.id });
const adminReq = await rest(owner.token, "POST", "/rest/v1/rpc/request_import_commit", { p_import: imp7 });
check("the firm owner can request a member's commit", adminReq.status === 204 || adminReq.status === 200, `status ${adminReq.status}`);
const out7 = JSON.parse(await sql(`select public.commit_import('${imp7}', '${owner.id}')`));
check("the firm owner's commit applies to the member's student", out7.status === "committed" && (await academics(s7.id)).act_composite === 31);

const grants = await sql(`select has_function_privilege('authenticated', 'public.commit_import(uuid, uuid)', 'execute')::text || ',' || has_function_privilege('import_worker', 'public.commit_import(uuid, uuid)', 'execute')::text`);
check("only the worker (not the browser) can run commit_import", grants === "false,true", grants);

// Lowering the scale: GPA 92 on '100' -> 3.8 on '4.0' commits (GPA written before the scale).
const sL = await studentOf(c, "imp-commit-lower");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${sL.id}', 92, '100')`);
const impL = await makeImport(c);
const itemL = await addItem(impL, { studentId: sL.id });
await addChange(impL, itemL, { target: "student_academics", field: "gpa_scale", value: "4.0", studentId: sL.id });
await addChange(impL, itemL, { target: "student_academics", field: "gpa_weighted", value: 3.8, studentId: sL.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${impL}'`);
const outL = JSON.parse(await sql(`select public.commit_import('${impL}', '${c.id}')`));
const aL = await academics(sL.id);
check("lowering the scale with a new GPA commits", outL.status === "committed" && Number(aL.gpa_weighted) === 3.8 && aL.gpa_scale === "4.0", JSON.stringify({ outL, aL }));

// A scale-only move to 4.0 under a stored GPA of 92 is sent back to review.
const sM = await studentOf(c, "imp-commit-lower-only");
await sql(`insert into public.student_academics (student_id, gpa_weighted, gpa_scale) values ('${sM.id}', 92, '100')`);
const impM = await makeImport(c);
const itemM = await addItem(impM, { studentId: sM.id });
await addChange(impM, itemM, { target: "student_academics", field: "gpa_scale", value: "4.0", studentId: sM.id });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${impM}'`);
const outM = JSON.parse(await sql(`select public.commit_import('${impM}', '${c.id}')`));
check("a scale change that strands the GPA goes to review", outM.status === "review" && /GPA 92(\.0+)? needs a 100-point scale/.test(JSON.stringify(outM.problems)), JSON.stringify(outM));
