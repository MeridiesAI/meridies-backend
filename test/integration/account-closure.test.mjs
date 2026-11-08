// Leave Meridies: closing a counselor's account with a 30-day grace period (20261111000004, lib/accountClosure.ts).
//
// API_URL: an API with ACCOUNT_PURGE_ENABLED unset (the default). Optional PURGE_API_URL: a second API started with
// ACCOUNT_PURGE_ENABLED=true; the purge section runs only then, and only against throwaway counselors made here.
// MAILPIT_URL: where the API's DEV_MAIL_URL delivers.
import { API, CLIENT, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const PURGE_API = process.env.PURGE_API_URL?.replace(/\/+$/, "");
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const DAY = 86_400_000;

const cron = (base, secret = CRON_SECRET) =>
  fetch(`${base}/internal/account-closures/purge`, { method: "POST", headers: { ...CLIENT, ...(secret ? { Authorization: `Bearer ${secret}` } : {}) } }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => null),
  }));
const close = (u, confirm = "CLOSE") => call(u.token, "POST", "/account/closure", { confirm });
const status = (id) => sql(`select coalesce((select status from public.account_closures where counselor_id = '${id}'), 'none')`);
const exists = async (id) => (await sql(`select count(*) from public.profiles where id = '${id}'`)) === "1";
const authExists = async (id) => (await sql(`select count(*) from auth.users where id = '${id}'`)) === "1";
// A stored Google connection that is not a real token: no provider is ever called with it (the stack has no
// INTEGRATION_TOKEN_KEY, so revokeAndForget only forgets it).
const seedConnection = (id) =>
  sql(`insert into public.integration_tokens (owner_id, provider, access_token_enc, scopes) values ('${id}', 'google', 'not-a-real-token', '{}')
       on conflict (owner_id, provider) do nothing`);
const connections = (id) => sql(`select count(*) from public.integration_tokens where owner_id = '${id}'`);
const pastDue = (id) => sql(`update public.account_closures set requested_at = now() - interval '31 days', purge_after = now() - interval '1 day' where counselor_id = '${id}'`);

async function mailTo(address) {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const list = (await r.json()).messages ?? [];
    if (list.length) return Promise.all(list.map(async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()));
    await new Promise((res) => setTimeout(res, 250));
  }
  return [];
}

// ---- Who may ask ----
{
  const r = await fetch(`${API}/account/closure`, { headers: CLIENT });
  check("unauthenticated is 401", r.status === 401, String(r.status));
  const s = await user("closure-student", "student");
  const p = await close(s);
  check("a student can't close through this route (403)", p.status === 403, String(p.status));
  check("and gets no row", (await status(s.id)) === "none");
}

