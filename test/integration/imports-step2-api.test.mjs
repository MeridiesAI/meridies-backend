// Import pipeline step 2, end to end through the API: start, upload, register,
// map (presets: the API runs with IMPORTS_AI=off in CI), override and save a
// layout, stage, review, commit with the invitation count, invitations,
// acceptance into Ready to apply, undo, and the old roster routes staying out
// of the new pipeline's way. Needs IMPORTS_ROLLOUT=all on the API.
import { call, check, rest, sql, user } from "./harness.mjs";
import { academics, addImportFile, enc, q, runSweep, studentOf, waitStatus } from "./imports-helpers.mjs";

const c = await user("imp2-api");
const tag = Date.now();
const mail = (n) => `${n}-${tag}@test.local`;

// The roster: Jane (a student-entered SAT), Robert (goes by Bob), Ann (no email in the file).
const jane = await studentOf(c, "imp2-jane");
const rob = await studentOf(c, "imp2-rob");
const ann = await studentOf(c, "imp2-ann");
await sql(`update public.profiles set full_name = 'Jane Doe', email = '${mail("jane")}' where id = '${jane.id}'`);
await sql(`update public.profiles set full_name = 'Robert Smith', email = '${mail("rob")}' where id = '${rob.id}'`);
await sql(`update public.profiles set full_name = 'Ann Lee', email = '${mail("ann")}', high_school = 'Roosevelt Academy' where id = '${ann.id}'`);
await sql(`insert into public.student_personal_details (student_id, birthday) values ('${ann.id}', '2010-01-01') on conflict (student_id) do update set birthday = excluded.birthday`);
await sql(`insert into public.student_academics (student_id, sat_superscore) values ('${jane.id}', 1400) on conflict (student_id) do update set sat_superscore = 1400`);

const avail = await call(c.token, "GET", "/imports/availability");
check("the Import page is on for this practice", avail.status === 200 && avail.body.enabled && avail.body.available, JSON.stringify(avail.body));

// ---- start ------------------------------------------------------------------
check("starting without the permission box is refused", (await call(c.token, "POST", "/imports", {})).status === 400);
check("permissionConfirmed must be true", (await call(c.token, "POST", "/imports", { permissionConfirmed: false })).status === 400);
const started = await call(c.token, "POST", "/imports", { permissionConfirmed: true });
check("an import starts as a draft", started.status === 201 && started.body.status === "draft", JSON.stringify(started.body));
const imp = started.body.id;
check("who ticked the permission box is recorded", (await sql(`select (permission_confirmed_by = '${c.id}' and permission_confirmed_at is not null and expires_at > now() + interval '6 days')::text from public.roster_imports where id = '${imp}'`)) === "true");

// ---- upload and register ------------------------------------------------------
const csv = [
  "Email,First Name,Last Name,Weighted GPA,GPA,SAT,Birthday,Class of,High School,AP Biology",
  `${mail("jane")},Jane,Doe,4.1,3.8,1450,03/04/2009,2027,Lincoln High School,5`,
  `${mail("rob")},Bob,Smith,3.6,3.4,about 1300,05/06/2009,2027,Lincoln High School,4`,
  `${mail("newkid")},New,Kid,3.2,3.0,1200,07/08/2009,2027,Lincoln High School,3`,
  `${mail("parent")},Mia,Park,3.9,3.7,1500,01/02/2009,2027,Lincoln High School,`,
  `${mail("parent")},Leo,Park,3.1,2.9,1100,01/02/2009,2027,Lincoln High School,`,
  `,Ann,Lee,3.5,3.3,1350,01/01/2010,2028,Roosevelt Academy,`,
].join("\n");
const reg = await addImportFile(c, imp, "fall roster.csv", enc(csv));
check("a CSV registers and is profiled", reg.status === 200 && reg.body.status === "profiled" && reg.body.rowCount === 6, JSON.stringify(reg.body).slice(0, 300));
check("the profile shows headers and shapes, never values", JSON.stringify(reg.body.profile).includes("Weighted GPA") && !JSON.stringify(reg.body.profile).includes("Jane"));
check("the import stays a draft so more files can be added", (await sql(`select status from public.roster_imports where id = '${imp}'`)) === "draft");

const bad = await addImportFile(c, imp, "notes.csv", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 0x00, 0x01]));
check("a file whose bytes aren't a spreadsheet fails by name", bad.status === 200 && bad.body.status === "failed" && bad.body.error === "notes.csv isn't a spreadsheet", JSON.stringify(bad.body));
const dup = await addImportFile(c, imp, "again.csv", enc(csv));
check("the same file twice is refused", dup.body.status === "failed" && /already in the import/.test(dup.body.error), JSON.stringify(dup.body));
const excl = await call(c.token, "DELETE", `/imports/${imp}/files/${bad.body.id}`);
check("Continue without a file", excl.status === 200 && (await sql(`select status from public.import_files where id = '${bad.body.id}'`)) === "excluded");

