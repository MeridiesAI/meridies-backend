// Import pipeline step 2: who may do what. A firm admin may stage, decide and
// save a member's import but matching stays on the uploader's own students and
// invitations go out in the uploader's name only; another member, a student
// and a pending counselor get nothing; worker functions aren't callable by the
// browser; the bucket takes uploads only into the uploader's own draft.
import { randomUUID } from "node:crypto";
import { call, check, rest, sql, user } from "./harness.mjs";
import { addImportFile, enc, firmWith, stagedImport, studentOf, waitStatus, workerSql } from "./imports-helpers.mjs";

const tag = Date.now();
const mail = (n) => `${n}-${tag}@test.local`;

const owner = await user("imp2-rls-owner");
const member = await user("imp2-rls-member");
const peer = await user("imp2-rls-peer");
await firmWith(owner, [member, peer]);

const mine = await studentOf(member, "imp2-rls-mine");
const peers = await studentOf(peer, "imp2-rls-peers");
await sql(`update public.profiles set full_name = 'Mina Cho', email = '${mail("mina")}' where id = '${mine.id}'`);
await sql(`update public.profiles set full_name = 'Pablo Ruiz', email = '${mail("pablo")}' where id = '${peers.id}'`);

const csv = ["Email,Name,SAT", `${mail("mina")},Mina Cho,1400`, `${mail("pablo")},Pablo Ruiz,1300`].join("\n");

// The admin stages the member's import: only the member's students match.
const { id: imp, stage } = await stagedImport(member, csv, { stager: owner });
check("a firm admin can stage a member's import", stage.status === 200, JSON.stringify(stage.body));
check("matching uses the uploader's roster, not the admin's wider reach", stage.body.stats?.matched === 1 && stage.body.stats?.toInvite === 1, JSON.stringify(stage.body.stats));
const matchedTo = await sql(`select student_id from public.import_items where import_id = '${imp}' and match_status = 'matched_email'`);
check("the match is the member's own student", matchedTo === mine.id);

check("a member who isn't the uploader can't see it", (await call(peer.token, "GET", `/imports/${imp}`)).status === 404);
check("nor read its review", (await call(peer.token, "GET", `/imports/${imp}/review?section=changes`)).status === 404);
check("nor decide anything", (await call(peer.token, "PATCH", `/imports/${imp}/review`, { patterns: { x: "accept" } })).status === 404);
const peerRpc = await rest(peer.token, "POST", "/rest/v1/rpc/import_review_page", { p_import: imp, p_section: "changes", p_offset: 0, p_limit: 10 });
check("nor read it through the database", peerRpc.status !== 200 && peerRpc.body?.code === "42501", JSON.stringify(peerRpc.body));
check("the peer's history doesn't list it", !(await call(peer.token, "GET", "/imports")).body.imports.some((i) => i.id === imp));
check("the admin's history does", (await call(owner.token, "GET", "/imports")).body.imports.some((i) => i.id === imp && i.mine === false));

const decide = await call(owner.token, "PATCH", `/imports/${imp}/review`, { patterns: {} });
check("the admin can decide", decide.status === 200);
const commit = await call(owner.token, "POST", `/imports/${imp}/commit`, { invitations: 1 });
check("the admin can save it", commit.status === 202, JSON.stringify(commit.body));
check("it saves", (await waitStatus(owner.token, imp, "committing")).status === "committed");
const adminSend = await call(owner.token, "POST", `/imports/${imp}/invitations`);
check("invitations go out in the uploader's name only", adminSend.status === 403 && /uploaded this import/.test(adminSend.body.error), JSON.stringify(adminSend.body));
check("nothing was claimed or sent for the admin", (await sql(`select invite_state from public.import_items where import_id = '${imp}' and match_status = 'new_invite'`)) === "unsent");
const adminClaim = await rest(owner.token, "POST", "/rest/v1/rpc/import_claim_invites", { p_import: imp, p_limit: 5 });
check("the claim refuses the admin in the database too", adminClaim.status !== 200 && adminClaim.body?.code === "MI002", JSON.stringify(adminClaim.body));

// ---- students and pending counselors ----------------------------------------------------
const student = await user("imp2-rls-student", "student");
check("a student can't start an import", (await call(student.token, "POST", "/imports", { permissionConfirmed: true })).status === 403);
const sStart = await rest(student.token, "POST", "/rest/v1/rpc/start_import", { p_permission: true });
check("nor through the database", sStart.status !== 200 && sStart.body?.code === "42501", JSON.stringify(sStart.body));
const sReview = await rest(student.token, "POST", "/rest/v1/rpc/import_review_update", { p_import: imp, p_body: {} });
check("a student can't decide a review", sReview.status !== 200 && sReview.body?.code === "42501");