// ---- Request, read, repeat, cancel, request again ----
const c = await user("closure-c");
{
  const none = await call(c.token, "GET", "/account/closure");
  check("no closure reads as none, with the flag off", none.status === 200 && none.body?.status === "none" && none.body?.purgeEnabled === false, JSON.stringify(none.body));

  const wrong = await close(c, "close");
  check("the wrong confirmation is 400 and opens nothing", wrong.status === 400 && (await status(c.id)) === "none", `${wrong.status}`);
  const extra = await call(c.token, "POST", "/account/closure", { confirm: "CLOSE", purgeAfter: "2026-11-09" });
  check("an unknown body field is 400 (strict)", extra.status === 400, String(extra.status));

  await seedConnection(c.id);
  const first = await close(c);
  const purgeMs = Date.parse(first.body?.purgeAfter ?? "") - Date.now();
  check("asking opens a pending closure 30 days out (201)",
    first.status === 201 && first.body?.status === "pending" && first.body?.daysLeft === 30 && Math.abs(purgeMs - 30 * DAY) < 5 * 60_000,
    JSON.stringify(first.body));
  const read = await call(c.token, "GET", "/account/closure");
  check("GET shows it pending with ~30 days left", read.body?.status === "pending" && read.body?.daysLeft === 30 && read.body?.purgeAfter === first.body?.purgeAfter, JSON.stringify(read.body));

  const again = await close(c);
  check("a second request answers the same closure (200), not a new one",
    again.status === 200 && again.body?.requestedAt === first.body?.requestedAt && again.body?.purgeAfter === first.body?.purgeAfter,
    `${again.status} ${JSON.stringify(again.body)}`);
  check("one audit row for the request", (await sql(`select count(*) from public.audit_log where entity_id = '${c.id}' and action = 'account.closure.requested'`)) === "1");

  const works = await call(c.token, "GET", "/account/export");
  const writes = await call(c.token, "PATCH", "/auth/me", { title: "Still here" });
  check("the account keeps working during the grace period (read and write)", works.status === 200 && writes.status === 200, `${works.status} ${writes.status}`);

  check("asking keeps the account's connections (nothing is revoked until the purge)", (await connections(c.id)) === "1");
  const cancel = await call(c.token, "DELETE", "/account/closure");
  check("cancel closes it (none) and records cancelled", cancel.status === 200 && cancel.body?.status === "none" && (await status(c.id)) === "cancelled", `${cancel.status} ${JSON.stringify(cancel.body)}`);
  check("a cancelled closure leaves the connection in place", (await connections(c.id)) === "1");
  const cancelAgain = await call(c.token, "DELETE", "/account/closure");
  check("cancelling with nothing open is 404 no_closure", cancelAgain.status === 404 && cancelAgain.body?.code === "no_closure", `${cancelAgain.status} ${JSON.stringify(cancelAgain.body)}`);

  await new Promise((r) => setTimeout(r, 1100));
  const reopen = await close(c);
  check("asking again after a cancel opens a fresh closure (201, new dates)",
    reopen.status === 201 && reopen.body?.status === "pending" && reopen.body?.requestedAt !== first.body?.requestedAt, JSON.stringify(reopen.body));

  const mails = await mailTo(c.email);
  const subjects = mails.map((m) => m.Subject).join(" | ");
  check("the counselor got a request, a cancel and a second request email", mails.length === 3, subjects);
}

// ---- The table: own row readable, every write the API's ----
{
  const other = await user("closure-other");
  const mine = await rest(c.token, "GET", `/rest/v1/account_closures?counselor_id=eq.${c.id}&select=status`);
  const theirs = await rest(other.token, "GET", `/rest/v1/account_closures?counselor_id=eq.${c.id}&select=status`);
  check("a counselor reads their own row and nobody else's", mine.body?.[0]?.status === "pending" && Array.isArray(theirs.body) && theirs.body.length === 0, `${JSON.stringify(mine.body)} ${JSON.stringify(theirs.body)}`);
  const upd = await rest(c.token, "PATCH", `/rest/v1/account_closures?counselor_id=eq.${c.id}`, { purge_after: new Date().toISOString() });
  const ins = await rest(other.token, "POST", "/rest/v1/account_closures", { counselor_id: other.id, purge_after: new Date().toISOString() });
  const del = await rest(c.token, "DELETE", `/rest/v1/account_closures?counselor_id=eq.${c.id}`);
  check("no client can write it (update, insert, delete refused)", upd.status === 403 && ins.status === 403 && del.status === 403 && (await status(c.id)) === "pending",
    `${upd.status} ${ins.status} ${del.status}`);
}