const other = await user("imp2-other");
check("another counselor can't register into this import", (await call(other.token, "POST", `/imports/${imp}/files`, { fileId: reg.body.id, path: `${c.id}/${imp}/${reg.body.id}-x.csv`, fileName: "x.csv" })).status === 404);
check("another counselor can't read it", (await call(other.token, "GET", `/imports/${imp}`)).status === 404);

// ---- mapping ---------------------------------------------------------------------
const suggested = await call(c.token, "POST", `/imports/${imp}/plan`);
check("the plan comes from presets", suggested.status === 200 && suggested.body.source === "preset", JSON.stringify(suggested.body).slice(0, 300));
const plan = suggested.body.plan;
const mapped = Object.fromEntries(plan.sheets[0].columns.map((col) => [col.index, col.target]));
check("presets mapped email, names, weighted GPA, SAT, birthday, class of, school, AP Biology", ["key", "key", "key", "field", undefined, "field", "field", "key", "key", "score_column"].every((k, i) => (mapped[i]?.kind ?? undefined) === k), JSON.stringify(mapped));
check("the import moved to mapping", (await sql(`select status from public.roster_imports where id = '${imp}'`)) === "mapping");

// The counselor maps "GPA" themselves and remembers the layout.
plan.sheets[0].columns.push({ index: 4, target: { kind: "field", table: "student_academics", field: "gpa_unweighted" }, source: "counselor" });
plan.constants = { gpaScale: "5.0" };
const saved = await call(c.token, "PUT", `/imports/${imp}/plan`, { plan, saveTemplate: { name: "Fall roster" } });
check("the counselor's mapping saves, with the layout", saved.status === 200 && saved.body.problems.length === 0 && saved.body.templateSaved, JSON.stringify(saved.body).slice(0, 300));
check("the layout is a template now", (await sql(`select count(*) from public.import_templates where counselor_id = '${c.id}' and name = 'Fall roster'`)) === "1");
const badPlan = structuredClone(plan);
badPlan.sheets[0].columns.push({ index: 4, target: { kind: "field", table: "student_academics", field: "ssn" }, source: "counselor" });
const refused = await call(c.token, "PUT", `/imports/${imp}/plan`, { plan: badPlan });
check("an invented field is dropped and reported", refused.status === 200 && refused.body.problems.some((p) => /mapped twice|can fill/.test(p)), JSON.stringify(refused.body.problems));
await call(c.token, "PUT", `/imports/${imp}/plan`, { plan });

// ---- staging -------------------------------------------------------------------------
const [s1, s2] = await Promise.all([call(c.token, "POST", `/imports/${imp}/stage`), call(c.token, "POST", `/imports/${imp}/stage`)]);
const okStage = [s1, s2].find((r) => r.status === 200);
check("a double-clicked Match students stages once", [s1.status, s2.status].sort().join(",") === "200,409", `${s1.status},${s2.status}`);
const stats = okStage?.body.stats ?? {};
check("matched: Jane and Bob", stats.matched === 2, JSON.stringify(stats));
check("suggested: Ann (name, birthday and school)", stats.suggested === 1);
check("to invite: the new student only", stats.toInvite === 1);
check("skipped: the siblings on a parent's email", stats.skipped === 2);
check("a cell that won't clean needs a fix", stats.problems === 1);
check("the import is in review", (await sql(`select status from public.roster_imports where id = '${imp}'`)) === "review");
check("a fresh suggestion can't wipe a review", (await call(c.token, "POST", `/imports/${imp}/plan`)).status === 409);

const changes = await call(c.token, "GET", `/imports/${imp}/review?section=changes`);
const janeItem = changes.body.items.find((i) => i.student?.id === jane.id);
const sat = janeItem?.changes.find((ch) => ch.field === "sat_superscore");
check("a value the student entered defaults to keep, riskiest first", sat?.decision === "keep_old" && sat.oldValue === 1400 && sat.oldSource === "student", JSON.stringify(sat));
const gpa = janeItem?.changes.find((ch) => ch.field === "gpa_weighted");
check("an empty field fills automatically", gpa?.decision === "auto");
check("the GPA scale constant is recorded beside the GPA", janeItem?.changes.some((ch) => ch.field === "gpa_scale" && ch.newValue === "5.0"));
check("the AP score is a new row", janeItem?.changes.some((ch) => ch.op === "insert_row" && ch.newValue?.exam === "AP Biology"));
const groups = await call(c.token, "GET", `/imports/${imp}/review?section=groups`);
check("changes are grouped by column", groups.status === 200 && groups.body.groups.some((g) => g.field === "sat_superscore" && g.count === 1), JSON.stringify(groups.body).slice(0, 300));
const sug = await call(c.token, "GET", `/imports/${imp}/review?section=suggested`);
const annItem = sug.body.items[0];
check("Ann is suggested with her name as the candidate", annItem?.candidates?.[0]?.id === ann.id && annItem.candidates[0].name === "Ann Lee", JSON.stringify(annItem).slice(0, 300));
const problems = await call(c.token, "GET", `/imports/${imp}/review?section=problems`);
const fix = problems.body.items[0]?.changes.find((ch) => ch.state === "skipped_invalid");
check("the unreadable SAT is listed with its cell", fix?.sourceRef === "fall roster!F3" && fix?.newValue === "about 1300", JSON.stringify(fix));
const invites = await call(c.token, "GET", `/imports/${imp}/review?section=invites`);
check("the invitation list holds the new student's address", invites.body.items.length === 1 && invites.body.items[0].email === mail("newkid"));

