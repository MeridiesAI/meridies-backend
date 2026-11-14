// Google on the parent path (POST /parent-invites/claim), against the real database and API.
//
// A Google sign-in can't run here, so each "Google user" is what a first OAuth sign-in leaves behind: an auth user
// with a verified address and no role (handle_new_user's student, role_confirmed false), signed in. What must hold:
// the invitation is redeemed only for the invited address (any case), once; a different address is told which one
// (masked), keeps the invitation unused and leaves no stray account; a student's or counselor's account with the
// invited address gets the email-and-password path's refusal and is never touched; a parent signs in later.
import { createHash, randomBytes } from "node:crypto";
import { ANON, API, CLIENT, SB, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const tag = Date.now().toString(36);
const sha = (t) => createHash("sha256").update(t).digest("hex");

/** A first Google sign-in: a verified address, no role picked, signed in. */
async function googleUser(email) {
  const password = `pw-${randomBytes(6).toString("hex")}-Aa1!`;
  const r = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: svc, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: "Google Person" } }) });
  const u = await r.json();
  if (!r.ok) throw new Error("create " + JSON.stringify(u));
  const t = await (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json();
  return { id: u.id, email, token: t.access_token };
}
const claim = async (who, token) => {
  const r = await fetch(`${API}/parent-invites/claim`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${who.token}`, "Content-Type": "application/json" }, body: JSON.stringify(token ? { token } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const users = async (email) => sql(`select count(*) from auth.users where lower(email) = lower('${email}')`);

/** An invitation to `email` for `student` (a parent the counselor switched on; psql can't stamp added_by), with a token we hold. */
async function invite(student, email) {
  const g = await sql(`with g as (insert into public.guardians (student_id, full_name, email, alerts_enabled) values ('${student.id}', 'Parent', '${email}', true) returning id) select id from g`);
  const token = randomBytes(32).toString("base64url");
  await sql(`insert into public.parent_invites (student_id, guardian_id, email, token_hash, via, invited_by) values ('${student.id}', '${g}', lower('${email}'), '${sha(token)}', 'student', '${student.id}')`);
  return token;
}

const c = await user("pg-counselor");
const s = await studentOf(c, "pg-student");

// ---- the invited address: redeemed, any case, once --------------------------------------------------------------
const anaEmail = `ana-${tag}@gmail.test`;
const t1 = await invite(s, anaEmail.toUpperCase());
const ana = await googleUser(anaEmail);
const r1 = await claim(ana, t1);
check("Google user with the invited address: a parent account", r1.status === 200 && r1.body?.outcome === "parent", JSON.stringify(r1.body));
check("…role parent through the redeem function, the proven address, never a student", (await sql(`select role || ':' || role_confirmed || ':' || parent_email || ':' || onboarding_complete from public.profiles where id = '${ana.id}'`)) === `parent:true:${anaEmail}:true`);
check("…the invitation is used", (await sql(`select count(*) from public.parent_invites where token_hash = '${sha(t1)}' and used_by = '${ana.id}'`)) === "1");
const kids = await (await fetch(`${API}/parent/children`, { headers: { ...CLIENT, Authorization: `Bearer ${ana.token}` } })).json();
check("…and the Parent view has the student", kids.children?.some((k) => k.id === s.id), JSON.stringify(kids));
const again = await claim(ana, t1);
check("signing in with Google again: straight to the Parent view (no second redeem)", again.status === 200 && again.body?.outcome === "parent");
const later = await claim(ana, null);
check("a parent signing in later from the login page (no invitation): the Parent view", later.status === 200 && later.body?.outcome === "parent");
const late = await googleUser(`late-${tag}@gmail.test`);
const reuse = await claim(late, t1);
check("the used link with another fresh Google user: refused (single use), and that account taken back", reuse.status === 409 && reuse.body?.code === "invite_used" && reuse.body?.signedOut === true && (await users(late.email)) === "0", JSON.stringify(reuse.body));

// ---- a different Google account: told which address, invitation kept, no stray account ----------------------------
const bobEmail = `bob.parent-${tag}@gmail.test`;
const t2 = await invite(s, bobEmail);
const carol = await googleUser(`carol-${tag}@gmail.test`);
const r2 = await claim(carol, t2);
check("a different Google account: 409 invite_email_mismatch with the masked invited address", r2.status === 409 && r2.body?.code === "invite_email_mismatch" && r2.body?.maskedEmail === "b***@gmail.test" && r2.body?.error === "This invite was sent to b***@gmail.test. Sign in with that Google account, or use email and password.", JSON.stringify(r2.body));
check("…the invitation stays unused", (await sql(`select count(*) from public.parent_invites where token_hash = '${sha(t2)}' and used_at is null and revoked_at is null`)) === "1");
check("…and the account that sign-in just made is gone (never onboarded as a student)", r2.body?.signedOut === true && (await users(carol.email)) === "0" && (await sql(`select count(*) from public.profiles where id = '${carol.id}'`)) === "0");
const bob = await googleUser(bobEmail);
const r3 = await claim(bob, t2);
check("…then the right Google account redeems it", r3.status === 200 && r3.body?.outcome === "parent" && (await sql(`select role from public.profiles where id = '${bob.id}'`)) === "parent");

// an older role-less account (not made by this path) is told, not deleted
const old = await googleUser(`old-${tag}@gmail.test`);
await sql(`update auth.users set created_at = now() - interval '2 days' where id = '${old.id}'`);
const t3 = await invite(s, `dee-${tag}@gmail.test`);
const r4 = await claim(old, t3);
check("an older role-less account with a different address: refused, but not deleted", r4.status === 409 && r4.body?.signedOut === false && (await users(old.email)) === "1");

// ---- a student's or counselor's account with the invited address -------------------------------------------------
const kid = await user("pg-kid", "student");
const t4 = await invite(s, kid.email);
const r5 = await claim(kid, t4);
check("a student's Google account with the invited address: the password path's refusal", r5.status === 409 && r5.body?.code === "email_taken" && r5.body?.error === "That address already has a Meridies account. Sign in with it, or ask for a different email." && r5.body?.signedOut === false, JSON.stringify(r5.body));
check("…the student is untouched and the invitation unused", (await sql(`select role || ':' || role_confirmed from public.profiles where id = '${kid.id}'`)) === "student:true" && (await sql(`select count(*) from public.parent_invites where token_hash = '${sha(t4)}' and used_at is null`)) === "1");
const pending = await user("pg-pending", "counselor", { approved: false });
const t5 = await invite(s, pending.email);
const r6 = await claim(pending, t5);
check("a (pending) counselor's account with the invited address: the same refusal, not account_pending", r6.status === 409 && r6.body?.code === "email_taken" && (await sql(`select role from public.profiles where id = '${pending.id}'`)) === "counselor", JSON.stringify(r6.body));

// ---- no invitation (the login page's Parent card) ---------------------------------------------------------------
const stray = await googleUser(`stray-${tag}@gmail.test`);
const r7 = await claim(stray, null);
check("a new Google user with no invitation: no parent account, and no account left behind", r7.status === 404 && r7.body?.code === "no_parent_account" && (await users(stray.email)) === "0", JSON.stringify(r7.body));
const r8 = await claim(kid, null);
check("a student signing in with Google and the Parent card: told, never deleted", r8.status === 404 && (await sql(`select count(*) from public.profiles where id = '${kid.id}'`)) === "1");

const badShape = await claim(stray, "../../x");
check("a token of the wrong shape is a 400", badShape.status === 400 || badShape.status === 401);

await sql(`delete from public.parent_invites where student_id = '${s.id}'`);
