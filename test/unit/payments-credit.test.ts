import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAccount, planInvoice, planPayment } from "../../src/lib/payments.js";

const pkg = (total: number, installments = 3) => ({ contact_id: "c", package_name: "Senior package", total_cents: total, installments });
const inv = (id: string, cents: number, issued: string, due: string, credit = 0) => ({
  id, number: id, label: id, amount_cents: cents, credit_applied_cents: credit, issued_on: issued, due_on: due, created_at: issued,
});
const pay = (id: string, cents: number, on: string, credit = 0) => ({ id, amount_cents: cents, credit_cents: credit, received_on: on, method: "ach", created_at: on });
const refund = (id: string, cents: number, on: string) => ({ id, amount_cents: cents, refunded_on: on, created_at: on });
const TODAY = "2026-10-28";

test("a payment above what's left on the package is an overpayment", () => {
  const a = deriveAccount(pkg(50000), [], [], TODAY);
  assert.equal(a.remainingCents, 50000);
  assert.deepEqual(planPayment(a, 90000), { overpaymentCents: 40000 });
  assert.deepEqual(planPayment(a, 50000), { overpaymentCents: 0 });
});

test("an overpayment recorded as a credit pays the package off and holds the rest", () => {
  const a = deriveAccount(pkg(50000), [], [pay("p", 90000, "2026-10-28", 40000)], TODAY);
  assert.equal(a.paidCents, 50000, "only the package's share counts as paid");
  assert.equal(a.collectedCents, 90000);
  assert.equal(a.creditCents, 40000);
  assert.equal(a.remainingCents, 0);
  assert.equal(a.status, "paid-up");
});

test("nothing can be invoiced once the package is paid", () => {
  const a = deriveAccount(pkg(50000), [], [pay("p", 50000, "2026-10-28")], TODAY);
  assert.equal(a.canInvoice, false);
  assert.match(a.invoiceBlockedReason ?? "", /paid in full/i);
  assert.equal(a.suggestedInstallmentCents, 0);
});

test("money already on open invoices isn't billed twice", () => {
  const a = deriveAccount(pkg(50000, 1), [inv("1", 50000, "2026-10-01", "2026-11-01")], [], TODAY);
  assert.equal(a.remainingCents, 50000);
  assert.equal(a.billableCents, 0);
  assert.equal(a.canInvoice, false);
  assert.match(a.invoiceBlockedReason ?? "", /already on open invoices/i);
});

test("money paid ahead comes off the invoice, so it asks for the package total minus what's paid", () => {
  // $1,000 over 2 installments, $300 paid ahead with no invoice yet.
  const a = deriveAccount(pkg(100000, 2), [], [pay("p", 30000, "2026-10-01")], TODAY);
  assert.equal(a.remainingCents, 70000);
  assert.equal(a.suggestedInstallmentCents, 50000);
  assert.deepEqual(planInvoice(a, 50000), { ok: true, grossCents: 50000, creditAppliedCents: 0, alreadyPaidCents: 30000, amountDueCents: 20000 });
  const all = planInvoice(a, 100000);
  assert.equal(all.ok && all.amountDueCents, 70000, "billing the whole package asks for total minus paid");
});

test("the last installment bills everything left", () => {
  const last = deriveAccount(pkg(100000, 2), [inv("1", 35000, "2026-10-01", "2026-11-01")], [pay("p", 35000, "2026-10-02")], TODAY);
  assert.equal(last.billableCents, 65000);
  assert.equal(last.suggestedInstallmentCents, 65000);
});

test("an invoice that payments already cover isn't sent", () => {
  const a = deriveAccount(pkg(100000, 2), [], [pay("p", 60000, "2026-10-01")], TODAY);
  const plan = planInvoice(a, 50000);
  assert.equal(plan.ok, false);
  assert.match(plan.ok ? "" : plan.reason, /already cover/i);
});