// ---- review decisions ---------------------------------------------------------------
const badFix = await call(c.token, "PATCH", `/imports/${imp}/review`, { fixes: { [fix.id]: "lots" } });
check("a fix that isn't a valid SAT is a 400 naming the field", badFix.status === 400 && /sat superscore/.test(badFix.body.error), JSON.stringify(badFix.body));
const decided = await call(c.token, "PATCH", `/imports/${imp}/review`, {
  fixes: { [fix.id]: "1310" },
  items: { [annItem.itemId]: { action: "confirm", studentId: ann.id } },
  patterns: { [sat.patternKey]: "accept" },
});
check("fix, confirm and a column decision in one request", decided.status === 200 && decided.body.stats.matched === 3 && decided.body.stats.problems === 0, JSON.stringify(decided.body));
check("the column decision accepted the student-entered SAT change", (await sql(`select decision from public.import_changes where id = '${sat.id}'`)) === "accept");
check("confirming Ann read her current values", (await sql(`select count(*) from public.import_changes ch join public.import_items it on it.id = ch.item_id where it.id = '${annItem.itemId}' and ch.field = 'birthday'`)) === "0");
const wrong = await call(c.token, "PATCH", `/imports/${imp}/review`, { items: { [annItem.itemId]: { action: "confirm", studentId: rob.id } } });
check("a second confirm of the same row is refused", wrong.status === 409, `status ${wrong.status}`);

// ---- commit with the invitation count ------------------------------------------------
const noCount = await call(c.token, "POST", `/imports/${imp}/commit`);
check("saving an import that invites needs the count", noCount.status === 409 && noCount.body.code === "confirm-invitations" && noCount.body.count === 1, JSON.stringify(noCount.body));
const wrongCount = await call(c.token, "POST", `/imports/${imp}/commit`, { invitations: 3 });
check("a wrong count is refused", wrongCount.status === 409 && wrongCount.body.count === 1);
const commit = await call(c.token, "POST", `/imports/${imp}/commit`, { invitations: 1 });
check("the right count saves", commit.status === 202, JSON.stringify(commit.body));
const done = await waitStatus(c.token, imp, "committing");
check("the import is saved", done.status === "committed", JSON.stringify(done).slice(0, 300));
const ja = await academics(jane.id);
check("Jane's values are written, the GPA on its own scale", Number(ja.gpa_weighted) === 4.1 && ja.gpa_scale === "5.0" && ja.sat_superscore === 1450, JSON.stringify(ja));
check("Bob's fixed SAT is written", (await academics(rob.id)).sat_superscore === 1310);
check("Jane's AP score is added as an imported row", (await sql(`select count(*) from public.test_scores where student_id = '${jane.id}' and exam = 'AP Biology' and source = 'import'`)) === "1");

// ---- invitations ------------------------------------------------------------------------
const owner = await user("imp2-owner");
const sendA = await call(c.token, "POST", `/imports/${imp}/invitations`);
check("invitations go out after the save", sendA.status === 200 && sendA.body.sent + sendA.body.failed === 1, JSON.stringify(sendA.body));
const linked = await sql(`select it.invitation_id is not null and i.email = '${mail("newkid")}' and i.source = 'roster' from public.import_items it join public.invitations i on i.id = it.invitation_id where it.import_id = '${imp}' and it.match_status = 'new_invite'`);
check("the item is tied to its invitation", linked === "t", linked);
const sendB = await call(c.token, "POST", `/imports/${imp}/invitations`);
check("sending again sends nothing new unless one failed", sendB.status === 200 && (sendA.body.failed === 0 ? sendB.body.sent + sendB.body.failed === 0 : true), JSON.stringify(sendB.body));
check("one live invitation for the address", (await sql(`select count(*) from public.invitations where counselor_id = '${c.id}' and email = '${mail("newkid")}' and status = 'pending'`)) === "1");
check("someone else can't send them", (await call(other.token, "POST", `/imports/${imp}/invitations`)).status === 404);

