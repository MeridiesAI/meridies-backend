/**
 * Plan billing rules, pure (no database, no Stripe client), so every rule is a test.
 *
 *  - who sees prices: only a standard plan. A founding or custom Consultant never gets a price, a student-count prompt
 *    or a price change from any route (`canSeePricing`).
 *  - what a Consultant may do: `accessFor` turns the stored plan row into what the product allows.
 *  - what a Stripe event means: `planBillingEvent` returns the change to make; billing.ts applies it.
 *
 * Failed payments (past_due), counted from `past_due_since`:
 *     day 0 to 7    full access, with a banner (Stripe is retrying the card)
 *     day 7 to 30   read-only: look and export, change nothing, add no students
 *     day 30 to 60  locked: billing and export only
 *     before access_starts_at   not_started: locked, whatever the plan's status
 *     day 60 on     closure_due: the account is queued for the 30-day export window and deletion (lib/accountClosure.ts),
 *                   which a person starts; nothing here deletes anything
 */

export type PlanKind = "standard" | "founding" | "custom";
export type PlanStatus = "none" | "active" | "past_due" | "canceled";

export type PlanRow = {
  kind: PlanKind;
  status: PlanStatus;
  past_due_since: string | null;
  money_back_used_at: string | null;
  /** Until this moment the account has no access at all (a plan set up ahead of its start). */
  access_starts_at?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
};

export type PlanState = "not_started" | "needs_plan" | "active" | "grace" | "read_only" | "locked" | "closure_due" | "canceled";

export type Access = {
  state: PlanState;
  canAddStudents: boolean;
  canEdit: boolean;
  /** Everything but billing and export is closed. */
  locked: boolean;
};

const DAY = 86_400_000;
export const GRACE_DAYS = 7;
export const READ_ONLY_DAYS = 30;
export const LOCKED_DAYS = 60;

/** A Consultant with no plan row is a new standard one. */
export const NO_PLAN: PlanRow = { kind: "standard", status: "none", past_due_since: null, money_back_used_at: null };

export const canSeePricing = (row: Pick<PlanRow, "kind"> | null): boolean => (row?.kind ?? "standard") === "standard";

export function accessFor(row: PlanRow | null, now: Date): Access {
  const plan = row ?? NO_PLAN;
  const open: Access = { state: "active", canAddStudents: true, canEdit: true, locked: false };
  // Set up ahead of time: nothing is open until the start moment, whatever Stripe says.
  if (plan.access_starts_at && now.getTime() < new Date(plan.access_starts_at).getTime()) {
    return { state: "not_started", canAddStudents: false, canEdit: false, locked: true };
  }
  if (plan.status === "active") return open;
  if (plan.status === "none") return { state: "needs_plan", canAddStudents: false, canEdit: true, locked: false };
  if (plan.status === "canceled") return { state: "canceled", canAddStudents: false, canEdit: false, locked: false };
  // past_due
  const since = plan.past_due_since ? new Date(plan.past_due_since).getTime() : now.getTime();
  const days = Math.max(0, (now.getTime() - since) / DAY);
  if (days <= GRACE_DAYS) return { state: "grace", canAddStudents: true, canEdit: true, locked: false };
  if (days <= READ_ONLY_DAYS) return { state: "read_only", canAddStudents: false, canEdit: false, locked: false };
  if (days <= LOCKED_DAYS) return { state: "locked", canAddStudents: false, canEdit: false, locked: true };
  return { state: "closure_due", canAddStudents: false, canEdit: false, locked: true };
}

/** Whole days a payment has been failing, for the banner; 0 when it is not. */
export function daysPastDue(row: PlanRow | null, now: Date): number {
  if (!row || row.status !== "past_due" || !row.past_due_since) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(row.past_due_since).getTime()) / DAY));
}

/** The first month is refundable once: never when a refund already used it. */
export const moneyBackAvailable = (row: PlanRow | null): boolean => !row?.money_back_used_at;

// ---- Stripe events ----------------------------------------------------------------------------

export type BillingEventLike = { id: string; type: string; livemode?: boolean; created?: number; data: { object: Record<string, unknown> } };

export type PlanPatch = {
  status?: PlanStatus;
  billing_interval?: "month" | "year" | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  past_due_since?: string | null;
  started_at?: string;
  canceled_at?: string | null;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  billed_students?: number | null;
};

