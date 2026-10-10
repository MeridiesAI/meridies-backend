// Counselor approval gate: what the database enforces by itself (no API involved).
import { createHash } from "node:crypto";
import { check, sql, user, rest } from "./harness.mjs";
import { firmWith, makeImport } from "./imports-helpers.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const rpc = (token, fn, args) => rest(token, "POST", `/rest/v1/rpc/${fn}`, args);
const approvedAt = (u) => sql(`select coalesce(counselor_approved_at::text, 'none') from public.profiles where id = '${u.id}'`);
const via = (u) => sql(`select coalesce(counselor_approved_via, 'none') from public.profiles where id = '${u.id}'`);
const revoke = (u) => sql(`select private.revoke_counselor_access('${u.id}')`);
const tag = `${Date.now()}`;

const approved = await user("gate-approved");
const pending = await user("gate-pending", "counselor", { approved: false });

// ---- The fact itself ---------------------------------------------------------
check("a new counselor starts pending", (await approvedAt(pending)) === "none");
check("is_counselor is false while pending", (await sql(`select private.is_counselor('${pending.id}')`)) === "f");
check("is_counselor is true once approved", (await sql(`select private.is_counselor('${approved.id}')`)) === "t");
const self = await rest(pending.token, "PATCH", `/rest/v1/profiles?id=eq.${pending.id}`, { counselor_approved_at: new Date().toISOString() });
check("a user cannot approve themselves", self.status >= 400 && (await approvedAt(pending)) === "none", `status ${self.status}`);

// ---- A pending counselor writing straight to Supabase ------------------------
const inv = await rest(pending.token, "POST", "/rest/v1/invitations", { counselor_id: pending.id, email: `x-${tag}@test.local`, token: `gate-direct-${tag}` });
check("pending: cannot insert an invitation", inv.status >= 400, `status ${inv.status}`);
const firmRow = await rest(pending.token, "POST", "/rest/v1/firms", { name: "Nope", owner_id: pending.id });
check("pending: cannot insert a firm", firmRow.status >= 400, `status ${firmRow.status}`);
const cf = await rpc(pending.token, "create_firm", { p_name: "Nope" });
check("pending: create_firm is refused", cf.status >= 400, `status ${cf.status}`);
const cfOk = await rpc(approved.token, "create_firm", { p_name: `Approved firm ${tag}` });
check("approved: create_firm works", cfOk.status === 200, JSON.stringify(cfOk.body));
const approvedFirm = String(cfOk.body);
await sql(`update public.firms set seats = 10 where id = '${approvedFirm}'`);
const fi = await rest(pending.token, "POST", "/rest/v1/firm_invitations", { firm_id: approvedFirm, email: `y-${tag}@test.local`, token_hash: sha(`y-${tag}`), invited_by: pending.id });
check("pending: cannot insert a firm invitation", fi.status >= 400, `status ${fi.status}`);
const ri = await rest(pending.token, "POST", "/rest/v1/roster_imports", { counselor_id: pending.id, filename: "x.csv", source: "csv" });
check("pending: cannot insert an import", ri.status >= 400, `status ${ri.status}`);
const pendingImport = await makeImport(pending);
const rc = await rpc(pending.token, "request_import_commit", { p_import: pendingImport });
check("pending: cannot request an import job", rc.status >= 400, `status ${rc.status}`);

// ---- Student invitations ------------------------------------------------------
const student = await user("gate-student", "student");
const tok = `gate-inv-${tag}`;
await sql(`insert into public.invitations (counselor_id, email, token) values ('${pending.id}', '${student.email}', '${tok}')`);
const prev = await rpc(student.token, "invitation_preview", { p_token: tok });
check("a pending counselor's invitation previews as not valid", prev.status === 200 && prev.body?.[0]?.valid === false, JSON.stringify(prev.body));
const acc = await rpc(student.token, "accept_invitation", { p_token: tok });
check("a student can't accept an invitation from a pending counselor", acc.status >= 400 && /not available/i.test(JSON.stringify(acc.body)), JSON.stringify(acc.body));
check("...and stays unlinked", (await sql(`select coalesce(counselor_id::text, 'none') from public.profiles where id = '${student.id}'`)) === "none");

// ---- Revoke ---------------------------------------------------------------------
const rev = await user("gate-revoked");
const student2 = await user("gate-student2", "student");
const tok2 = `gate-inv2-${tag}`;
await sql(`insert into public.invitations (counselor_id, email, token) values ('${rev.id}', '${student2.email}', '${tok2}')`);
const revImport = await makeImport(rev, { status: "committing" });
await sql(`update public.roster_imports set job_actor = '${rev.id}', job_requested_at = now() where id = '${revImport}'`);
await revoke(rev);
check("revoke clears the approval", (await approvedAt(rev)) === "none");
check("revoke records when", (await sql(`select counselor_revoked_at is not null from public.profiles where id = '${rev.id}'`)) === "t");
check("revoke flips their pending invitations to revoked", (await sql(`select status from public.invitations where token = '${tok2}'`)) === "revoked");
const acc2 = await rpc(student2.token, "accept_invitation", { p_token: tok2 });
check("a student can't accept an invitation from a revoked counselor", acc2.status >= 400, JSON.stringify(acc2.body));
check("revoke writes an audit row", Number(await sql(`select count(*) from public.audit_log where action = 'counselor.access.revoked' and entity_id = '${rev.id}'`)) === 1);
for (const role of ["anon", "authenticated"]) {
  check(`${role} cannot execute revoke_counselor_access`, (await sql(`select has_function_privilege('${role}', 'private.revoke_counselor_access(uuid)', 'execute')`)) === "f");
  check(`${role} cannot execute approve_counselor_by_token`, (await sql(`select has_function_privilege('${role}', 'public.approve_counselor_by_token(text)', 'execute')`)) === "f");
}
const job = JSON.parse(await sql(`select public.commit_import('${revImport}', '${rev.id}')`));
check("a queued import job from a revoked counselor doesn't run", job.status === "review", JSON.stringify(job));
check("...and says why", /no longer have access/i.test(await sql(`select job_error::text from public.roster_imports where id = '${revImport}'`)));

