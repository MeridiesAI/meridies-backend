// Payment Tracker credits (migration 20261028000004, bug hunt S2-M1), as real
// accounts on a local Supabase against a running API (see harness.mjs).
//
// Checks: a payment above what's left on the package warns (409 overpayment)
// and is recorded as credit only when the counselor says so; a paid-up package
// can't be invoiced; an invoice can't ask for more than is left; the preview
// matches what is sent; held credit comes off the next invoice as "Credit
// applied"; "Mark refunded" clears it; the database refuses spending more
// credit than the family holds, even through PostgREST.
import { call, check, rest, user } from "./harness.mjs";

const tag = Date.now();
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const S = await user("pc-solo");
const board = (await call(S.token, "GET", "/pipeline")).body;
const stage = board.stages[0];
const contact = (await call(S.token, "POST", "/pipeline/contacts", { stageId: stage.id, studentName: "Nora Credit", parentEmail: `nora-${tag}@families.test` })).body;
const id = contact.id;
const account = async () => (await call(S.token, "GET", "/pipeline/payments")).body.accounts.find((a) => a.contactId === id);

await call(S.token, "PUT", `/pipeline/contacts/${id}/package`, { packageName: "Senior package", totalCents: 50000, installments: 1 });

// 1. An overpayment warns and records nothing.
const over = await call(S.token, "POST", `/pipeline/contacts/${id}/payments`, { amountCents: 90000, receivedOn: day(0), method: "ach" });
check("a payment above what's left is refused with a warning", over.status === 409 && over.body.code === "overpayment", JSON.stringify(over.body));
check("the warning says how much is over", over.body.overpaymentCents === 40000 && over.body.remainingCents === 50000, JSON.stringify(over.body));
check("nothing was recorded", (await account()).payments.length === 0);

// 2. Confirmed, the extra is held as credit.
const ok = await call(S.token, "POST", `/pipeline/contacts/${id}/payments`, { amountCents: 90000, receivedOn: day(0), method: "ach", overpayment: "credit" });
check("a confirmed overpayment is recorded", ok.status === 201, JSON.stringify(ok.body));
check("it pays the package off and holds $400 credit", ok.body.paidCents === 50000 && ok.body.creditCents === 40000 && ok.body.status === "paid-up", JSON.stringify(ok.body));

// 3. A paid-up package can't be invoiced, and the preview says why.
const noInvoice = await call(S.token, "POST", `/pipeline/contacts/${id}/invoices`, { label: "Deposit", amountCents: 50000, dueOn: day(14) });
check("a $0 balance can't send an invoice", noInvoice.status === 409 && noInvoice.body.code === "nothing_to_invoice", JSON.stringify(noInvoice.body));
const noPreview = await call(S.token, "POST", `/pipeline/contacts/${id}/invoices/preview`, { label: "Deposit", amountCents: 50000, dueOn: day(14) });
check("nor be previewed", noPreview.status === 409 && noPreview.body.code === "nothing_to_invoice", JSON.stringify(noPreview.body));

// 4. The package grows; the next invoice takes the credit off, visibly.
await call(S.token, "PUT", `/pipeline/contacts/${id}/package`, { packageName: "Senior package", totalCents: 150000, installments: 1 });
const tooMuch = await call(S.token, "POST", `/pipeline/contacts/${id}/invoices/preview`, { label: "Balance", amountCents: 150001, dueOn: day(14) });
check("an invoice can't ask for more than is left to bill", tooMuch.status === 409 && tooMuch.body.code === "over_billable", JSON.stringify(tooMuch.body));
const preview = await call(S.token, "POST", `/pipeline/contacts/${id}/invoices/preview`, { label: "Balance", amountCents: 150000, dueOn: day(14) });
check("the preview shows credit applied, already paid and the amount due", preview.status === 200 && preview.body.creditAppliedCents === 40000 && preview.body.alreadyPaidCents === 50000 && preview.body.amountDueCents === 60000, JSON.stringify(preview.body));
check("the preview names the recipient and the lines", preview.body.to === `nora-${tag}@families.test` && /Credit applied/.test(preview.body.text) && /Already paid/.test(preview.body.text) && /\$600/.test(preview.body.subject), JSON.stringify(preview.body));
const sent = await call(S.token, "POST", `/pipeline/contacts/${id}/invoices`, { label: "Balance", amountCents: 150000, dueOn: day(14) });
check("the invoice is created", sent.status === 201, JSON.stringify(sent.body));
const inv = sent.body.account.invoices.find((i) => i.label === "Balance");
check("it carries the credit applied", inv?.creditAppliedCents === 40000 && sent.body.account.creditCents === 0, JSON.stringify(inv));
check("and the family owes $600 on it", sent.body.account.nextDue?.owedCents === 60000, JSON.stringify(sent.body.account.nextDue));

// 5. The database won't let a client spend credit the family doesn't hold.
const forged = await rest(S.token, "POST", "/rest/v1/pipeline_invoices", { contact_id: id, label: "Forged", amount_cents: 10000, credit_applied_cents: 10000, due_on: day(30), created_by: S.id });
check("PostgREST can't apply credit that isn't there", forged.status >= 400, JSON.stringify(forged.body));

// 6. Voiding gives the credit back; Mark refunded clears it.
await call(S.token, "POST", `/pipeline/invoices/${inv.id}/void`);
check("voiding the invoice gives the credit back", (await account()).creditCents === 40000);
const refund = await call(S.token, "POST", `/pipeline/contacts/${id}/credit/refund`, { refundedOn: day(0), note: "Check returned" });
check("Mark refunded clears the credit", refund.status === 201 && refund.body.creditCents === 0 && refund.body.refunds.length === 1, JSON.stringify(refund.body));
check("and takes it out of what was collected", refund.body.collectedCents === 50000, JSON.stringify(refund.body));
const again = await call(S.token, "POST", `/pipeline/contacts/${id}/credit/refund`, { refundedOn: day(0) });
check("there's nothing left to refund", again.status === 409 && again.body.code === "no_credit", JSON.stringify(again.body));
const forgedRefund = await rest(S.token, "POST", "/rest/v1/pipeline_credit_refunds", { contact_id: id, amount_cents: 100, refunded_on: day(0), created_by: S.id });
check("PostgREST can't refund credit that isn't there", forgedRefund.status >= 400, JSON.stringify(forgedRefund.body));

// 7. Another counselor can't see or touch any of it.
const X = await user("pc-outsider");
const xr = await call(X.token, "POST", `/pipeline/contacts/${id}/credit/refund`, { refundedOn: day(0) });
check("an outsider can't mark a refund", xr.status === 404 || xr.status === 403, JSON.stringify(xr.body));
