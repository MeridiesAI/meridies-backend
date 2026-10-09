// Import pipeline step 1, Task 7: held data never attaches by itself (§5.8).
import { check, sql, user, rest } from "./harness.mjs";
import { makeImport, addItem, addChange, academics, q } from "./imports-helpers.mjs";

const c = await user("imp-held");
const tag = Date.now();

async function invite(email) {
  const token = `held-${tag}-${Math.random().toString(36).slice(2)}`;
  const id = await sql(`with i as (insert into public.invitations (counselor_id, email, token, full_name) values ('${c.id}', '${email}', '${token}', 'Jane Doe') returning id) select id from i`);
  return { id, token };
}

// New pipeline: committed import with a new_invite item.
const inv = await invite(`held-${tag}@test.local`);
const imp = await makeImport(c);
const item = await addItem(imp, { status: "new_invite", invitationId: inv.id, name: "Jane Doe" });
const satChange = await addChange(imp, item, { target: "student_academics", field: "sat_superscore", value: 1450, oldValue: null, decision: "auto" });
await addChange(imp, item, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "AP Biology", kind: "ap", score: "5" }, decision: "auto" });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${imp}'`);
await sql(`select public.commit_import('${imp}', '${c.id}')`);

const student = await user("held-student", "student");
const acc = await rest(student.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: inv.token });
check("the student accepts the invitation", acc.status === 200, `status ${acc.status} ${JSON.stringify(acc.body)}`);
check("nothing attaches on acceptance", (await academics(student.id)) === null);
const st = await sql(`select match_status || ',' || (student_id = '${student.id}')::text || ',' || (held_until > now() + interval '29 days')::text from public.import_items where id = '${item}'`);
check("the item waits for the counselor for 30 days", st === "awaiting_counselor,true,true", st);

const queue = await rest(c.token, "POST", "/rest/v1/rpc/import_held_queue", {});
const entry = (queue.body ?? []).find((e) => e.itemId === item);
check("the counselor's queue shows the item", !!entry, JSON.stringify(queue.body).slice(0, 300));
check("the queue shows the account's name and the imported name", entry?.importedName === "Jane Doe" && entry?.studentName === "held-student");
check("an empty field defaults to accept", entry?.changes.find((ch) => ch.field === "sat_superscore")?.defaultDecision === "accept");

const otherC = await user("imp-held-other");
const theirs = await rest(otherC.token, "POST", "/rest/v1/rpc/import_held_queue", {});
check("another counselor's queue doesn't show it", !(theirs.body ?? []).some((e) => e.itemId === item));

// The student types an SAT during intake; the counselor keeps it.
await sql(`insert into public.student_academics (student_id, sat_superscore) values ('${student.id}', 1500)`);
const scoreChange = entry.changes.find((ch) => ch.op === "insert_row").id;
const decisions = { [satChange]: "keep_old", [scoreChange]: "accept" };
const req = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: item, p_decisions: decisions });
check("the counselor requests apply", req.status === 204 || req.status === 200, `status ${req.status} ${JSON.stringify(req.body)}`);
const out = JSON.parse(await sql(`select public.apply_held_item('${item}', '${c.id}')`));
check("apply reports applied", out.status === "applied" && out.applied === 1, JSON.stringify(out));
check("the student's own SAT is kept", (await academics(student.id)).sat_superscore === 1500);
check("the accepted test score is added", (await sql(`select count(*) from public.test_scores where student_id = '${student.id}' and source = 'import'`)) === "1");
check("the item is applied", (await sql(`select match_status from public.import_items where id = '${item}'`)) === "applied");
check("an audit row is written", (await sql(`select count(*) from public.audit_log where action = 'import.held_applied' and entity_id = '${item}'`)) === "1");

// Undo of the import reverts the held data that was applied.
await sql(`update public.roster_imports set status = 'undoing', job_actor = '${c.id}' where id = '${imp}'`);
const undo = JSON.parse(await sql(`select public.undo_import('${imp}', '${c.id}')`));
check("undo reverts applied held data too", undo.status === "undone" && (await sql(`select count(*) from public.test_scores where student_id = '${student.id}'`)) === "0", JSON.stringify(undo));