// ---- Firm invitations: joining is open, approval is not --------------------------
async function firmInvite(firmId, inviter, invitee) {
  const token = `gate-firm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await sql(`insert into public.firm_invitations (firm_id, email, token_hash, invited_by) values ('${firmId}', '${invitee.email}', '${sha(token)}', '${inviter.id}')`);
  return token;
}
const join = (u, token) => rpc(u.token, "accept_firm_invitation", { p_token: token });

const j1 = await user("gate-join-owner", "counselor", { approved: false });
const r1 = await join(j1, await firmInvite(approvedFirm, approved, j1));
check("invited by an approved owner: joins", r1.status === 200, JSON.stringify(r1.body));
check("...and is approved through the firm", (await approvedAt(j1)) !== "none" && (await via(j1)) === "firm_invite");

const member = await user("gate-plain-member");
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${approvedFirm}', '${member.id}', 'counselor')`);
await sql(`update public.profiles set firm_id = '${approvedFirm}' where id = '${member.id}'`);
const j2 = await user("gate-join-member", "counselor", { approved: false });
const r2 = await join(j2, await firmInvite(approvedFirm, member, j2));
check("invited by a member who isn't an owner or admin: joins", r2.status === 200, JSON.stringify(r2.body));
check("...but is not auto-approved", (await approvedAt(j2)) === "none");

const admin = await user("gate-admin");
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${approvedFirm}', '${admin.id}', 'admin')`);
await sql(`update public.profiles set firm_id = '${approvedFirm}' where id = '${admin.id}'`);
const j3 = await user("gate-join-demoted", "counselor", { approved: false });
const t3 = await firmInvite(approvedFirm, admin, j3);
await sql(`update public.firm_members set seat_role = 'counselor' where firm_id = '${approvedFirm}' and profile_id = '${admin.id}'`);
const r3 = await join(j3, t3);
check("inviter demoted after sending: joins, not auto-approved", r3.status === 200 && (await approvedAt(j3)) === "none", JSON.stringify(r3.body));

const admin2 = await user("gate-admin2");
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${approvedFirm}', '${admin2.id}', 'admin')`);
await sql(`update public.profiles set firm_id = '${approvedFirm}' where id = '${admin2.id}'`);
const j4 = await user("gate-join-revoked-inviter", "counselor", { approved: false });
const t4 = await firmInvite(approvedFirm, admin2, j4);
await revoke(admin2);
const r4 = await join(j4, t4);
check("inviter revoked after sending: the invitation is dead", r4.status >= 400 && (await approvedAt(j4)) === "none", JSON.stringify(r4.body));

const pendingOwner = await user("gate-pending-owner", "counselor", { approved: false });
const pendingFirm = await firmWith(pendingOwner);
await sql(`update public.firms set seats = 10 where id = '${pendingFirm}'`);
const j5 = await user("gate-join-pending-firm", "counselor", { approved: false });
const r5 = await join(j5, await firmInvite(pendingFirm, pendingOwner, j5));
check("invited by a pending owner: joins on the role-only check, still pending", r5.status === 200 && (await approvedAt(j5)) === "none", JSON.stringify(r5.body));

const j6 = await user("gate-join-was-revoked");
await revoke(j6);
const r6 = await join(j6, await firmInvite(approvedFirm, approved, j6));
check("a counselor Meridies revoked is not re-approved by a firm invitation", r6.status === 200 && (await approvedAt(j6)) === "none", JSON.stringify(r6.body));

await revoke(approved);
check("revoking an owner leaves members they approved still approved", (await approvedAt(j1)) !== "none");

// ---- Approve by token --------------------------------------------------------------
const p2 = await user("gate-token", "counselor", { approved: false });
const good = `good-${tag}`;
await sql(`insert into public.counselor_access_requests (profile_id, token_hash) values ('${p2.id}', '${sha(good)}')`);
let dup = false;
try { await sql(`insert into public.counselor_access_requests (profile_id, token_hash) values ('${p2.id}', '${sha("second-" + tag)}')`); } catch { dup = true; }
check("one unused request per account", dup);
check("an unknown token approves nobody", (await sql(`select count(*) from public.approve_counselor_by_token('${sha("nope-" + tag)}')`)) === "0");
check("a good token approves", (await sql(`select count(*) from public.approve_counselor_by_token('${sha(good)}')`)) === "1" && (await via(p2)) === "team");
check("a token works once", (await sql(`select count(*) from public.approve_counselor_by_token('${sha(good)}')`)) === "0");
const p3 = await user("gate-expired", "counselor", { approved: false });
await sql(`insert into public.counselor_access_requests (profile_id, token_hash, expires_at) values ('${p3.id}', '${sha("old-" + tag)}', now() - interval '1 minute')`);
check("an expired token approves nobody", (await sql(`select count(*) from public.approve_counselor_by_token('${sha("old-" + tag)}')`)) === "0" && (await approvedAt(p3)) === "none");