export type BillingAction =
  | { kind: "ignore"; reason: string }
  /** Link a Stripe customer to a Consultant (checkout finished). `counselorId` came from our own checkout's metadata. */
  | { kind: "link"; counselorId: string; customerId: string; subscriptionId: string; patch: PlanPatch }
  /** Change the row that has this subscription or customer. */
  | { kind: "update"; by: { subscriptionId?: string; customerId?: string }; patch: PlanPatch }
  /** A refund that returned the whole charge: end the plan and spend the money-back. */
  | { kind: "refund-cancel"; customerId: string };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const iso = (sec: unknown): string | null => (typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : str((v as { id?: unknown } | null)?.id));

export function statusFromStripe(s: unknown): PlanStatus {
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "none"; // incomplete: checkout not finished
  }
}

function intervalOf(sub: Record<string, unknown>): "month" | "year" | null {
  const items = (sub.items as { data?: { price?: { recurring?: { interval?: string } } }[] } | undefined)?.data;
  const v = items?.[0]?.price?.recurring?.interval;
  return v === "month" || v === "year" ? v : null;
}

/** What a webhook event means for plan billing. `livemode` is the platform key's mode; an event of the other mode is ignored. */
export function planBillingEvent(event: BillingEventLike, opts: { livemode: boolean | null }): BillingAction {
  if (opts.livemode !== null && typeof event.livemode === "boolean" && event.livemode !== opts.livemode) {
    return { kind: "ignore", reason: "other mode" };
  }
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      if (o.mode !== "subscription") return { kind: "ignore", reason: "not a plan checkout" };
      const counselorId = str((o.metadata as Record<string, unknown> | undefined)?.counselor_id) ?? str(o.client_reference_id);
      const customerId = idOf(o.customer);
      const subscriptionId = idOf(o.subscription);
      if (!counselorId || !customerId || !subscriptionId) return { kind: "ignore", reason: "checkout without a Consultant" };
      return {
        kind: "link",
        counselorId,
        customerId,
        subscriptionId,
        patch: { status: "active", started_at: iso(event.created) ?? new Date().toISOString() },
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscriptionId = str(o.id);
      if (!subscriptionId) return { kind: "ignore", reason: "no subscription id" };
      const status = statusFromStripe(o.status);
      const patch: PlanPatch = {
        status,
        billing_interval: intervalOf(o),
        current_period_end: iso(o.current_period_end) ?? iso((o.items as { data?: { current_period_end?: unknown }[] } | undefined)?.data?.[0]?.current_period_end),
        cancel_at_period_end: o.cancel_at_period_end === true,
        stripe_subscription_id: subscriptionId,
      };
      const customerId = idOf(o.customer);
      if (customerId) patch.stripe_customer_id = customerId;
      if (status === "active") patch.past_due_since = null;
      return { kind: "update", by: { subscriptionId, customerId: customerId ?? undefined }, patch };
    }
    case "customer.subscription.deleted": {
      const subscriptionId = str(o.id);
      if (!subscriptionId) return { kind: "ignore", reason: "no subscription id" };
      return { kind: "update", by: { subscriptionId }, patch: { status: "canceled", canceled_at: new Date().toISOString(), cancel_at_period_end: false } };
    }
    case "invoice.paid": {
      const customerId = idOf(o.customer);
      if (!customerId) return { kind: "ignore", reason: "no customer" };
      return { kind: "update", by: { customerId }, patch: { status: "active", past_due_since: null } };
    }
    case "invoice.payment_failed": {
      const customerId = idOf(o.customer);
      if (!customerId) return { kind: "ignore", reason: "no customer" };
      // past_due_since is set only if it isn't already (the handler keeps the earlier one), so the ladder isn't reset by a retry.
      return { kind: "update", by: { customerId }, patch: { status: "past_due", past_due_since: iso(event.created) ?? new Date().toISOString() } };
    }
    case "charge.refunded": {
      const customerId = idOf(o.customer);
      const amount = typeof o.amount === "number" ? o.amount : 0;
      const refunded = typeof o.amount_refunded === "number" ? o.amount_refunded : 0;
      if (!customerId || amount <= 0 || refunded < amount) return { kind: "ignore", reason: "not a full refund of a plan charge" };
      return { kind: "refund-cancel", customerId };
    }
    default:
      return { kind: "ignore", reason: "not a plan event" };
  }
}