// Old roster flow: a row that was sent as an invitation lands in the queue on acceptance.
const legacyInv = await invite(`legacy-${tag}@test.local`);
const legacyImp = await sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${c.id}', 'old.csv', 'csv', 'complete') returning id) select id from i`);
await sql(`insert into public.roster_import_rows (import_id, counselor_id, row_number, full_name, email, gpa_weighted, sat_total, intended_major, status, invitation_id)
  values ('${legacyImp}', '${c.id}', 2, 'Sam Lee', 'legacy-${tag}@test.local', 3.7, 1380, 'Biology', 'invited', '${legacyInv.id}')`);
const legacyStudent = await user("legacy-student", "student");
await rest(legacyStudent.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: legacyInv.token });
const legacyItem = await sql(`select id from public.import_items where student_id = '${legacyStudent.id}' and match_status = 'awaiting_counselor'`);
check("an old-flow row is carried into the queue", /^[0-9a-f-]{36}$/.test(legacyItem), legacyItem);
const legacyFields = await sql(`select string_agg(field, ',' order by field) from public.import_changes where item_id = '${legacyItem}'`);
check("its GPA, SAT and major are held", legacyFields === "gpa_weighted,intended_majors,sat_superscore", legacyFields);
check("still nothing attaches", (await academics(legacyStudent.id)) === null);

// Expiry: a warning 7 days before, then the data is wiped.
const soon = await sql(`with x as (update public.import_items set held_until = now() + interval '3 days' where id = '${legacyItem}' returning id) select id from x`);
const exp1 = JSON.parse(await sql(`select public.expire_import_holds()`));
check("a hold ending within 7 days is returned for a warning", exp1.warn.some((w) => w.itemId === soon && w.counselorEmail === c.email), JSON.stringify(exp1));
const exp1b = JSON.parse(await sql(`select public.expire_import_holds()`));
check("the warning is returned only once", !exp1b.warn.some((w) => w.itemId === soon));
await sql(`update public.import_items set held_until = now() - interval '1 minute' where id = '${legacyItem}'`);
const exp2 = JSON.parse(await sql(`select public.expire_import_holds()`));
check("an expired hold is wiped", exp2.expired >= 1 && (await sql(`select count(*) from public.import_changes where item_id = '${legacyItem}'`)) === "0");
check("the item is marked expired", (await sql(`select match_status from public.import_items where id = '${legacyItem}'`)) === "expired");

// A pending invitation that expired takes its held data with it.
const inv3 = await invite(`never-${tag}@test.local`);
const imp3 = await makeImport(c);
const item3 = await addItem(imp3, { status: "new_invite", invitationId: inv3.id });
await addChange(imp3, item3, { target: "student_academics", field: "act_composite", value: 30, oldValue: null, decision: "auto" });
await sql(`update public.invitations set expires_at = now() - interval '1 minute' where id = '${inv3.id}'`);
await sql(`select public.expire_import_holds()`);
check("data for a never-accepted invitation expires with it", (await sql(`select match_status from public.import_items where id = '${item3}'`)) === "expired");

// Rulings: apply is refused for a foreign actor and for an undone import; nothing is written.
const impX = await makeImport(c);
const invX = await invite(`ruling-${tag}@test.local`);
const itemX = await addItem(impX, { status: "new_invite", invitationId: invX.id, name: "Ruling Case" });
await addChange(impX, itemX, { target: "student_academics", field: "act_composite", value: 31, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${impX}'`);
await sql(`select public.commit_import('${impX}', '${c.id}')`);
const studentX = await user("held-ruling", "student");
await rest(studentX.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: invX.token });
const reqX = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: itemX, p_decisions: {} });
check("ruling case: apply requested", reqX.status === 204 || reqX.status === 200, `status ${reqX.status} ${JSON.stringify(reqX.body)}`);
const foreign = JSON.parse(await sql(`select public.apply_held_item('${itemX}', '${otherC.id}')`));
check("a foreign actor gets not-requested", foreign.status === "not-requested", JSON.stringify(foreign));
check("nothing was written for the foreign actor", (await academics(studentX.id)) === null);
await sql(`update public.roster_imports set status = 'undone' where id = '${impX}'`);
const undoneApply = JSON.parse(await sql(`select public.apply_held_item('${itemX}', '${c.id}')`));
check("apply on an undone import returns not-requested", undoneApply.status === "not-requested" && undoneApply.current === "undone", JSON.stringify(undoneApply));
const undoneState = await sql(`select match_status || ',' || coalesce(skip_reason, '') from public.import_items where id = '${itemX}'`);
check("nothing was written for the undone import", (await academics(studentX.id)) === null, undoneState);
check("the item of an undone import is skipped, not sent back to the queue", undoneState === "skipped,The import was undone", undoneState);

