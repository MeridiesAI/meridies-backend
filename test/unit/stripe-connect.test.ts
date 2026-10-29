import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import { deriveAccount } from "../../src/lib/payments.js";
import {
  cardPaymentRow,
  checkPaymentTarget,
  dateIn,
  invoiceOwed,
  isDuplicate,
  META_CONTACT,
  META_INVOICE,
  META_PRACTICE,
  PAY_TOKEN,
  payLinkBlock,
  payUrl,
  planStripeEvent,
  refundedFor,
  refundWithoutPayment,
  stripeStatus,
  type StripeAction,
} from "../../src/lib/stripeConnect.js";

const INVOICE = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const PRACTICE = "33333333-3333-4333-8333-333333333333";
const ACCT = "acct_1PracticeAbc";

const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_test_1",
  object: "checkout.session",
  mode: "payment",
  payment_status: "paid",
  currency: "usd",
  amount_total: 50000,
  payment_intent: "pi_1",
  metadata: { [META_INVOICE]: INVOICE, [META_CONTACT]: CONTACT, [META_PRACTICE]: PRACTICE },
  ...over,
});
const event = (type: string, object: unknown, over: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type,
  account: ACCT,
  created: 1_793_000_000,
  data: { object },
  ...over,
});
const record = (over: Record<string, unknown> = {}) => planStripeEvent(event("checkout.session.completed", session(over)));

// ---- Reading events ---------------------------------------------------------

test("a paid Meridies Checkout Session is a payment to record", () => {
  const a = record();
  assert.equal(a.kind, "record-payment");
  if (a.kind !== "record-payment") return;
  assert.equal(a.invoiceId, INVOICE);
  assert.equal(a.contactId, CONTACT);
  assert.equal(a.practiceId, PRACTICE);
  assert.equal(a.amountCents, 50000);
  assert.equal(a.paymentIntentId, "pi_1");
  assert.equal(a.sessionId, "cs_test_1");
  assert.equal(a.account, ACCT);
});

test("an expanded PaymentIntent reads the same as its id", () => {
  const a = record({ payment_intent: { id: "pi_2", object: "payment_intent" } });
  assert.equal(a.kind === "record-payment" && a.paymentIntentId, "pi_2");
});

test("the async success event records too; an unpaid completion waits for it", () => {
  assert.equal(planStripeEvent(event("checkout.session.async_payment_succeeded", session())).kind, "record-payment");
  const waiting = record({ payment_status: "unpaid" });
  assert.equal(waiting.kind, "ignore");
});

test("sessions that aren't a Meridies pay link are ignored", () => {
  const cases: Array<[string, StripeAction]> = [
    ["no invoice metadata", record({ metadata: {} })],
    ["a bad invoice id", record({ metadata: { [META_INVOICE]: "INV-1001" } })],
    ["a subscription", record({ mode: "subscription" })],
    ["another currency", record({ currency: "eur" })],
    ["a zero amount", record({ amount_total: 0 })],
    ["no PaymentIntent", record({ payment_intent: null })],
    ["the platform's own account", planStripeEvent(event("checkout.session.completed", session(), { account: undefined }))],
  ];
  for (const [why, a] of cases) assert.equal(a.kind, "ignore", why);
});

test("a refund carries Stripe's running total, and says whether the charge was ours", () => {
  const a = planStripeEvent(
    event("charge.refunded", { id: "ch_1", object: "charge", amount_refunded: 20000, payment_intent: "pi_1", metadata: { [META_INVOICE]: INVOICE } })
  );
  assert.deepEqual(a, { kind: "refund", eventId: "evt_1", account: ACCT, chargeId: "ch_1", paymentIntentId: "pi_1", refundedCents: 20000, meridies: true });
  if (a.kind === "refund") assert.equal(refundWithoutPayment(a), "retry", "ours but not recorded yet: Stripe retries");
  const other = planStripeEvent(event("charge.refunded", { id: "ch_2", amount_refunded: 500, payment_intent: "pi_9", metadata: {} }));
  if (other.kind === "refund") assert.equal(refundWithoutPayment(other), "ignore", "the practice's other business");
});

