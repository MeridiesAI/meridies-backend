// Saved and scheduled invoices, the dispatch cron and the reminder cron (routes/invoiceDrafts.ts,
// lib/invoiceDispatch.ts, migration 20261124000004), against a running API (see harness.mjs).
// Checks: a draft is not an invoice; scheduling resolves a send time; the cron sends a due draft as a real
// invoice once (overlapping runs, a second run), re-plans amounts (an over-billable draft fails with its
// reason and bills nothing), refuses an unapproved or no-longer-billing counselor's draft, rolls a yearly
// draft; reminders go once, for an invoice still owed, never for a paid one, and not when too old.
import { API, CRON_SECRET, call, check, rest, sql, user } from "./harness.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const mailsTo = async (email) => ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()).messages ?? []);
async function mailWith(email, needle, n = 1) {
  for (let i = 0; i < 24; i++) {
    const all = (await mailsTo(email)).filter((x) => x.Subject.includes(needle));
    if (all.length >= n) return Promise.all(all.map(async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()));
    await new Promise((r) => setTimeout(r, 250));
  }
  return [];
}
const MY_IP = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
// The cron routes allow 10 calls a minute per address: this suite uses its own address and few calls.
const cron = async (path) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}`, "X-Forwarded-For": MY_IP } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const due = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const drafts = (id) => sql(`select coalesce(json_agg(row_to_json(d)), '[]') from (select id, state, send_at, attempts, last_error, sent_invoice_id, repeat_yearly from public.pipeline_invoice_drafts where contact_id = '${id}' order by created_at) d`).then(JSON.parse);
const invoices = (id) => sql(`select count(*) from public.pipeline_invoices where contact_id = '${id}'`).then(Number);

const S = await user("dr-solo");
const board = (await call(S.token, "GET", "/pipeline")).body;
const mk = async (name, total = 600000, extra = {}) => {
  const email = `dr-${name.toLowerCase()}-${tag}@families.test`;
  const c = (await call(S.token, "POST", "/pipeline/contacts", { stageId: board.stages[0].id, studentName: `${name} Draft ${tag}`, parentName: "Pat", parentEmail: email, ...extra })).body;
  await call(S.token, "PUT", `/pipeline/contacts/${c.id}/package`, { packageName: "Senior package", totalCents: total, installments: 3 });
  return { ...c, email };
};
const A = await mk("Ada");
const payload = (over = {}) => ({ label: "Deposit", amountCents: 100000, dueOn: due(20), ...over });

check("the cron needs the secret", (await fetch(`${API}/internal/invoice-drafts/dispatch`, { method: "POST" })).status === 401 && (await fetch(`${API}/internal/invoice-reminders/dispatch`, { method: "POST", headers: { Authorization: "Bearer nope" } })).status === 401);

// ---- Saving ----------------------------------------------------------------------------------------------
const d1 = await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: A.id, payload: payload({ methods: ["zelle"], note: "Hello" }) });
check("a draft is saved, and is not an invoice", d1.status === 201 && d1.body.state === "draft" && d1.body.sendAt === null && (await invoices(A.id)) === 0, JSON.stringify(d1.body));
const d1c = await cron("/internal/invoice-drafts/dispatch");
check("the cron never sends a plain draft", d1c.status === 200 && (await invoices(A.id)) === 0, JSON.stringify(d1c.body));
check("lists by family", (await call(S.token, "GET", `/pipeline/invoice-drafts?contactId=${A.id}`)).body.drafts.length === 1 && (await call(S.token, "GET", "/pipeline/invoice-drafts")).status === 400);
check("a broken body is refused on save (lines, past due date, a text with no number)", (await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: A.id, payload: payload({ lines: [{ description: "x", amountCents: 1 }] }) })).body?.code === "lines_sum_mismatch" && (await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: A.id, payload: payload({ dueOn: "2020-01-01" }) })).body?.code === "due_passed" && (await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: A.id, payload: payload({ channel: "text" }) })).status >= 400);
const sch = await call(S.token, "PUT", `/pipeline/invoice-drafts/${d1.body.id}`, { state: "scheduled", payload: payload({ schedule: { mode: "tomorrow" }, methods: ["zelle"], note: "Hello" }) });
check("scheduling resolves a send time (9:00 tomorrow, practice zone)", sch.status === 200 && sch.body.state === "scheduled" && /T\d\d:00:00(\.000)?(Z|\+00:00)$/.test(sch.body.sendAt) && Date.parse(sch.body.sendAt) > Date.now(), JSON.stringify(sch.body));
check("a send time in the past is refused", (await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: A.id, payload: payload({ dueOn: due(1), schedule: { mode: "before_due", daysBefore: 10 } }), state: "scheduled" })).body?.code === "send_time_passed");
check("RLS: another counselor can't see or change it", (await rest((await user("dr-other")).token, "GET", `/rest/v1/pipeline_invoice_drafts?select=id`)).body?.length === 0);
check("a client can't mark a draft sent", (await rest(S.token, "PATCH", `/rest/v1/pipeline_invoice_drafts?id=eq.${d1.body.id}`, { state: "sent" }, { Prefer: "return=representation" })).status >= 400);

// ---- Dispatch --------------------------------------------------------------------------------------------------
await sql(`update public.pipeline_invoice_drafts set send_at = now() - interval '1 minute' where id = '${d1.body.id}'`);
const [r1, r2] = await Promise.all([cron("/internal/invoice-drafts/dispatch"), cron("/internal/invoice-drafts/dispatch")]);
check("two overlapping runs send it once", r1.body.sent + r2.body.sent === 1 && (await invoices(A.id)) === 1, JSON.stringify([r1.body, r2.body]));
const sentDraft = (await drafts(A.id))[0];
check("the draft is spent and points at its invoice", sentDraft.state === "sent" && sentDraft.sent_invoice_id !== null && sentDraft.last_error === null, JSON.stringify(sentDraft));
const mails = await mailWith(A.email, "Invoice INV-");
check("the family got ONE email with the composer's ways to pay and note", mails.length === 1 && /Zelle/.test(mails[0].Text) && /Hello/.test(mails[0].Text), mails.map((m) => m.Subject).join("|"));
const inv = JSON.parse(await sql(`select row_to_json(i)::text from (select amount_cents, created_by, accepted_methods, style_snapshot is not null as snap, sent_to, sent_at is not null as sent from public.pipeline_invoices where contact_id = '${A.id}') i`));
check("it is a real invoice as the counselor", inv.amount_cents === 100000 && inv.created_by === S.id && inv.accepted_methods[0] === "zelle" && inv.snap && inv.sent_to === A.email.toLowerCase() && inv.sent, JSON.stringify(inv));
check("a sent draft can't be edited or cancelled", (await call(S.token, "PUT", `/pipeline/invoice-drafts/${d1.body.id}`, { state: "draft" })).status === 409 && (await call(S.token, "DELETE", `/pipeline/invoice-drafts/${d1.body.id}`)).status === 409);

// ---- Amounts are planned again at send time ----------------------------------------------------------------------------
const B = await mk("Bo", 100000);
const over = await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: B.id, payload: payload({ amountCents: 90000 }), state: "scheduled" });
await call(S.token, "PUT", `/pipeline/contacts/${B.id}/package`, { packageName: "Smaller", totalCents: 50000, installments: 1 });
const ov = await cron("/internal/invoice-drafts/dispatch");
const overRow = (await drafts(B.id))[0];
check("a draft that no longer fits the package fails with its reason and bills nothing", ov.body.failed >= 1 && overRow.state === "failed" && /more than/.test(overRow.last_error) && (await invoices(B.id)) === 0, JSON.stringify(overRow));
check("a failed draft can be rescheduled after the fix", (await call(S.token, "PUT", `/pipeline/invoice-drafts/${over.body.id}`, { state: "scheduled", payload: payload({ amountCents: 40000 }) })).body?.state === "scheduled");
const ov2 = await cron("/internal/invoice-drafts/dispatch");
check("...and then it sends", ov2.body.sent >= 1 && (await invoices(B.id)) === 1);

// ---- Who may send ----------------------------------------------------------------------------------------------------------------
const C = await mk("Cy");
const held = await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: C.id, payload: payload(), state: "scheduled" });
await sql(`update public.profiles set counselor_approved_at = null where id = '${S.id}'`);
const hc = await cron("/internal/invoice-drafts/dispatch");
check("a counselor who is no longer approved sends nothing (held, not failed)", hc.body.held >= 1 && (await invoices(C.id)) === 0 && (await drafts(C.id))[0].state === "scheduled", JSON.stringify(hc.body));
await sql(`update public.profiles set counselor_approved_at = now(), counselor_approved_via = 'team' where id = '${S.id}'`);
check("approved again, it goes", (await cron("/internal/invoice-drafts/dispatch")).body.sent >= 1 && (await invoices(C.id)) === 1);
void held;

// ---- Yearly ----------------------------------------------------------------------------------------------------------------------
const D = await mk("Dee");
const yr = await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: D.id, payload: payload({ dueOn: due(30), schedule: { mode: "now" } }), state: "scheduled", repeatYearly: true });
check("only a scheduled draft can repeat", (await call(S.token, "POST", "/pipeline/invoice-drafts", { contactId: D.id, payload: payload(), repeatYearly: true })).status === 400);
const yc = await cron("/internal/invoice-drafts/dispatch");
const yd = await drafts(D.id);
const nextYear = Number(due(30).slice(0, 4)) + 1;
check("a yearly draft sends and writes next year's", yc.body.rolled >= 1 && yd.length === 2 && yd[1].state === "scheduled" && yd[1].repeat_yearly && Date.parse(yd[1].send_at) > Date.now() + 300 * 86_400_000, JSON.stringify(yd));
check("next year's carries the due date a year on", (await sql(`select payload->>'dueOn' from public.pipeline_invoice_drafts where id = '${yd[1].id}'`)).startsWith(String(nextYear)));
check("cancel takes a scheduled draft out", (await call(S.token, "DELETE", `/pipeline/invoice-drafts/${yd[1].id}`)).body?.state === "cancelled");

// ---- Reminders ------------------------------------------------------------------------------------------------------------------------
const E = await mk("Eli");
const sentE = await call(S.token, "POST", `/pipeline/contacts/${E.id}/invoices`, { label: "Deposit", amountCents: 100000, dueOn: due(5), reminders: [0, -3, 3] });
check("an invoice with reminders", sentE.status === 201, JSON.stringify(sentE.body));
const eId = await sql(`select id from public.pipeline_invoices where contact_id = '${E.id}'`);
// Move its due date to where 9:00 UTC of "today minus 12h's date" was a few hours ago (inside the send window), past the issue date.
const day = new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10);
await sql(`update public.pipeline_invoices set issued_on = '${day}'::date - 10, due_on = '${day}' where id = '${eId}'`);
const rc = await cron("/internal/invoice-reminders/dispatch");
check("the reminder for today goes", rc.status === 200 && rc.body.sent >= 1, JSON.stringify(rc.body));
const rm = await mailWith(E.email, "Reminder:");
check("it says so, and carries the invoice", rm.length === 1 && /due today/.test(rm[0].Text) && /\$1,000/.test(rm[0].Text), rm.map((m) => m.Subject).join("|"));
check("it is marked sent", Object.keys(JSON.parse((await sql(`select reminders_sent from public.pipeline_invoices where id = '${eId}'`)) || "{}")).join() === "0");
const rc2 = await cron("/internal/invoice-reminders/dispatch");
check("a second run sends nothing more", (await mailsTo(E.email)).filter((m) => /Reminder/.test(m.Subject)).length === 1 && rc2.body.sent === 0);
const claimTwice = await Promise.all([1, 2].map(() => fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/claim_invoice_reminder`, { method: "POST", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_invoice: eId, p_offset: 3 }) }).then((r) => r.json())));
check("the claim is atomic: of two racing claims exactly one wins", claimTwice.filter(Boolean).length === 1, JSON.stringify(claimTwice));
check("a client can't call the claim", (await rest(S.token, "POST", "/rest/v1/rpc/claim_invoice_reminder", { p_invoice: eId, p_offset: -3 })).status >= 400);