// Fix round 1: request is refused while the import is still processing.
const impY = await makeImport(c, { status: "importing" });
const invY = await invite(`proc-${tag}@test.local`);
const itemY = await addItem(impY, { status: "new_invite", invitationId: invY.id, name: "Proc Case" });
await addChange(impY, itemY, { target: "student_academics", field: "act_composite", value: 29, oldValue: null, decision: "auto" });
const studentY = await user("held-proc", "student");
await rest(studentY.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: invY.token });
const reqY = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: itemY, p_decisions: {} });
check("request is refused while the import is still processing", reqY.status >= 400 && /still being processed/.test(JSON.stringify(reqY.body)), `status ${reqY.status} ${JSON.stringify(reqY.body)}`);
const badNull = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: itemY, p_decisions: { x: null } });
check("a null decision is invalid", badNull.status === 400 || badNull.status === 422 || /decision/i.test(JSON.stringify(badNull.body)), JSON.stringify(badNull.body));

// (a) Resend: held data follows the email to the new invitation.
const invA = await invite(`resend-${tag}@test.local`);
const impR = await makeImport(c);
const itemR = await addItem(impR, { status: "new_invite", invitationId: invA.id, name: "Resend Case" });
await addChange(impR, itemR, { target: "student_academics", field: "act_composite", value: 28, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committed' where id = '${impR}'`);
await sql(`update public.invitations set status = 'revoked' where id = '${invA.id}'`);
const invB = await invite(`resend-${tag}@test.local`);
await sql(`select public.expire_import_holds()`);
check("a resend keeps the held data alive", (await sql(`select match_status from public.import_items where id = '${itemR}'`)) === "new_invite");
const studentR = await user("held-resend", "student");
await rest(studentR.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: invB.token });
const rs = await sql(`select match_status || ',' || (invitation_id = '${invB.id}')::text from public.import_items where id = '${itemR}'`);
check("accepting the new invite picks up the held data", rs === "awaiting_counselor,true", rs);

// (b) Legacy row tied to a revoked invite, accepted through a resend.
const invLA = await invite(`legresend-${tag}@test.local`);
const impL = await sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${c.id}', 'old2.csv', 'csv', 'complete') returning id) select id from i`);
await sql(`insert into public.roster_import_rows (import_id, counselor_id, row_number, full_name, email, gpa_weighted, status, invitation_id)
  values ('${impL}', '${c.id}', 2, 'Pat Kim', 'legresend-${tag}@test.local', 3.5, 'invited', '${invLA.id}')`);
await sql(`update public.invitations set status = 'revoked' where id = '${invLA.id}'`);
const invLB = await invite(`legresend-${tag}@test.local`);
const studentL = await user("held-legresend", "student");
await rest(studentL.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: invLB.token });
check("a legacy row from a revoked invite is carried into the queue", (await sql(`select count(*) from public.import_items where student_id = '${studentL.id}' and match_status = 'awaiting_counselor'`)) === "1");

