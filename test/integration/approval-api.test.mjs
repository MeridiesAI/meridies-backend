// Counselor approval gate: what the API lets a pending or revoked counselor do.
import { ANON, SB, check, sql, user, call } from "./harness.mjs";

const isPending = (r) => r.status === 403 && r.body?.code === "account_pending";

const pending = await user("api-pending", "counselor", { approved: false });
const approved = await user("api-approved");
const student = await user("api-student", "student");

// ---- Allowed while pending ---------------------------------------------------
const me = await call(pending.token, "GET", "/auth/me");
check("pending: reads their own account", me.status === 200 && me.body.accessStatus === "pending", JSON.stringify(me.body));
const patch = await call(pending.token, "PATCH", "/auth/me", { profile: { firmName: "Rivera Advising", firmSize: "2-5" }, onboardingStep: 1 });
check("pending: edits their own practice details", patch.status === 200 && patch.body.profile?.firmName === "Rivera Advising", JSON.stringify(patch.body));
const exp = await call(pending.token, "GET", "/account/export");
check("pending: exports their own data", exp.status === 200, `status ${exp.status}`);
const join = await call(pending.token, "POST", "/firms/join", { token: "not-a-real-token-0123456789" });
check("pending: may attempt a firm join (refused for the token, not for the account)", join.status !== 200 && join.body?.code !== "account_pending", JSON.stringify(join.body));
const del = await call(pending.token, "DELETE", "/account", { confirm: "no" });
check("pending: reaches account deletion (refused for the phrase, not for the account)", del.status === 400, JSON.stringify(del.body));

// ---- Everything else ----------------------------------------------------------
for (const [method, path, body] of [
  ["POST", "/invites", { email: "someone@test.local" }],
  ["GET", "/blasts"],
  ["GET", "/work-items"],
  ["GET", "/firms/mine"],
  ["POST", "/firms", { name: "Not yet" }],
  ["POST", "/firms/mine/invites", { email: "colleague@test.local" }],
  ["GET", `/account/students/${student.id}/export`],
  ["POST", "/accountability/sweep", {}],
]) {
  const r = await call(pending.token, method, path, body);
  check(`pending: ${method} ${path} is refused as account_pending`, isPending(r), `status ${r.status} ${JSON.stringify(r.body)}`);
}
check("nothing was sent or created", Number(await sql(`select count(*) from public.invitations where counselor_id = '${pending.id}'`)) === 0);

// ---- Controls -------------------------------------------------------------------
const meA = await call(approved.token, "GET", "/auth/me");
check("approved: accessStatus is approved", meA.body.accessStatus === "approved");
check("approved: counselor routes work", (await call(approved.token, "GET", "/work-items")).status === 200);
const meS = await call(student.token, "GET", "/auth/me");
check("student: accessStatus is null and the gate does not apply", meS.status === 200 && meS.body.accessStatus === null);

// ---- Revoke holds from the very next request, same session token ------------------
const rev = await user("api-revoked");
check("before the revoke the token works", (await call(rev.token, "GET", "/work-items")).status === 200);
await sql(`select private.revoke_counselor_access('${rev.id}')`);
check("a revoked counselor is blocked on the next request", isPending(await call(rev.token, "GET", "/work-items")));
check("...and still reads their own account", (await call(rev.token, "GET", "/auth/me")).body.accessStatus === "pending");

// ---- Approval is permanent: signing in again later needs nothing more ---------------
const again = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: approved.email, password: approved.password }),
});
const fresh = (await again.json()).access_token;
check("a fresh sign-in is a different session", typeof fresh === "string" && fresh !== approved.token);
check("an approved counselor who signs in again needs no new approval",
  (await call(fresh, "GET", "/work-items")).status === 200 && (await call(fresh, "GET", "/auth/me")).body.accessStatus === "approved");