const F = await mk("Fay");
await call(S.token, "POST", `/pipeline/contacts/${F.id}/invoices`, { label: "Deposit", amountCents: 100000, dueOn: due(5), reminders: [0] });
const fId = await sql(`select id from public.pipeline_invoices where contact_id = '${F.id}'`);
await sql(`update public.pipeline_invoices set issued_on = '${day}'::date - 10, due_on = '${day}' where id = '${fId}'`);
await call(S.token, "POST", `/pipeline/contacts/${F.id}/payments`, { amountCents: 100000, receivedOn: day, method: "check" });

const G = await mk("Gus");
await call(S.token, "POST", `/pipeline/contacts/${G.id}/invoices`, { label: "Deposit", amountCents: 100000, dueOn: due(5), reminders: [0] });
const gId = await sql(`select id from public.pipeline_invoices where contact_id = '${G.id}'`);
const old = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
await sql(`update public.pipeline_invoices set issued_on = '${old}'::date - 10, due_on = '${old}' where id = '${gId}'`);

const H = await mk("Hal");
await call(S.token, "POST", `/pipeline/contacts/${H.id}/invoices`, { label: "Deposit", amountCents: 100000, dueOn: due(5), reminders: [0] });
const hId = await sql(`select id from public.pipeline_invoices where contact_id = '${H.id}'`);
await sql(`update public.pipeline_invoices set issued_on = '${day}'::date - 10, due_on = '${day}' where id = '${hId}'`);
await call(S.token, "POST", `/pipeline/invoices/${hId}/void`);

await cron("/internal/invoice-reminders/dispatch");
check("a paid invoice gets no reminder", (await mailsTo(F.email)).filter((m) => /Reminder|Past due/.test(m.Subject)).length === 0);
check("a reminder that missed its day by more than a day and a half is dropped, not sent late", (await mailsTo(G.email)).filter((m) => /Reminder|Past due/.test(m.Subject)).length === 0);
check("a voided invoice gets no reminder", (await mailsTo(H.email)).filter((m) => /Reminder|Past due/.test(m.Subject)).length === 0);
console.log("done");
