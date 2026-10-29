import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAccount, netOfRefund, toPaymentDTO } from "../../src/lib/payments.js";

const pkg = (total: number, installments = 2) => ({ contact_id: "c", package_name: "Senior package", total_cents: total, installments });
const inv = (id: string, cents: number, issued: string, due: string) => ({
  id, number: id, label: id, amount_cents: cents, credit_applied_cents: 0, issued_on: issued, due_on: due, created_at: issued,
});
const card = (id: string, cents: number, on: string, refunded = 0, credit = 0) => ({
  id, amount_cents: cents, credit_cents: credit, refunded_cents: refunded, via_stripe: true, received_on: on, method: "card", created_at: on,
});
const TODAY = "2026-10-29";

test("a payment row carries viaStripe and refundedCents, defaulting for rows from before card payments", () => {
  const old = toPaymentDTO({ id: "p", amount_cents: 100, received_on: TODAY, method: "check", created_at: TODAY });
  assert.equal(old.viaStripe, false);
  assert.equal(old.refundedCents, 0);
  const c = toPaymentDTO(card("q", 5000, TODAY, 1200));
  assert.equal(c.viaStripe, true);
  assert.equal(c.refundedCents, 1200);
});

test("a refund comes off held credit first, then off what the payment brought in", () => {
  assert.deepEqual(netOfRefund({ amountCents: 1000, creditCents: 300, refundedCents: 200 }), { netCents: 800, heldCents: 100 });
  assert.deepEqual(netOfRefund({ amountCents: 1000, creditCents: 300, refundedCents: 500 }), { netCents: 500, heldCents: 0 });
  assert.deepEqual(netOfRefund({ amountCents: 1000, creditCents: 0, refundedCents: 5000 }), { netCents: 0, heldCents: 0 }, "never below zero");
});

test("a card payment settles its invoice like any payment", () => {
  const a = deriveAccount(pkg(100000), [inv("1", 50000, "2026-10-01", "2026-10-15")], [card("p", 50000, "2026-10-10")], TODAY);
  assert.equal(a.invoices[0].state, "paid");
  assert.equal(a.paidCents, 50000);
  assert.equal(a.payments[0].viaStripe, true);
});

test("a fully refunded card payment stops counting and the invoice is owed again", () => {
  const a = deriveAccount(pkg(100000), [inv("1", 50000, "2026-10-01", "2026-10-15")], [card("p", 50000, "2026-10-10", 50000)], TODAY);
  assert.equal(a.paidCents, 0);
  assert.equal(a.collectedCents, 0);
  assert.equal(a.invoices[0].state, "overdue");
  assert.equal(a.overdueCents, 50000);
  assert.equal(a.payments.length, 1, "the payment stays on the record");
  assert.equal(a.payments[0].refundedCents, 50000);
});

test("a partly refunded card payment counts for what's left", () => {
  const a = deriveAccount(pkg(100000), [inv("1", 50000, "2026-10-01", "2026-11-15")], [card("p", 50000, "2026-10-10", 20000)], TODAY);
  assert.equal(a.paidCents, 30000);
  assert.equal(a.invoices[0].paidCents, 30000);
  assert.equal(a.invoices[0].state, "open");
  assert.equal(a.nextDue?.owedCents, 20000);
});

test("refunding a card overpayment's extra clears the credit and leaves the package paid", () => {
  // $500 package, paid $700 by card ($200 held as credit), $200 refunded in Stripe.
  const a = deriveAccount(pkg(50000, 1), [inv("1", 50000, "2026-10-01", "2026-10-15")], [card("p", 70000, "2026-10-10", 20000, 20000)], TODAY);
  assert.equal(a.creditCents, 0);
  assert.equal(a.paidCents, 50000);
  assert.equal(a.status, "paid-up");
});