// ---- The email names no student ----
{
  const solo = await user("closure-mail-c");
  const kid = await studentOf(solo, "closure-mail-s");
  await sql(`update public.profiles set archived_at = now(), full_name = 'Zebulon Quixotic' where id = '${kid.id}'`);
  const r = await close(solo);
  const [mail] = await mailTo(solo.email);
  const body = `${mail?.Subject ?? ""}\n${mail?.Text ?? ""}\n${mail?.HTML ?? ""}`;
  check("a solo counselor with only archived students may close", r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  check("the email gives the date, Settings, cancel and export", /Settings/.test(body) && /cancel/i.test(body) && /export/i.test(body) && /\b20\d\d\b/.test(body), body.slice(0, 200));
  check("the email names no student", !/Zebulon|Quixotic/.test(body));
  await call(solo.token, "DELETE", "/account/closure");
}

// ---- A pending (unapproved) counselor may leave ----
{
  const pend = await user("closure-pending", "counselor", { approved: false });
  const blocked = await call(pend.token, "GET", "/students");
  const r = await close(pend);
  check("a pending counselor is locked out elsewhere but can request a closure", blocked.status === 403 && r.status === 201 && r.body?.status === "pending", `${blocked.status} ${r.status}`);
  const read = await call(pend.token, "GET", "/account/closure");
  check("and read it", read.status === 200 && read.body?.status === "pending");
  await call(pend.token, "DELETE", "/account/closure");
}

// ---- The DELETE /account preconditions, shared ----
{
  const owner = await user("closure-owner");
  const member = await user("closure-member");
  await firmWith(owner, [member]);
  const st = await studentOf(member, "closure-member-s");
  await sql(`update public.profiles set archived_at = now() where id = '${st.id}'`);
  const r = await close(member);
  check("a firm member with students (archived too) gets the same 409, asking an owner or admin to transfer",
    r.status === 409 && r.body?.code === "caseload_not_empty" && /Ask a firm owner or admin to transfer them/.test(r.body?.error ?? r.body?.message ?? ""),
    `${r.status} ${JSON.stringify(r.body)}`);
  const del = await call(member.token, "DELETE", "/account", { confirm: "delete my account" });
  check("DELETE /account answers the same 409 and code", del.status === 409 && del.body?.code === "caseload_not_empty", `${del.status} ${JSON.stringify(del.body)}`);
  check("no closure row was written", (await status(member.id)) === "none");
  const o = await close(owner);
  check("a firm owner is refused (owns_firm)", o.status === 409 && o.body?.code === "owns_firm", `${o.status} ${JSON.stringify(o.body)}`);
}

// ---- A closure caught mid-purge: 409 while the run is live, cancellable once it has been stuck an hour ----
{
  const k = await user("closure-stuck");
  await close(k);
  // As a crashed run leaves it (the table's trigger would stamp updated_at, so it is held off for this one statement).
  const stuck = (age) =>
    sql(`set session_replication_role = replica; update public.account_closures set status = 'purging', updated_at = now() - interval '${age}' where counselor_id = '${k.id}'`);
  await stuck("1 minute");
  const live = await call(k.token, "DELETE", "/account/closure");
  check("cancel is refused while a purge is working on it (409)", live.status === 409 && live.body?.code === "closure_in_progress", `${live.status} ${JSON.stringify(live.body)}`);
  await stuck("2 hours");
  const late = await call(k.token, "DELETE", "/account/closure");
  check("a purge stuck for over an hour can be cancelled", late.status === 200 && (await status(k.id)) === "cancelled", `${late.status} ${JSON.stringify(late.body)}`);
}

// ---- Stripe: only a live account (charges enabled) blocks ----
{
  const sc = await user("closure-stripe");
  const acct = `acct_test${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await sql(`insert into public.practice_stripe_accounts (practice_id, counselor_id, stripe_account_id, charges_enabled, details_submitted)
             values ('${sc.id}', '${sc.id}', '${acct}', true, true)`);
  const live = await close(sc);
  const del = await call(sc.token, "DELETE", "/account", { confirm: "delete my account" });
  check("a solo practice taking card payments gets 409 stripe_connected (closure and DELETE /account)",
    live.status === 409 && live.body?.code === "stripe_connected" && /Stripe dashboard first, then try again/.test(live.body?.error ?? "") &&
      del.status === 409 && del.body?.code === "stripe_connected",
    `${live.status} ${JSON.stringify(live.body)} ${del.status}`);
  // What Stripe's deauthorize webhook (or an onboarding never finished) leaves: charges off.
  await sql(`update public.practice_stripe_accounts set charges_enabled = false where practice_id = '${sc.id}'`);
  const off = await close(sc);
  check("a deauthorized or unfinished Stripe account doesn't block", off.status === 201, `${off.status} ${JSON.stringify(off.body)}`);
  await call(sc.token, "DELETE", "/account/closure");
}

// ---- Billing history: invoices and payments RESTRICT their package, so the account can't close itself ----
{
  const bc = await user("closure-billing");
  const board = (await call(bc.token, "GET", "/pipeline")).body;
  const contact = (await call(bc.token, "POST", "/pipeline/contacts", { stageId: board.stages[0].id, studentName: "Billing Family", parentEmail: `bill-${Date.now()}@families.test` })).body;
  const fresh = await close(bc);
  check("a counselor with a contact but no billing rows may close (201)", fresh.status === 201, `${fresh.status} ${JSON.stringify(fresh.body)}`);
  await call(bc.token, "DELETE", "/account/closure");
  await call(bc.token, "PUT", `/pipeline/contacts/${contact.id}/package`, { packageName: "Senior package", totalCents: 50000, installments: 1 });
  const inv = await call(bc.token, "POST", `/pipeline/contacts/${contact.id}/invoices`, { label: "Deposit", amountCents: 20000, dueOn: new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10) });
  if (inv.status !== 201 && inv.status !== 200) throw new Error(`setup invoice ${inv.status} ${JSON.stringify(inv.body)}`);
  const billed = await close(bc);
  const del = await call(bc.token, "DELETE", "/account", { confirm: "delete my account" });
  check("with an invoice on record: 409 billing_history on the closure and on DELETE /account, in plain words",
    billed.status === 409 && billed.body?.code === "billing_history" && /invoices or payments on record/.test(billed.body?.error ?? "") &&
      del.status === 409 && del.body?.code === "billing_history",
    `${billed.status} ${JSON.stringify(billed.body)} ${del.status}`);
  check("and nothing was opened or deleted", (await status(bc.id)) === "cancelled" && (await exists(bc.id)));
}

// ---- The purge: secret, and OFF by default ----
{
  const no = await cron(API, null);
  const bad = await cron(API, "x".repeat(40));
  check("the purge route is 401 without the secret", no.status === 401 && bad.status === 401, `${no.status} ${bad.status}`);
  await pastDue(c.id);
  const off = await cron(API);
  check("with the flag off it does nothing and says so", off.status === 200 && off.body?.ran === false && off.body?.reason === "purge_disabled", JSON.stringify(off.body));
  check("and nothing is deleted though the date has passed", (await exists(c.id)) && (await status(c.id)) === "pending");
  const read = await call(c.token, "GET", "/account/closure");
  check("GET shows 0 days left and the purge switched off", read.body?.daysLeft === 0 && read.body?.purgeEnabled === false, JSON.stringify(read.body));
  // Leave nothing due behind for the purge below.
  await call(c.token, "DELETE", "/account/closure");
}

// ---- The purge, switched on, in a second API (throwaway accounts only) ----
if (!PURGE_API) {
  console.log("SKIP  purge-enabled section (no PURGE_API_URL)");
} else {
  const t = await user("closure-throwaway");
  const kid = await studentOf(t, "closure-throwaway-s");
  await sql(`update public.profiles set archived_at = now() where id = '${kid.id}'`);
  const blocked = await user("closure-blocked");
  const waiting = await user("closure-waiting");
  await seedConnection(t.id);
  const changed = await user("closure-changed-mind");
  const billedLate = await user("closure-billed-late");
  for (const u of [t, blocked, waiting, changed, billedLate]) {
    const r = await close(u);
    if (r.status !== 201) throw new Error(`setup close ${r.status} ${JSON.stringify(r.body)}`);
  }
  // `changed` cancels, and its old date passes: the purge must leave it alone.
  await call(changed.token, "DELETE", "/account/closure");
  await pastDue(changed.id);
  // `billedLate` asked, then invoiced a family: the purge must hold it before wiping anything.
  {
    const board = (await call(billedLate.token, "GET", "/pipeline")).body;
    const ct = (await call(billedLate.token, "POST", "/pipeline/contacts", { stageId: board.stages[0].id, studentName: "Late Family", parentEmail: `late-${Date.now()}@families.test` })).body;
    await call(billedLate.token, "PUT", `/pipeline/contacts/${ct.id}/package`, { packageName: "Pkg", totalCents: 30000, installments: 1 });
    await call(billedLate.token, "POST", `/pipeline/contacts/${ct.id}/invoices`, { label: "Deposit", amountCents: 10000, dueOn: new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10) });
    await seedConnection(billedLate.id);
    await pastDue(billedLate.id);
  }
  // `blocked` takes a student on after asking: the purge must refuse it.
  const late = await studentOf(blocked, "closure-blocked-s");
  await pastDue(t.id);
  await pastDue(blocked.id);
  // Nothing else may be due (stray rows from an earlier run of this suite: test accounts only).
  await sql(`update public.account_closures a set purge_after = now() + interval '30 days' from public.profiles p
             where p.id = a.counselor_id and p.email like '%@test.local' and a.status = 'pending' and a.purge_after <= now()
               and a.counselor_id not in ('${t.id}', '${blocked.id}', '${billedLate.id}')`);
  // Counted over profiles that existed before the run, so other suites signing up on a shared stack don't count.
  const cutoff = await sql(`select now()::text`);
  const existing = () => sql(`select count(*) from public.profiles where created_at <= '${cutoff}'`);
  const before = await existing();

  const r = await cron(PURGE_API);
  check("the enabled purge ran: one purged, two blocked", r.status === 200 && r.body?.ran === true && r.body?.purged === 1 && r.body?.blocked === 2 && r.body?.failed === 0,
    `${r.status} ${JSON.stringify(r.body)}`);
  check("the throwaway account is gone (auth user and profile)", !(await authExists(t.id)) && !(await exists(t.id)));
  const revokedMeta = await sql(`select metadata->'connections'->>'forgotten' from public.audit_log where entity_id = '${t.id}' and action = 'account.closure.purged'`);
  check("its connections were revoked at purge time (recorded) and are gone", /google/.test(revokedMeta) && (await connections(t.id)) === "0", revokedMeta);
  check("a closure cancelled before its date passed is never purged", (await exists(changed.id)) && (await authExists(changed.id)) && (await status(changed.id)) === "cancelled");
  check("its closure row went with it", (await status(t.id)) === "none");
  const trail = await sql(`select string_agg(action, ',' order by created_at, action) from public.audit_log where entity_id = '${t.id}' and action in ('account.closure.purging', 'account.deleted', 'account.closure.purged')`);
  check("the outcome is recorded in audit_log (purging, deleted, purged)", ["account.closure.purging", "account.deleted", "account.closure.purged"].every((a) => (trail ?? "").includes(a)), trail);
  const via = await sql(`select metadata->>'via' from public.audit_log where entity_id = '${t.id}' and action = 'account.deleted'`);
  check("through the DELETE /account path (account.deleted, via closure)", via === "closure", via);
  check("its student keeps existing, unlinked", (await exists(kid.id)) && (await sql(`select coalesce(counselor_id::text, 'null') from public.profiles where id = '${kid.id}'`)) === "null");
  const after = await existing();
  check("exactly one profile was deleted", Number(after) === Number(before) - 1, `${before} -> ${after}`);

  check("the blocked account stays, marked failed with the reason", (await exists(blocked.id)) && (await status(blocked.id)) === "failed");
  const why = await call(blocked.token, "GET", "/account/closure");
  check("GET shows it on hold with the reason, no date", why.body?.status === "on_hold" && why.body?.purgeAfter === null && why.body?.daysLeft === null &&
    /still have 1 student/.test(why.body?.blockedReason ?? ""), JSON.stringify(why.body));
  check("its student is untouched", (await exists(late.id)) && (await sql(`select counselor_id from public.profiles where id = '${late.id}'`)) === blocked.id);
  const held = await call(billedLate.token, "GET", "/account/closure");
  check("an account with billing history is held (on_hold, billing reason) and nothing was wiped",
    held.body?.status === "on_hold" && /invoices or payments/.test(held.body?.blockedReason ?? "") && (await connections(billedLate.id)) === "1" &&
      (await sql(`select count(*) from public.audit_log where entity_id = '${billedLate.id}' and action in ('account.closure.purging', 'account.deleted')`)) === "0",
    JSON.stringify(held.body));
  await call(billedLate.token, "DELETE", "/account/closure");
  check("a closure not yet due is untouched", (await exists(waiting.id)) && (await status(waiting.id)) === "pending");

  const again = await cron(PURGE_API);
  check("a second run finds nothing due", again.body?.ran === true && again.body?.due === 0, JSON.stringify(again.body));
  // The counselor sorts it out and confirms again: a fresh 30 days, a fresh email.
  await sql(`update public.profiles set archived_at = now() where id = '${late.id}'`);
  const mailsBefore = (await mailTo(blocked.email)).length;
  const again2 = await close(blocked);
  await new Promise((r) => setTimeout(r, 1500));
  const mailsAfter = (await mailTo(blocked.email)).length;
  check("confirming an on-hold closure again starts a fresh 30 days (201) and emails again",
    again2.status === 201 && again2.body?.status === "pending" && again2.body?.daysLeft === 30 && mailsAfter === mailsBefore + 1,
    `${again2.status} ${JSON.stringify(again2.body)} mails ${mailsBefore}->${mailsAfter}`);
  await call(blocked.token, "DELETE", "/account/closure");
  await call(waiting.token, "DELETE", "/account/closure");
}