// (c) Omitted decisions take the queue's defaults.
const invD = await invite(`defaults-${tag}@test.local`);
const impD = await makeImport(c);
const itemD = await addItem(impD, { status: "new_invite", invitationId: invD.id, name: "Defaults" });
await addChange(impD, itemD, { target: "student_academics", field: "sat_superscore", value: 1400, oldValue: null, decision: "auto" });
await addChange(impD, itemD, { target: "test_scores", field: "*", op: "insert_row", value: { exam: "AP Chemistry", kind: "ap", score: "4" }, decision: "auto" });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${impD}'`);
await sql(`select public.commit_import('${impD}', '${c.id}')`);
const studentD = await user("held-defaults", "student");
await rest(studentD.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: invD.token });
await sql(`insert into public.student_academics (student_id, sat_superscore) values ('${studentD.id}', 1500)`);
const reqD = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: itemD, p_decisions: {} });
check("omitted decisions are accepted", reqD.status === 204 || reqD.status === 200, JSON.stringify(reqD.body));
const outD = JSON.parse(await sql(`select public.apply_held_item('${itemD}', '${c.id}')`));
check("defaults: the stored SAT is kept, the new row is added", outD.applied === 1 && (await academics(studentD.id)).sat_superscore === 1500
  && (await sql(`select count(*) from public.test_scores where student_id = '${studentD.id}' and source = 'import'`)) === "1", JSON.stringify(outD));

// Final review fix 1: apply compare-and-sets against the value at request time.
const invS = await invite(`stale-${tag}@test.local`);
const impS = await makeImport(c);
const itemS = await addItem(impS, { status: "new_invite", invitationId: invS.id, name: "Stale Case" });
const satS = await addChange(impS, itemS, { target: "student_academics", field: "sat_superscore", value: 1400, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committing', job_actor = '${c.id}' where id = '${impS}'`);
await sql(`select public.commit_import('${impS}', '${c.id}')`);
const studentS = await user("held-stale", "student");
await rest(studentS.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: invS.token });
const reqS = await rest(c.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: itemS, p_decisions: { [satS]: "accept" } });
check("stale case: apply requested while SAT is empty", reqS.status === 204 || reqS.status === 200, `status ${reqS.status} ${JSON.stringify(reqS.body)}`);
await sql(`insert into public.student_academics (student_id, sat_superscore) values ('${studentS.id}', 1500)`);
const outS = JSON.parse(await sql(`select public.apply_held_item('${itemS}', '${c.id}')`));
check("a value set while waiting is kept", (await academics(studentS.id)).sat_superscore === 1500, JSON.stringify(outS));
const satRow = await sql(`select state || '|' || coalesce(error, '') from public.import_changes where id = '${satS}'`);
check("the change is skipped_stale with a plain reason", satRow === "skipped_stale|Changed while waiting; the newer value was kept", satRow);

// Final review fix 2: an unrelated counselor can't request apply.
const invU = await invite(`unrel-${tag}@test.local`);
const impU = await makeImport(c);
const itemU = await addItem(impU, { status: "new_invite", invitationId: invU.id, name: "Unrelated Case" });
await addChange(impU, itemU, { target: "student_academics", field: "act_composite", value: 27, oldValue: null, decision: "auto" });
await sql(`update public.roster_imports set status = 'committed' where id = '${impU}'`);
const studentU = await user("held-unrel", "student");
await rest(studentU.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: invU.token });
const reqU = await rest(otherC.token, "POST", "/rest/v1/rpc/request_held_apply", { p_item: itemU, p_decisions: {} });
check("an unrelated counselor gets 42501 from request_held_apply", reqU.status >= 400 && reqU.body?.code === "42501", `status ${reqU.status} ${JSON.stringify(reqU.body)}`);
check("the item is still waiting", (await sql(`select match_status from public.import_items where id = '${itemU}'`)) === "awaiting_counselor");

// Final review fix 4: without write access the queue hides the stored value.
await sql(`insert into public.student_academics (student_id, act_composite) values ('${studentU.id}', 33)`);
const qOwn = (await rest(c.token, "POST", "/rest/v1/rpc/import_held_queue", {})).body.find((e) => e.itemId === itemU);
check("with write access the queue shows the stored value", qOwn?.changes[0]?.currentValue === 33, JSON.stringify(qOwn?.changes));
await sql(`update public.profiles set counselor_id = '${otherC.id}' where id = '${studentU.id}'`);
const qLost = (await rest(c.token, "POST", "/rest/v1/rpc/import_held_queue", {})).body.find((e) => e.itemId === itemU);
check("without write access currentValue is null and the default is keep_old",
  qLost && qLost.changes[0].currentValue === null && qLost.changes[0].defaultDecision === "keep_old", JSON.stringify(qLost?.changes));