test("a changed Refund object re-reads its charge", () => {
  for (const type of ["charge.refund.updated", "refund.updated", "refund.failed"]) {
    assert.deepEqual(planStripeEvent(event(type, { id: "re_1", object: "refund", charge: "ch_1" })), {
      kind: "refund-recheck",
      eventId: "evt_1",
      account: ACCT,
      chargeId: "ch_1",
    });
  }
});

test("account.updated sets the flags; a deauthorization turns them off", () => {
  assert.deepEqual(
    planStripeEvent(event("account.updated", { id: ACCT, object: "account", charges_enabled: true, payouts_enabled: false, details_submitted: true })),
    { kind: "account", eventId: "evt_1", account: ACCT, chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true }
  );
  assert.deepEqual(planStripeEvent(event("account.application.deauthorized", { id: "ca_1", object: "application" })), {
    kind: "account",
    eventId: "evt_1",
    account: ACCT,
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
  });
});

test("anything else is ignored", () => {
  assert.equal(planStripeEvent(event("customer.created", { id: "cus_1" })).kind, "ignore");
});

// ---- Recording ---------------------------------------------------------------

const invoice = { id: INVOICE, contactId: CONTACT, practiceId: PRACTICE, number: "INV-1001" };
const recordAction = () => {
  const a = record();
  assert.equal(a.kind, "record-payment");
  return a as Extract<StripeAction, { kind: "record-payment" }>;
};

test("a payment counts only on the issuing practice's own account, with matching metadata", () => {
  const a = recordAction();
  assert.deepEqual(checkPaymentTarget(a, invoice, ACCT), { ok: true });
  assert.deepEqual(checkPaymentTarget(a, invoice, null), { ok: false, reason: "account-mismatch" });
  assert.deepEqual(checkPaymentTarget(a, invoice, "acct_someoneElse"), { ok: false, reason: "account-mismatch" });
  assert.deepEqual(checkPaymentTarget(a, { ...invoice, contactId: "44444444-4444-4444-8444-444444444444" }, ACCT), {
    ok: false,
    reason: "contact-mismatch",
  });
  assert.deepEqual(checkPaymentTarget(a, { ...invoice, practiceId: "55555555-5555-4555-8555-555555555555" }, ACCT), {
    ok: false,
    reason: "practice-mismatch",
  });
});

const pkg = { contact_id: CONTACT, package_name: "Senior", total_cents: 100000, installments: 2 };
const inv = { id: INVOICE, number: "INV-1001", label: "Deposit", amount_cents: 50000, issued_on: "2026-10-01", due_on: "2026-11-01", created_at: "2026-10-01" };

test("the payment row is a card payment keyed by its PaymentIntent", () => {
  const account = deriveAccount(pkg, [inv], [], "2026-10-29");
  const row = cardPaymentRow(recordAction(), invoice, account, { credits: true, timezone: "America/Los_Angeles" });
  assert.equal(row.contact_id, CONTACT);
  assert.equal(row.invoice_id, INVOICE);
  assert.equal(row.amount_cents, 50000);
  assert.equal(row.method, "card");
  assert.equal(row.via_stripe, true);
  assert.equal(row.stripe_payment_intent_id, "pi_1");
  assert.equal(row.stripe_checkout_session_id, "cs_test_1");
  assert.equal(row.created_by, null);
  assert.equal(row.credit_cents, undefined, "within what's left: no credit");
  assert.equal(row.note, "Paid by card · INV-1001");
  assert.match(String(row.received_on), /^\d{4}-\d{2}-\d{2}$/);
});

test("a card payment above what the package has left holds the extra as credit", () => {
  // Already paid $800 of $1,000 by cheque; the family then pays the $500 invoice by card.
  const account = deriveAccount(pkg, [inv], [{ id: "p", amount_cents: 80000, received_on: "2026-10-02", method: "check", created_at: "2026-10-02" }], "2026-10-29");
  const row = cardPaymentRow(recordAction(), invoice, account, { credits: true, timezone: null });
  assert.equal(row.credit_cents, 30000);
  const noCredits = cardPaymentRow(recordAction(), invoice, account, { credits: false, timezone: null });
  assert.equal(noCredits.credit_cents, undefined, "without the credits migration the extra shows as unmarked credit");
});

