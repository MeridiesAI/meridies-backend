// Parent accounts (20261123000002) against the real database, API and Mailpit, as the people involved: a student who
// adds a parent, the parent who signs up from the email, the counselor who switches things off, invites and removes,
// and an attacker trying the same paths straight through PostgREST.
//
// MAILPIT_URL: where the API's DEV_MAIL_URL delivers.
import { createHash } from "node:crypto";
import { ANON, API, CLIENT, SB, call, check, rest, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = Date.now().toString(36);
const sha = (t) => createHash("sha256").update(t).digest("hex");
const pub = async (path, body) => {
  const r = await fetch(API + path, { method: "POST", headers: { ...CLIENT, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const signIn = async (email, password) => {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return (await r.json()).access_token;
};
async function mailTo(address, subjectPart, wait = 8000) {
  const until = Date.now() + wait;
  while (Date.now() < until) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const list = ((await r.json()).messages ?? []).filter((m) => !subjectPart || String(m.Subject).includes(subjectPart));
    if (list.length) return Promise.all(list.map(async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()));
    await new Promise((res) => setTimeout(res, 250));
  }
  return [];
}
const tokenIn = (msg) => /\/join-parent\/([A-Za-z0-9_-]{43})/.exec(String(msg?.HTML ?? "") + String(msg?.Text ?? ""))?.[1] ?? null;

const c = await user("pa-counselor");
const c2 = await user("pa-counselor2");
const s = await studentOf(c, "pa-student");
const sib = await studentOf(c2, "pa-sibling"); // a second child, with another counselor
const stranger = await studentOf(c, "pa-stranger"); // same counselor, not this parent's child
await sql(`update public.profiles set full_name = 'Maya Lee', timezone = 'America/New_York' where id = '${s.id}'`);
await sql(`update public.profiles set full_name = 'Sam Lee' where id = '${sib.id}'`);
await sql(`update public.profiles set full_name = 'Jordan Park' where id = '${c.id}'`);
const parentEmail = `ana-${tag}@family.test`;
const password = `Pw-${tag}-long-enough`;

// What the counselor has on Maya: a task, a college, an essay with words that must never reach a parent, a meeting.
await sql(`insert into public.deliverables (student_id, kind, title, status, due_date, visible_to_student) values
  ('${s.id}', 'custom', 'Request transcript ${tag}', 'in-progress', current_date - 3, true),
  ('${s.id}', 'custom', 'Hidden counselor task ${tag}', 'not-started', current_date + 3, false)`);
await sql(`insert into public.student_colleges (student_id, name, round, status, deadline, notes) values ('${s.id}', 'Brown University', 'ED', 'in-progress', current_date + 20, 'COUNSELOR NOTE ${tag}')`);
await sql(`insert into public.essays (student_id, title, prompt, body, school, word_count, word_limit, status, essay_kind) values ('${s.id}', 'SECRET TITLE ${tag}', 'SECRET PROMPT', 'SECRET ESSAY TEXT ${tag}', 'Brown University', 4, 250, 'drafting', 'supplement')`);
await sql(`insert into public.meetings (student_id, counselor_id, title, mode, starts_at, ends_at, status, guardians_invited, join_url) values
  ('${s.id}', '${c.id}', 'Private planning ${tag}', 'google-meet', now() + interval '2 days', now() + interval '2 days 30 minutes', 'scheduled', false, 'https://meet.example/abc'),
  ('${s.id}', '${c.id}', 'Family meeting ${tag}', 'in-person', now() + interval '3 days', now() + interval '3 days 1 hour', 'scheduled', true, null)`);
await sql(`insert into public.student_private_notes (student_id, updated_by, body) values ('${s.id}', '${c.id}', 'PRIVATE NOTE ${tag}') on conflict do nothing`);

// ---- the student adds a parent: the email invites them ----------------------------------------------------------
const add = await call(s.token, "POST", "/me/guardians", { name: "Ana Lee", relationship: "Mother", email: parentEmail });
const gid = add.body?.guardian?.id;
check("student adds a parent (notice sent)", add.status === 201 && add.body?.notice === "sent", `${add.status} ${JSON.stringify(add.body).slice(0, 160)}`);
const [notice] = await mailTo(parentEmail, "added you as a parent");
const token = tokenIn(notice);
check("the email has a Create your parent account button with a tokenized link", Boolean(token) && /Create your parent account/.test(notice?.HTML ?? ""), notice?.Subject);
check("…and no longer says there's nothing to sign up for", !/nothing to sign up for/i.test(`${notice?.HTML}${notice?.Text}`));
check("the delivery record keeps the email without its link", (await sql(`select count(*) from public.message_deliveries where student_id = '${s.id}' and template = 'parent-added' and body like '%join-parent%'`)) === "0");
check("only the token's hash is stored, tied to the guardian row and the student", (await sql(`select count(*) from public.parent_invites where token_hash = '${sha(token ?? "")}' and guardian_id = '${gid}' and student_id = '${s.id}' and email = '${parentEmail}' and expires_at > now() + interval '29 days'`)) === "1");
check("no table holds the token itself", (await sql(`select count(*) from public.parent_invites where token_hash = '${token}'`)) === "0");

// ---- the join page ---------------------------------------------------------------------------------------------
const pv = await pub("/parent-invites/preview", { token });
check("preview: valid, for the invited address, from Maya", pv.status === 200 && pv.body?.valid === true && pv.body?.email === parentEmail && pv.body?.studentFirstName === "Maya" && pv.body?.hasAccount === false, JSON.stringify(pv.body));
const junk = await pub("/parent-invites/preview", { token: "x".repeat(43) });
check("preview of a made-up token: not valid, nothing named", junk.status === 200 && junk.body?.valid === false && junk.body?.email === null, JSON.stringify(junk.body));
const badShape = await pub("/parent-invites/preview", { token: "../../etc" });
check("a token of the wrong shape is a 400", badShape.status === 400);
const weak = await pub("/parent-invites/accept", { token, fullName: "Ana Lee", password: "short" });
check("a short password is refused", weak.status === 400, JSON.stringify(weak.body));
const accepted = await pub("/parent-invites/accept", { token, fullName: "Ana Lee", password });
check("accept: the parent account is made for the invited address", accepted.status === 201 && accepted.body?.email === parentEmail, JSON.stringify(accepted.body));
check("…a profile with role parent, its proven address, onboarding done", (await sql(`select role || ':' || parent_email || ':' || onboarding_complete || ':' || role_confirmed from public.profiles where email = '${parentEmail}'`)) === `parent:${parentEmail}:true:true`);
const again = await pub("/parent-invites/accept", { token, fullName: "Someone", password: "another-password-1" });
check("the link works once", again.status === 409, JSON.stringify(again.body));
const pvUsed = await pub("/parent-invites/preview", { token });
check("…and previews as used, with an account to sign in to", pvUsed.body?.valid === false && pvUsed.body?.reason === "used" && pvUsed.body?.hasAccount === true, JSON.stringify(pvUsed.body));

const pTok = await signIn(parentEmail, password);
const pid = await sql(`select id from public.profiles where email = '${parentEmail}'`);
const me = await call(pTok, "GET", "/auth/me");
check("the parent signs in: /auth/me says parent", me.status === 200 && me.body?.role === "parent" && me.body?.onboardingComplete === true, JSON.stringify(me.body).slice(0, 120));

// ---- the Parent view -------------------------------------------------------------------------------------------
const kids = await call(pTok, "GET", "/parent/children");
check("children: Maya, with her counselor", kids.status === 200 && kids.body?.children?.length === 1 && kids.body.children[0].id === s.id && kids.body.children[0].counselorName === "Jordan Park", JSON.stringify(kids.body));
let view = await call(pTok, "GET", `/parent/children/${s.id}`);
const text = JSON.stringify(view.body);
check("view: tasks, colleges, essays and meetings", view.status === 200 && Boolean(view.body?.sections?.tasks && view.body.sections.colleges && view.body.sections.essays && view.body.sections.meetings), text.slice(0, 200));
check("…the task the student sees, overdue; never the hidden one", view.body?.sections?.tasks?.open?.some((t) => t.title === `Request transcript ${tag}` && t.overdue === true) && !text.includes(`Hidden counselor task ${tag}`));
check("…essay progress as counts and status only: no title, prompt or text", view.body?.sections?.essays?.[0]?.words === 4 && view.body.sections.essays[0].label === "Supplement" && !text.includes("SECRET"));
check("…the college list without the counselor's notes", view.body?.sections?.colleges?.[0]?.name === "Brown University" && !text.includes("COUNSELOR NOTE"));
check("…a meeting's title and link only when the parents are invited", text.includes(`Family meeting ${tag}`) && !text.includes(`Private planning ${tag}`) && !text.includes("meet.example"));
check("…and no private notes", !text.includes("PRIVATE NOTE"));

// ---- what a parent can't reach ------------------------------------------------------------------------------------
for (const [path, label] of [["/students", "the roster"], ["/me/guardians", "a student's parents"], ["/tasks", "tasks"], [`/communication/${s.id}/composer`, "the composer"], ["/me/overview", "the student view"]]) {
  const r = await call(pTok, "GET", path);
  check(`API: a parent gets 403 parent_account on ${label}`, r.status === 403 && r.body?.code === "parent_account", `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
}
for (const table of ["deliverables", "essays", "student_colleges", "meetings", "guardians", "student_private_notes", "inbound_messages", "parent_invites", "colleges"]) {
  const r = await rest(pTok, "GET", `/rest/v1/${table}?select=*&limit=5`);
  check(`PostgREST: a parent reads no ${table} rows`, Array.isArray(r.body) ? r.body.length === 0 : r.status >= 400, `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
}
const profs = await rest(pTok, "GET", `/rest/v1/profiles?select=id`);
check("PostgREST: a parent's profiles are their own row only", Array.isArray(profs.body) && profs.body.length === 1 && profs.body[0].id === pid, JSON.stringify(profs.body));
const forged = await rest(pTok, "PATCH", `/rest/v1/profiles?id=eq.${pid}`, { parent_email: `other-${tag}@family.test`, role: "counselor" });
check("PostgREST: a parent can't rewrite their proven address or role", forged.status >= 400 && (await sql(`select role || ':' || parent_email from public.profiles where id = '${pid}'`)) === `parent:${parentEmail}`, `status ${forged.status}`);
const otherKid = await rest(pTok, "POST", "/rest/v1/rpc/parent_student_view", { p_student: stranger.id });
check("PostgREST: parent_student_view refuses a student who isn't theirs", otherKid.status >= 400, `${otherKid.status}`);
const otherKidApi = await call(pTok, "GET", `/parent/children/${stranger.id}`);
check("API: …404 not_linked", otherKidApi.status === 404 && otherKidApi.body?.code === "not_linked");
const studentTries = await rest(s.token, "POST", "/rest/v1/rpc/parent_student_view", { p_student: s.id });
check("PostgREST: a student isn't a parent of themselves", studentTries.status >= 400, `${studentTries.status}`);
const counselorTries = await call(c.token, "GET", `/parent/children/${s.id}`);
check("API: the Parent view is the parent's only", counselorTries.status === 403);
const redeemDirect = await rest(pTok, "POST", "/rest/v1/rpc/parent_invite_redeem", { p_token_hash: sha(token), p_user: pid });
check("PostgREST: nobody but the service role redeems", redeemDirect.status >= 400, `${redeemDirect.status}`);

// ---- the counselor's switches -----------------------------------------------------------------------------------
const off = await call(c.token, "PUT", "/accountability/family-visibility", { studentId: s.id, categories: { tasks: false, essays: false } });
check("counselor switches tasks and essays off", off.status === 200, JSON.stringify(off.body).slice(0, 120));
view = await call(pTok, "GET", `/parent/children/${s.id}`);
check("…those sections are gone from the Parent view; colleges stay", view.status === 200 && view.body?.sections?.tasks === undefined && view.body?.sections?.essays === undefined && Array.isArray(view.body?.sections?.colleges), JSON.stringify(view.body?.sections ?? {}).slice(0, 120));
const direct = await rest(pTok, "POST", "/rest/v1/rpc/parent_student_view", { p_student: s.id });
check("…and from the database's own answer (not just hidden by the API)", direct.status === 200 && direct.body?.sections?.tasks === undefined && direct.body?.sections?.essays === undefined);
await call(c.token, "PUT", "/accountability/family-visibility", { studentId: s.id, categories: { tasks: true, essays: true } });

// ---- messaging the counselor ------------------------------------------------------------------------------------
const early = await call(pTok, "POST", `/parent/children/${s.id}/message`, { body: "Hello!" });
check("before the counselor switches the parent on, viewing works but messaging doesn't", early.status === 409 && early.body?.code === "parent_not_switched_on", JSON.stringify(early.body));
const turnOn = await call(c.token, "PATCH", `/accountability/guardians/${gid}`, { alerts_enabled: true });
check("counselor turns the parent on", turnOn.status === 200);
const msg = await call(pTok, "POST", `/parent/children/${s.id}/message`, { body: `Can we talk about Brown? ${tag}` });
check("the parent messages the counselor", msg.status === 201 && msg.body?.emailed === true, JSON.stringify(msg.body));
const replies = await call(c.token, "GET", `/communication/${s.id}/replies`);
const fromFamily = replies.body?.replies?.find((r) => r.body === `Can we talk about Brown? ${tag}`);
check("…the counselor sees it under From the family, as the parent", fromFamily?.party === "parent" && fromFamily?.fromName === "Ana Lee", JSON.stringify(fromFamily));
const cMail = await sql(`select email from public.profiles where id = '${c.id}'`);
const [toCounselor] = await mailTo(cMail, "Message from Ana Lee");
check("…and gets an email with Reply-To the parent", toCounselor && (toCounselor.ReplyTo ?? []).some((r) => r.Address === parentEmail), JSON.stringify(toCounselor?.ReplyTo));
const mine = await call(pTok, "GET", `/parent/children/${s.id}/messages`);
check("the parent's own list", mine.status === 200 && mine.body?.messages?.[0]?.body === `Can we talk about Brown? ${tag}`);
const strangerMsg = await call(pTok, "POST", `/parent/children/${stranger.id}/message`, { body: "hi" });
check("…never about a student who isn't theirs", strangerMsg.status === 404);

// ---- the counselor invites a parent; a sibling with another counselor -------------------------------------------
const cAdd = await call(c2.token, "POST", "/accountability/guardians", { studentId: sib.id, full_name: "Ana Lee", email: parentEmail.toUpperCase(), alerts_enabled: true });
const sibG = cAdd.body?.id;
const composer = await call(c2.token, "GET", `/communication/${sib.id}/composer`);
const chip = composer.body?.family?.find((f) => f.id === sibG);
check("composer: the chip says this parent already has an account", chip?.parentAccount?.state === "joined", JSON.stringify(chip));
kids.body = (await call(pTok, "GET", "/parent/children")).body;
check("…and the second child shows up for the parent at once (kid switcher), with that counselor", kids.body?.children?.length === 2 && kids.body.children.some((k) => k.id === sib.id), JSON.stringify(kids.body));

const dadEmail = `dad-${tag}@family.test`;
const dAdd = await call(c.token, "POST", "/accountability/guardians", { studentId: s.id, full_name: "Luis Lee", email: dadEmail, alerts_enabled: true });
const dadG = dAdd.body?.id;
let comp = await call(c.token, "GET", `/communication/${s.id}/composer`);
check("composer: a new parent reads 'none' (Invite to Meridies)", comp.body?.family?.find((f) => f.id === dadG)?.parentAccount?.state === "none");
const inv1 = await call(c.token, "POST", "/parent-invites", { guardianId: dadG });
check("counselor invites: 201, invited, with delivery status", inv1.status === 201 && inv1.body?.parentAccount?.state === "invited" && inv1.body.parentAccount.delivery?.status === "sent", JSON.stringify(inv1.body));
const [dadMail1] = await mailTo(dadEmail, "invited you");
const t1 = tokenIn(dadMail1);
check("…the email: Create your parent account, the link, Reply-To the counselor", Boolean(t1) && /Create your parent account/.test(dadMail1?.HTML ?? "") && (dadMail1?.ReplyTo ?? []).length === 1, dadMail1?.Subject);
const inv2 = await call(c.token, "POST", "/parent-invites", { guardianId: dadG });
check("Resend invite works", inv2.status === 201);
const mails = await mailTo(dadEmail, "invited you");
const t2 = mails.map(tokenIn).find((t) => t && t !== t1);
const oldPv = await pub("/parent-invites/preview", { token: t1 });
check("…and the earlier link stops working", Boolean(t2) && oldPv.body?.valid === false && oldPv.body?.reason === "expired", JSON.stringify(oldPv.body));
await call(c.token, "POST", "/parent-invites", { guardianId: dadG });
const inv4 = await call(c.token, "POST", "/parent-invites", { guardianId: dadG });
check("three invitations a parent a day", inv4.status === 429, `${inv4.status}`);
const otherCounselor = await call(c2.token, "POST", "/parent-invites", { guardianId: dadG });
check("another counselor can't invite someone else's student's parent", otherCounselor.status === 404 || otherCounselor.status === 403, `${otherCounselor.status}`);
const asStudent = await call(s.token, "POST", "/parent-invites", { guardianId: dadG });
check("…nor can the student through this route", asStudent.status === 403);

// expiry
await sql(`update public.parent_invites set expires_at = now() - interval '1 minute' where token_hash = '${sha(t2 ?? "")}'`);
const exp = await pub("/parent-invites/preview", { token: t2 });
const expAccept = await pub("/parent-invites/accept", { token: t2, fullName: "Luis Lee", password });
check("an expired link previews as expired and can't be used", exp.body?.reason === "expired" && expAccept.status === 410 && (await sql(`select count(*) from auth.users where email = '${dadEmail}'`)) === "0", `${expAccept.status}`);

// a parent the counselor added and switched off: nothing to invite them to
const offEmail = `off-${tag}@family.test`;
const oAdd = await call(c.token, "POST", "/accountability/guardians", { studentId: s.id, full_name: "Off Parent", email: offEmail, alerts_enabled: false });
const offInv = await call(c.token, "POST", "/parent-invites", { guardianId: oAdd.body?.id });
comp = await call(c.token, "GET", `/communication/${s.id}/composer`);
check("a counselor-added parent switched off: invite refused (guardian_off), chip 'off'", offInv.status === 409 && offInv.body?.code === "guardian_off" && comp.body?.family?.find((f) => f.id === oAdd.body?.id)?.parentAccount?.state === "off", JSON.stringify(offInv.body));
// an address that is a student's account
const sEmail = await sql(`select email from public.profiles where id = '${stranger.id}'`);
const taken = await call(c.token, "POST", "/accountability/guardians", { studentId: s.id, full_name: "Taken", email: sEmail, alerts_enabled: true });
const takenInv = await call(c.token, "POST", "/parent-invites", { guardianId: taken.body?.id });
check("an address that is another kind of account: 409 parent_email_taken", takenInv.status === 409 && takenInv.body?.code === "parent_email_taken", JSON.stringify(takenInv.body));
await sql(`delete from public.guardians where id in ('${oAdd.body?.id}', '${taken.body?.id}')`);

// Parent contacts carries the same state
const roster = await call(c.token, "GET", `/guardians/roster?q=${encodeURIComponent(dadEmail)}`);
check("Parent contacts rows carry parentAccount (the third, still good, invitation)", roster.body?.guardians?.[0]?.parentAccount?.state === "invited", JSON.stringify(roster.body?.guardians?.[0]?.parentAccount));

// ---- approval gate, caseload transfer --------------------------------------------------------------------------
await sql(`update public.profiles set counselor_approved_at = null where id = '${c.id}'`);
view = await call(pTok, "GET", `/parent/children/${s.id}`);
check("counselor not approved (pending/revoked): no sections at all", view.status === 200 && view.body?.counselorReady === false && Object.keys(view.body?.sections ?? {}).length === 0 && view.body?.canMessage === false, JSON.stringify(view.body).slice(0, 160));
await sql(`update public.profiles set counselor_approved_at = now() where id = '${c.id}'`);
await sql(`update public.profiles set counselor_id = '${c2.id}' where id = '${s.id}'`);
view = await call(pTok, "GET", `/parent/children/${s.id}`);
check("caseload transfer: still Maya's parent, the new counselor named", view.status === 200 && view.body?.counselorReady === true && view.body?.counselor?.name !== "Jordan Park" && Boolean(view.body?.sections?.colleges));
await sql(`update public.profiles set counselor_id = '${c.id}' where id = '${s.id}'`);

// ---- removal --------------------------------------------------------------------------------------------------
const sibRemove = await call(c2.token, "DELETE", `/accountability/guardians/${sibG}`);
const afterRemove = await call(pTok, "GET", `/parent/children/${sib.id}`);
check("the counselor removes the parent: access ends on the next request", [200, 204].includes(sibRemove.status) && afterRemove.status === 404, `${sibRemove.status}/${afterRemove.status}`);
// the student removes a parent they added (and the counselor hasn't switched on): a second child added by a student
const sib2 = await studentOf(c, "pa-sib2");
const sAdd = await call(sib2.token, "POST", "/me/guardians", { name: "Ana Lee", relationship: "Mother", email: parentEmail });
let list = await call(pTok, "GET", "/parent/children");
check("a student adds an address that already has a parent account: on the view at once", list.body?.children?.some((k) => k.id === sib2.id), JSON.stringify(list.body));
const [signinMail] = await mailTo(parentEmail, "pa-sib2 added you");
check("…and that parent's email says Open your parent view (no new account link)", !signinMail || (/Open your parent view/.test(signinMail.HTML ?? "") && !tokenIn(signinMail)));
await call(sib2.token, "DELETE", `/me/guardians/${sAdd.body?.guardian?.id}`);
list = await call(pTok, "GET", "/parent/children");
check("the student removes them: gone", !list.body?.children?.some((k) => k.id === sib2.id));
// the guardian's address changed: the old address loses the student
await sql(`update public.guardians set email = 'changed-${tag}@family.test' where id = '${gid}'`);
check("the guardian's email changes: the old address loses the student", (await call(pTok, "GET", `/parent/children/${s.id}`)).status === 404);
await sql(`update public.guardians set email = '${parentEmail}' where id = '${gid}'`);

// ---- export and deletion ----------------------------------------------------------------------------------------
const exp2 = await call(pTok, "GET", "/account/export");
check("export: the parent's own row, their children and what they sent", exp2.status === 200 && exp2.body?.kind === "parent" && exp2.body?.profile?.id === pid && exp2.body?.children?.length === 1 && exp2.body?.messagesSent?.length === 1, JSON.stringify(exp2.body).slice(0, 200));
check("…nothing of the student's record", !JSON.stringify(exp2.body).includes("SECRET") && !JSON.stringify(exp2.body).includes("Request transcript"));
const del = await call(pTok, "DELETE", "/account", { confirm: "delete my account" });
check("the parent deletes their account", del.status === 204 && (await sql(`select count(*) from public.profiles where id = '${pid}'`)) === "0", `${del.status} ${JSON.stringify(del.body)}`);
check("…the guardian row (the student's) stays; the message stays on the counselor's page", (await sql(`select count(*) from public.guardians where id = '${gid}'`)) === "1" && (await sql(`select count(*) from public.inbound_messages where student_id = '${s.id}' and party = 'parent'`)) === "1");

// ---- not switched on: nothing else changed for students and counselors -----------------------------------------
const studentStill = await call(s.token, "GET", "/me/guardians");
check("students and counselors carry on", studentStill.status === 200 && (await call(c.token, "GET", "/students")).status === 200);

await sql(`delete from public.parent_invites where student_id in ('${s.id}', '${sib.id}', '${sib2.id}')`);
