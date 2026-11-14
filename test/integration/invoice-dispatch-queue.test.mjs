// The cron's queue can't be starved or fooled (lib/invoiceDispatch.ts), against a running API (see harness.mjs):
//  - 55 scheduled drafts of an unapproved counselor, all older than a healthy practice's draft, don't keep it from
//    going out (held drafts wait an hour behind it); a draft whose composer profile is gone fails with its reason.
//  - more than 300 invoices with reminders in the window don't starve a due one (the query pages).
//  - a reminder is re-checked against billing rights: a family handed to someone else stops getting them.
import { API, CRON_SECRET, call, check, sql, user } from "./harness.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const MY_IP = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const cron = async (path) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}`, "X-Forwarded-For": MY_IP } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const mailsTo = async (email) => ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()).messages ?? []);
async function mailCount(email, re, wait = false) {
  for (let i = 0; i < (wait ? 24 : 1); i++) {
    const n = (await mailsTo(email)).filter((m) => re.test(m.Subject)).length;
    if (n > 0 || !wait) return n;
    await new Promise((r) => setTimeout(r, 250));
  }
  return 0;
}
const due = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const day = new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10);
const mk = async (U, name, total = 600000) => {
  const board = (await call(U.token, "GET", "/pipeline")).body;
  const email = `dq-${name}-${tag}@families.test`;
  const c = (await call(U.token, "POST", "/pipeline/contacts", { stageId: board.stages[0].id, studentName: `${name} Queue ${tag}`, parentName: "Pat", parentEmail: email })).body;
  await call(U.token, "PUT", `/pipeline/contacts/${c.id}/package`, { packageName: "Senior package", totalCents: total, installments: 3 });
  return { ...c, email };
};