test("an invoice can't ask for more than is left to bill", () => {
  const a = deriveAccount(pkg(50000), [], [pay("p", 20000, "2026-10-01")], TODAY);
  assert.equal(a.billableCents, 50000);
  assert.equal(planInvoice(a, 50001).ok, false);
});

test("a $0 balance can't send an invoice", () => {
  const a = deriveAccount(pkg(50000), [inv("1", 50000, "2026-10-01", "2026-11-01")], [pay("p", 50000, "2026-10-02")], TODAY);
  assert.equal(a.remainingCents, 0);
  const plan = planInvoice(a, 100);
  assert.equal(plan.ok, false);
  assert.match(plan.ok ? "" : plan.reason, /paid in full/i);
});

test("a held credit comes off the next invoice as a credit-applied line", () => {
  // Paid $900 on a $500 package ($400 credit), then the package grew to $1,500.
  const a = deriveAccount(pkg(150000, 2), [inv("1", 50000, "2026-10-01", "2026-11-01")], [pay("p", 90000, "2026-10-02", 40000)], TODAY);
  assert.equal(a.creditCents, 40000);
  assert.equal(a.billableCents, 100000);
  assert.deepEqual(planInvoice(a, 100000), { ok: true, grossCents: 100000, creditAppliedCents: 40000, alreadyPaidCents: 0, amountDueCents: 60000 });
  const after = deriveAccount(
    pkg(150000, 2),
    [inv("1", 50000, "2026-10-01", "2026-11-01"), inv("2", 100000, "2026-10-28", "2026-11-15", 40000)],
    [pay("p", 90000, "2026-10-02", 40000)],
    TODAY
  );
  assert.equal(after.creditCents, 0);
  assert.equal(after.invoices[1]!.creditAppliedCents, 40000);
  assert.equal(after.invoices[1]!.state, "open");
  assert.equal(after.nextDue?.owedCents, 60000);
  assert.equal(after.remainingCents, 60000);
});

test("a voided invoice gives its credit back", () => {
  const a = deriveAccount(
    pkg(150000, 2),
    [{ ...inv("2", 100000, "2026-10-28", "2026-11-15", 40000), voided_at: "2026-10-28T12:00:00Z" }],
    [pay("p", 90000, "2026-10-02", 40000)],
    TODAY
  );
  assert.equal(a.creditCents, 40000);
});

test("marking a credit refunded clears it and takes it out of what was collected", () => {
  const a = deriveAccount(pkg(50000), [], [pay("p", 90000, "2026-10-28", 40000)], TODAY, [refund("r", 40000, "2026-10-28")]);
  assert.equal(a.creditCents, 0);
  assert.equal(a.collectedCents, 50000);
  assert.equal(a.refunds.length, 1);
});

test("an older overpayment recorded before credits existed still shows as credit, never as more to bill", () => {
  const a = deriveAccount(pkg(50000), [], [pay("p", 90000, "2026-10-28")], TODAY);
  assert.equal(a.creditCents, 40000);
  assert.equal(a.remainingCents, 0);
  assert.equal(a.canInvoice, false);
});

test("a package's length is said in months, then years", async () => {
  const { describeDuration, planLine } = await import("../../src/lib/payments.js");
  assert.equal(describeDuration(1), "1 month");
  assert.equal(describeDuration(6), "6 months");
  assert.equal(describeDuration(12), "1 year");
  assert.equal(describeDuration(24), "2 years");
  assert.equal(describeDuration(18), "18 months");
  const pkg = { packageName: "Senior package", totalCents: 300_000, installments: 6, durationMonths: 6 };
  assert.equal(planLine(pkg, 2), "Payment 2 of 6 for Senior package ($3,000 over 6 months).");
  assert.equal(planLine({ ...pkg, durationMonths: null }, 9), "Payment 6 of 6 for Senior package ($3,000).");
  assert.equal(planLine({ ...pkg, installments: 1 }, 1), null);
});
