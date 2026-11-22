import assert from "node:assert/strict";
import test from "node:test";
import { NO_PLAN, type PlanRow } from "../../src/lib/billingPlan.js";
import { planGate, planGateError } from "../../src/lib/planGate.js";

const now = new Date("2026-12-01T00:00:00Z");
const plan = (over: Partial<PlanRow>): PlanRow => ({ ...NO_PLAN, ...over });
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

test("an active plan is never gated", () => {
  assert.equal(planGate(plan({ status: "active" }), now, "POST", undefined), null);
});

test("a Consultant with no payment is locked out of everything except the allowPending routes", () => {
  assert.equal(planGate(null, now, "GET", undefined), "locked");
  assert.equal(planGate(plan({ status: "none" }), now, "POST", undefined), "locked");
  assert.equal(planGateError("locked", null, now).code, "plan_required");
  // who-am-I, billing and onboarding's own routes stay open so they can sign in, choose a plan and finish setup
  assert.equal(planGate(null, now, "GET", true), null);
});

test("before the start date every route is closed, reads included", () => {
  const p = plan({ kind: "founding", status: "active", access_starts_at: "2027-01-01T00:00:00Z" });
  assert.equal(planGate(p, now, "GET", undefined), "locked");
  assert.equal(planGate(p, now, "POST", undefined), "locked");
  assert.equal(planGateError("locked", p, now).code, "plan_not_started");
  // after the date it opens
  assert.equal(planGate(p, new Date("2027-01-02T00:00:00Z"), "POST", undefined), null);
});

test("routes marked allowPending (who-am-I, billing, terms, export) stay open for a locked account", () => {
  const p = plan({ kind: "founding", status: "active", access_starts_at: "2027-01-01T00:00:00Z" });
  assert.equal(planGate(p, now, "GET", true), null);
  assert.equal(planGate(plan({ status: "past_due", past_due_since: daysAgo(40) }), now, "POST", true), null);
});

test("read-only lets reads through and closes writes", () => {
  const p = plan({ status: "past_due", past_due_since: daysAgo(10) });
  assert.equal(planGate(p, now, "GET", undefined), null);
  assert.equal(planGate(p, now, "HEAD", undefined), null);
  assert.equal(planGate(p, now, "PATCH", undefined), "read_only");
  assert.equal(planGateError("read_only", p, now).code, "plan_read_only");
});

test("locked after 30 days of a failing payment closes everything", () => {
  const p = plan({ status: "past_due", past_due_since: daysAgo(35) });
  assert.equal(planGate(p, now, "GET", undefined), "locked");
  assert.equal(planGateError("locked", p, now).code, "plan_locked");
});

test("a cancelled plan is read-only", () => {
  assert.equal(planGate(plan({ status: "canceled" }), now, "DELETE", undefined), "read_only");
  assert.equal(planGate(plan({ status: "canceled" }), now, "GET", undefined), null);
});