// The new student accepts: their data waits in Ready to apply, it doesn't attach.
const token = await sql(`select i.token from public.import_items it join public.invitations i on i.id = it.invitation_id where it.import_id = '${imp}' and it.match_status = 'new_invite'`);
const kid = await user("imp2-kid", "student");
await sql(`update public.profiles set full_name = 'New Kid' where id = '${kid.id}'`);
const acc = await rest(kid.token, "POST", "/rest/v1/rpc/accept_invitation", { p_token: token });
check("the invitation is accepted", acc.status === 200, JSON.stringify(acc.body));
const held = await call(c.token, "GET", "/imports/held");
const entry = (held.body ?? []).find((e) => e.studentId === kid.id);
check("the new student's data is in Ready to apply", entry && entry.importId === imp && entry.nameMismatch === false, JSON.stringify(entry).slice(0, 300));
check("nothing attached on acceptance", (await academics(kid.id)) === null);
check("held entries say the student's GPA scale (unknown until set)", entry && "gpaScale" in entry);

// History.
const list = await call(c.token, "GET", "/imports");
const row = list.body.imports?.find((i) => i.id === imp);
check("history lists the import with its counts", row && row.status === "committed" && row.stats.matched === 3 && row.invitations.joined === 1, JSON.stringify(row).slice(0, 400));
check("history lists the saved layout", list.body.templates.some((t) => t.name === "Fall roster"));

// ---- undo ------------------------------------------------------------------------------------
const undo = await call(c.token, "POST", `/imports/${imp}/undo`);
check("undo starts", undo.status === 202);
const undone = await waitStatus(c.token, imp, "undoing");
check("undo reverts what nobody edited since", undone.status === "undone" && undone.jobResult.kept === 0, JSON.stringify(undone.jobResult));
check("Jane's SAT is back to what she entered", (await academics(jane.id)).sat_superscore === 1400);
check("the waiting data left Ready to apply", !((await call(c.token, "GET", "/imports/held")).body ?? []).some((e) => e.studentId === kid.id));

// ---- discard and the old roster routes --------------------------------------------------
const draft = (await call(c.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
const legacyList = await call(c.token, "GET", "/roster/imports");
check("the old roster list never shows the Import page's imports", legacyList.status === 200 && !legacyList.body.some((r) => r.id === imp || r.id === draft), JSON.stringify(legacyList.body).slice(0, 200));
check("the old roster routes can't delete one", (await call(c.token, "DELETE", `/roster/imports/${draft}`)).status === 404);
check("nor send one", (await call(c.token, "POST", `/roster/imports/${draft}/send`)).status === 404);
const legacy = await call(c.token, "POST", "/roster/imports", { filename: "old.csv", mapping: { Email: "email" }, rows: [{ rowNumber: 1, fullName: "Old Flow", email: mail("oldflow") }] });
check("the old roster flow still creates its import", legacy.status === 201 && legacy.body.rows.length === 1, JSON.stringify(legacy.body).slice(0, 200));
check("and still lists it", (await call(c.token, "GET", "/roster/imports")).body.some((r) => r.id === legacy.body.id));
check("the Import page never lists the old flow's import", !(await call(c.token, "GET", "/imports")).body.imports.some((i) => i.id === legacy.body.id));
const disc = await call(c.token, "DELETE", `/imports/${draft}`);
check("a draft can be discarded", disc.status === 200 && (await sql(`select status from public.roster_imports where id = '${draft}'`)) === "expired");
check("a saved import can't be discarded", (await call(c.token, "DELETE", `/imports/${imp}`)).status === 409);
const tpl = await sql(`select id from public.import_templates where counselor_id = '${c.id}' limit 1`);
check("another counselor can't delete the layout", (await call(other.token, "DELETE", `/imports/templates/${tpl}`)).status === 404);
check("its owner can", (await call(c.token, "DELETE", `/imports/templates/${tpl}`)).status === 200);

// ---- the sweep: retention ---------------------------------------------------------------------
const sweep = await runSweep();
check("the sweep runs retention", sweep.status === 200 && sweep.body.retention?.ran === true, JSON.stringify(sweep.body));
check("raw files of a saved import are deleted", (await sql(`select count(*) from public.import_files where import_id = '${imp}' and deleted_at is null`)) === "0");
check("and gone from the bucket", (await sql(`select count(*) from storage.objects where bucket_id = 'imports' and name like '${q(c.id)}/${imp}/%'`)) === "0");
check("masked samples are wiped after commit", (await sql(`select count(*) from public.import_files where import_id = '${imp}' and profile is not null`)) === "0");