const pending = await user("imp2-rls-pending", "counselor", { approved: false });
const pStart = await call(pending.token, "POST", "/imports", { permissionConfirmed: true });
check("a pending counselor gets account_pending", pStart.status === 403 && pStart.body.code === "account_pending", JSON.stringify(pStart.body));
const pRpc = await rest(pending.token, "POST", "/rest/v1/rpc/start_import", { p_permission: true });
check("and the database refuses them too", pRpc.status !== 200 && pRpc.body?.code === "42501", JSON.stringify(pRpc.body));
const pTpl = await rest(pending.token, "POST", "/rest/v1/rpc/delete_import_template", { p_template: randomUUID() });
check("a pending counselor can't touch templates", pTpl.status !== 200);
// A revoked counselor's request can't save a layout through the worker either.
let workerError = "";
try {
  await workerSql(`select public.import_save_template('${pending.id}', 'x', 'unknown', '0123456789abcdef', '{}'::jsonb)`);
} catch (e) {
  workerError = String(e.stderr ?? e.message);
}
check("import_save_template asks the approval gate itself", /approved counselor/.test(workerError) && (await sql(`select count(*) from public.import_templates where counselor_id = '${pending.id}'`)) === "0", workerError.slice(0, 200));
const okTpl = await workerSql(`select public.import_save_template('${member.id}', 'Mine', 'unknown', '0123456789abcdef', '{}'::jsonb) is not null`);
check("and saves for an approved counselor", okTpl === "t");

// ---- worker functions aren't the browser's ---------------------------------------------------
for (const [fn, args] of [
  ["stage_import", { p_import: imp, p_actor: member.id, p_payload: { items: [], changes: [] } }],
  ["import_register_file", { p_import: imp, p_actor: member.id, p_file: {} }],
  ["import_set_plan", { p_import: imp, p_actor: member.id, p_plan: {}, p_source_system: "unknown", p_template: null }],
  ["import_roster_for_matching", { p_import: imp, p_actor: member.id }],
  ["import_save_template", { p_actor: member.id, p_name: "x", p_source_system: "unknown", p_fingerprint: "0123456789abcdef", p_plan: {} }],
  ["import_add_ai_spend", { p_import: imp, p_actor: member.id, p_cents: -500 }],
  ["import_retention", {}],
  ["import_orphan_objects", { p_limit: 10 }],
]) {
  const r = await rest(member.token, "POST", `/rest/v1/rpc/${fn}`, args);
  check(`${fn} isn't callable by the browser`, r.status !== 200 && r.status !== 204, `status ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}
for (const t of ["import_items", "import_changes", "import_files"]) {
  const r = await rest(member.token, "POST", `/rest/v1/${t}`, { import_id: imp });
  check(`the browser can't write ${t}`, r.status === 401 || r.status === 403, `status ${r.status}`);
}

// ---- the bucket ------------------------------------------------------------------------------
const draft = (await call(member.token, "POST", "/imports", { permissionConfirmed: true })).body.id;
const upload = (path) =>
  rest(member.token, "POST", `/storage/v1/object/imports/${path}`, enc("Email,Name\na@b.co,A B\n"), { "Content-Type": "text/csv" });
check("the uploader can put a file in their own draft", (await upload(`${member.id}/${draft}/${randomUUID()}-a.csv`)).status === 200);
check("not under someone else's folder", (await upload(`${owner.id}/${draft}/${randomUUID()}-a.csv`)).status !== 200);
check("not into a saved import", (await upload(`${member.id}/${imp}/${randomUUID()}-a.csv`)).status !== 200);
check("not into another counselor's draft", (await rest(peer.token, "POST", `/storage/v1/object/imports/${peer.id}/${draft}/${randomUUID()}-a.csv`, enc("x"), { "Content-Type": "text/csv" })).status !== 200);
const saved = await call(member.token, "POST", `/imports/${imp}/files/upload-url`, { fileName: "late.csv", mimeType: "text/csv", sizeBytes: 10 });
check("no upload URL for a saved import", saved.status === 409, `status ${saved.status}`);
const adminUrl = await call(owner.token, "POST", `/imports/${draft}/files/upload-url`, { fileName: "a.csv", mimeType: "text/csv", sizeBytes: 10 });
check("only the uploader adds files, even for an admin", adminUrl.status === 409, `status ${adminUrl.status}`);
const forged = await addImportFile(member, draft, "a.csv", enc("Email,Name\na@b.co,A B\n"));
check("a registered file works in the uploader's draft", forged.body.status === "profiled", JSON.stringify(forged.body).slice(0, 200));
const otherPath = await call(member.token, "POST", `/imports/${draft}/files`, { fileId: randomUUID(), path: `${member.id}/${imp}/x-a.csv`, fileName: "a.csv" });
check("a path from another import is refused", otherPath.status === 400);