test("the received date is the practice's local date", () => {
  // 2026-10-30 03:00 UTC is still the 29th in Los Angeles.
  const t = Date.UTC(2026, 9, 30, 3, 0, 0) / 1000;
  assert.equal(dateIn(t, "America/Los_Angeles"), "2026-10-29");
  assert.equal(dateIn(t, "UTC"), "2026-10-30");
  assert.equal(dateIn(t, "Not/AZone"), "2026-10-30", "a bad zone falls back to UTC");
});

test("idempotency: a duplicate insert is recognised, and a refund is Stripe's total, not an increment", () => {
  assert.equal(isDuplicate({ code: "23505" }), true);
  assert.equal(isDuplicate({ code: "23514" }), false);
  assert.equal(isDuplicate(null), false);
  // The same charge.refunded delivered twice writes the same number twice.
  assert.equal(refundedFor(50000, 20000), 20000);
  assert.equal(refundedFor(50000, 20000), 20000);
  assert.equal(refundedFor(50000, 90000), 50000, "never above the payment");
  assert.equal(refundedFor(50000, -5), 0);
});

// ---- Pay links and status --------------------------------------------------------

test("an invoice gets a pay link only while it's owed and the practice takes cards", () => {
  assert.equal(payLinkBlock("open", 5000, true), null);
  assert.equal(payLinkBlock("overdue", 5000, true), null);
  assert.equal(payLinkBlock("void", 5000, true), "void");
  assert.equal(payLinkBlock("paid", 0, true), "paid");
  assert.equal(payLinkBlock("open", 0, true), "paid");
  assert.equal(payLinkBlock("open", 5000, false), "not-connected");
});

test("what an invoice still owes is its amount less credit applied and what payments settled", () => {
  const a = deriveAccount(pkg, [{ ...inv, credit_applied_cents: 10000 }], [{ id: "p", amount_cents: 15000, received_on: "2026-10-02", method: "check", created_at: "2026-10-02" }], "2026-10-29");
  const o = invoiceOwed(a, INVOICE);
  assert.equal(o.state, "open");
  assert.equal(o.owedCents, 25000);
  assert.deepEqual(invoiceOwed(a, "nope"), { state: null, owedCents: 0, invoice: null });
});

test("a pay link is the API's own address with a 43-character token", () => {
  assert.equal(payUrl("https://api.example.com/", "a".repeat(43)), `https://api.example.com/pay/${"a".repeat(43)}`);
  assert.ok(PAY_TOKEN.test("A".repeat(42) + "_"));
  assert.ok(!PAY_TOKEN.test("short"));
  assert.ok(!PAY_TOKEN.test("a".repeat(42) + "/"));
});

test("not switched on is calm: configured false and nothing else", () => {
  assert.deepEqual(stripeStatus(false, true, { charges_enabled: true }), {
    configured: false,
    connected: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    canManage: true,
  });
  assert.deepEqual(stripeStatus(true, false, null), { configured: true, connected: false, chargesEnabled: false, payoutsEnabled: false, canManage: false });
  assert.deepEqual(stripeStatus(true, true, { charges_enabled: true, payouts_enabled: true }), {
    configured: true,
    connected: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    canManage: true,
  });
});

// ---- Signature: the real SDK's check over the raw body ------------------------------

test("an event read through the SDK's signature check plans the same; a tampered body is refused", () => {
  const stripe = new Stripe("sk_test_unit000000000000");
  const secret = "whsec_unittestsecret000000";
  const payload = JSON.stringify(event("checkout.session.completed", session()));
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const verified = stripe.webhooks.constructEvent(payload, header, secret);
  assert.equal(planStripeEvent(verified).kind, "record-payment");
  assert.throws(() => stripe.webhooks.constructEvent(payload.replace("50000", "1"), header, secret));
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, "whsec_otherSecret0000000"));
});