// ---- Held drafts don't stall the queue ----------------------------------------------------------------------
const H = await user("dq-held");
const HC = await mk(H, "held");
const payloadJson = JSON.stringify({ label: "Deposit", amountCents: 100000, dueOn: due(30) }).replace(/'/g, "''");
await sql(`insert into public.pipeline_invoice_drafts (contact_id, payload, state, send_at, created_by)
           select '${HC.id}', '${payloadJson}'::jsonb, 'scheduled', now() - interval '2 days' + (g || ' seconds')::interval, '${H.id}' from generate_series(1, 55) g`);
await sql(`insert into public.pipeline_invoice_drafts (contact_id, payload, state, send_at, created_by)
           values ('${HC.id}', '${payloadJson}'::jsonb, 'scheduled', now() - interval '3 days', null)`);
await sql(`update public.profiles set counselor_approved_at = null where id = '${H.id}'`);
const G = await user("dq-healthy");
const GC = await mk(G, "healthy");
const gd = await call(G.token, "POST", "/pipeline/invoice-drafts", { contactId: GC.id, payload: { label: "Deposit", amountCents: 100000, dueOn: due(20) }, state: "scheduled" });
check("a healthy practice's draft is scheduled behind 56 older ones", gd.status === 201 && (await sql(`select count(*) from public.pipeline_invoice_drafts where state = 'scheduled' and send_at < '${gd.body.sendAt}'`).then(Number)) >= 56, JSON.stringify(gd.body).slice(0, 200));
const run = await cron("/internal/invoice-drafts/dispatch");
check("one run still sends it", run.status === 200 && run.body.sent >= 1 && Number(await sql(`select count(*) from public.pipeline_invoices where contact_id = '${GC.id}'`)) === 1, JSON.stringify(run.body));
check("the 55 held drafts were postponed (still scheduled, an hour on), not failed", run.body.held >= 55 && Number(await sql(`select count(*) from public.pipeline_invoice_drafts where contact_id = '${HC.id}' and state = 'scheduled' and send_at > now() + interval '50 minutes'`)) === 55, JSON.stringify(run.body));
const orphan = JSON.parse(await sql(`select row_to_json(d)::text from (select state, last_error from public.pipeline_invoice_drafts where contact_id = '${HC.id}' and created_by is null) d`));
check("a draft whose composer has no account fails with its reason", orphan.state === "failed" && /no longer has an account/.test(orphan.last_error), JSON.stringify(orphan));
check("nothing was billed for the held practice", Number(await sql(`select count(*) from public.pipeline_invoices where contact_id = '${HC.id}'`)) === 0);

// ---- More than 300 reminder invoices -------------------------------------------------------------------------------------
const R = await user("dq-rem");
const RC = await mk(R, "rem");
const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
const older = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
// 320 invoices whose only reminder (+5 days) is long past its window, and whose due dates sort BEFORE the live one.
await sql(`insert into public.pipeline_invoices (contact_id, label, amount_cents, issued_on, due_on, reminders, created_by)
           select '${RC.id}', 'Old ' || g, 100, '${older}', '${old}', '{5}', '${R.id}' from generate_series(1, 320) g`);
const live = await call(R.token, "POST", `/pipeline/contacts/${RC.id}/invoices`, { label: "Live", amountCents: 100000, dueOn: due(5), reminders: [0] });
const liveId = await sql(`select id from public.pipeline_invoices where contact_id = '${RC.id}' and label = 'Live'`);
await sql(`update public.pipeline_invoices set issued_on = '${day}'::date - 10, due_on = '${day}' where id = '${liveId}'`);

// ---- A reminder re-checks who may bill ------------------------------------------------------------------------------------
// A firm consultant sends an invoice for a family they own; the family is then handed to the firm's owner.
const O = await user("dq-owner");
const M = await user("dq-member");
const firmId = await sql(`with f as (insert into public.firms (name, owner_id, plan, seats) values ('Queue firm ${tag}', '${O.id}', 'practice', 5) returning id) select id from f`);
await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${O.id}', 'owner'), ('${firmId}', '${M.id}', 'counselor') on conflict do nothing`);
await sql(`update public.profiles set firm_id = '${firmId}' where id in ('${O.id}', '${M.id}')`);
const mBoard = (await call(M.token, "GET", "/pipeline")).body;
const UC = (await call(M.token, "POST", "/pipeline/contacts", { stageId: mBoard.stages[0].id, studentName: `Handed Queue ${tag}`, parentName: "Pat", parentEmail: `dq-handed-${tag}@families.test`, ownerId: M.id })).body;
UC.email = `dq-handed-${tag}@families.test`;
const pkg = await call(M.token, "PUT", `/pipeline/contacts/${UC.id}/package`, { packageName: "Senior package", totalCents: 600000, installments: 3 });
const inv = await call(M.token, "POST", `/pipeline/contacts/${UC.id}/invoices`, { label: "Handed", amountCents: 100000, dueOn: due(5), reminders: [0] });
check("a firm consultant bills a family they own", pkg.status === 200 && inv.status === 201, `${pkg.status} ${inv.status} ${JSON.stringify(inv.body)}`);
const uId = await sql(`select id from public.pipeline_invoices where contact_id = '${UC.id}'`);
await sql(`update public.pipeline_invoices set issued_on = '${day}'::date - 10, due_on = '${day}' where id = '${uId}'`);
await sql(`update public.pipeline_contacts set owner_id = '${O.id}' where id = '${UC.id}'`);

const r1 = await cron("/internal/invoice-reminders/dispatch");
check("the live reminder goes although 320 older invoices sort ahead of it", live.status === 201 && r1.status === 200 && r1.body.sent >= 1 && (await mailCount(RC.email, /Reminder:/, true)) === 1, JSON.stringify(r1.body));
check("a family handed to someone else stops getting reminders from the consultant who sent the invoice (held, not claimed)", (await mailCount(UC.email, /Reminder/)) === 0 && r1.body.held >= 1 && (await sql(`select coalesce(reminders_sent::text, '') from public.pipeline_invoices where id = '${uId}'`)) === "", JSON.stringify(r1.body));
await sql(`update public.pipeline_contacts set owner_id = '${M.id}' where id = '${UC.id}'`);
const r2 = await cron("/internal/invoice-reminders/dispatch");
check("handed back, the same reminder goes (it was never claimed)", r2.body.sent >= 1 && (await mailCount(UC.email, /Reminder:/, true)) === 1, JSON.stringify(r2.body));
console.log("done");
