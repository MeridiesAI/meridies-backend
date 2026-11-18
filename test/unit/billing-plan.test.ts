import assert from "node:assert/strict";
import test from "node:test";
import { accessFor, canSeePricing, daysPastDue, moneyBackAvailable, planBillingEvent, NO_PLAN, type PlanRow } from "../../src/lib/billingPlan.js";

const now = new Date("2026-12-01T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const row = (over: Partial<PlanRow>): PlanRow => ({ ...NO_PLAN, ...over });

test("only a standard plan ever sees a price", () => {
  assert.equal(canSeePricing(null), true);
  assert.equal(canSeePricing(row({ kind: "standard" })), true);
  assert.equal(canSeePricing(row({ kind: "founding" })), false);
  assert.equal(canSeePricing(row({ kind: "custom" })), false);
});

test("a new Consultant has no plan: can look around, cannot add a student", () => {
  const a = accessFor(null, now);
  assert.deepEqual([a.state, a.canAddStudents, a.canEdit], ["needs_plan", false, true]);
});

test("an active plan has full access", () => {
  const a = accessFor(row({ status: "active" }), now);
  assert.deepEqual([a.state, a.canAddStudents, a.canEdit, a.locked], ["active", true, true, false]);
});

test("the failed-payment ladder: grace to day 7, read-only to 30, locked to 60, then closure", () => {
  const at = (d: number) => accessFor(row({ status: "past_due", past_due_since: daysAgo(d) }), now);
  assert.equal(at(3).state, "grace");
  assert.equal(at(3).canEdit, true);
  assert.equal(at(8).state, "read_only");
  assert.equal(at(8).canEdit, false);
  assert.equal(at(8).canAddStudents, false);
  assert.equal(at(31).state, "locked");
  assert.equal(at(31).locked, true);
  assert.equal(at(61).state, "closure_due");
});

test("a cancelled plan is closed to edits and new students, founding included", () => {
  for (const kind of ["standard", "founding", "custom"] as const) {
    const a = accessFor(row({ kind, status: "canceled" }), now);
    assert.deepEqual([a.state, a.canEdit, a.canAddStudents], ["canceled", false, false]);
  }
});

test("days past due, only while past due", () => {
  assert.equal(daysPastDue(row({ status: "past_due", past_due_since: daysAgo(5) }), now), 5);
  assert.equal(daysPastDue(row({ status: "active", past_due_since: daysAgo(5) }), now), 0);
});

test("the money-back is once per customer", () => {
  assert.equal(moneyBackAvailable(null), true);
  assert.equal(moneyBackAvailable(row({ money_back_used_at: daysAgo(1) })), false);
});

const ev = (type: string, object: Record<string, unknown>, extra: object = {}) => ({ id: "evt_1", type, data: { object }, ...extra });

test("checkout links the customer to the Consultant named in our own metadata", () => {
  const a = planBillingEvent(
    ev("checkout.session.completed", { mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: { counselor_id: "c-1" } }),
    { livemode: null }
  );
  assert.equal(a.kind, "link");
  if (a.kind === "link") assert.deepEqual([a.counselorId, a.customerId, a.subscriptionId], ["c-1", "cus_1", "sub_1"]);
  // not one of our plan checkouts
  assert.equal(planBillingEvent(ev("checkout.session.completed", { mode: "payment", customer: "cus_1" }), { livemode: null }).kind, "ignore");
  assert.equal(planBillingEvent(ev("checkout.session.completed", { mode: "subscription", customer: "cus_1", subscription: "sub_1" }), { livemode: null }).kind, "ignore");
});

test("subscription updates map Stripe's status", () => {
  const sub = (status: string) =>
    planBillingEvent(ev("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status, items: { data: [{ price: { recurring: { interval: "year" } } }] } }), { livemode: null });
  const active = sub("active");
  assert.equal(active.kind, "update");
  if (active.kind === "update") {
    assert.equal(active.patch.status, "active");
    assert.equal(active.patch.billing_interval, "year");
    assert.equal(active.patch.past_due_since, null);
  }
  const unpaid = sub("unpaid");
  if (unpaid.kind === "update") assert.equal(unpaid.patch.status, "past_due");
});

test("a failed invoice starts the ladder and a paid one clears it", () => {
  const failed = planBillingEvent(ev("invoice.payment_failed", { customer: "cus_1" }, { created: 1_800_000_000 }), { livemode: null });
  if (failed.kind === "update") assert.equal(failed.patch.status, "past_due");
  else assert.fail("expected update");
  const paid = planBillingEvent(ev("invoice.paid", { customer: "cus_1" }), { livemode: null });
  if (paid.kind === "update") assert.deepEqual([paid.patch.status, paid.patch.past_due_since], ["active", null]);
  else assert.fail("expected update");
});

test("only a full refund cancels the plan", () => {
  assert.equal(planBillingEvent(ev("charge.refunded", { customer: "cus_1", amount: 9900, amount_refunded: 9900 }), { livemode: null }).kind, "refund-cancel");
  assert.equal(planBillingEvent(ev("charge.refunded", { customer: "cus_1", amount: 9900, amount_refunded: 4000 }), { livemode: null }).kind, "ignore");
});

test("an event of the other mode, or an unrelated event, is ignored", () => {
  assert.equal(planBillingEvent(ev("invoice.paid", { customer: "cus_1" }, { livemode: true }), { livemode: false }).kind, "ignore");
  assert.equal(planBillingEvent(ev("payment_intent.succeeded", {}), { livemode: null }).kind, "ignore");
});
