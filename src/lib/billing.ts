/**
 * Plan billing, the parts that touch the database and Stripe (rules are in billingPlan.ts, prices in billingPricing.ts).
 * Everything here is OFF unless BILLING_ENABLED is exactly "true".
 */

import type { FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { env } from "../env.js";
import { forbidden, fromPostgrest, HttpError } from "./errors.js";
import { accessFor, type PlanPatch, type PlanRow } from "./billingPlan.js";
import { monthlyPrice, periodPrice, type BillingInterval } from "./billingPricing.js";
import { serviceClient } from "./supabase.js";
import { stripeClient } from "./stripePractice.js";

export const billingEnabled = (): boolean => env.BILLING_ENABLED === "true";

export const billingUnavailable = () => new HttpError(503, "Billing isn't switched on yet", "billing_unavailable");

const PLAN_COLUMNS =
  "counselor_id, kind, status, billing_interval, billed_students, current_period_end, cancel_at_period_end, past_due_since, money_back_used_at, access_starts_at, stripe_customer_id, stripe_subscription_id";

export type StoredPlan = PlanRow & {
  counselor_id: string;
  billing_interval: BillingInterval | null;
  billed_students: number | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

/** A Consultant's plan row, read as themselves (RLS). Null: no row yet, a new standard Consultant. */
export async function readPlan(request: FastifyRequest): Promise<StoredPlan | null> {
  const { data, error } = await request.db.from("plan_subscriptions").select(PLAN_COLUMNS).eq("counselor_id", request.auth.userId).maybeSingle();
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") throw billingUnavailable();
    throw fromPostgrest(error);
  }
  return (data as StoredPlan | null) ?? null;
}

/** Students on the Consultant's roster who are not archived: what a plan bills for. */
export async function activeStudentCount(request: FastifyRequest): Promise<number> {
  const { count, error } = await request.db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("counselor_id", request.auth.userId)
    .eq("role", "student")
    .is("archived_at", null);
  if (error) throw fromPostgrest(error);
  return count ?? 0;
}

/**
 * Called before a student is added (an invitation, an import). Off, a founding or custom plan, and an active plan all pass;
 * a new Consultant with no plan, a cancelled one, and one whose payment has been failing past the grace week do not.
 */
export async function assertCanAddStudent(request: FastifyRequest): Promise<void> {
  if (!billingEnabled() || request.profile.role !== "counselor") return;
  const plan = await readPlan(request);
  if (accessFor(plan, new Date()).canAddStudents) return;
  throw new HttpError(
    402,
    plan?.status === "past_due" ? "Update your payment details to add students." : "Choose a plan to add students.",
    "plan_required"
  );
}

/** Refuses a change while the plan is read-only or locked. Used by routes that edit practice data. */
export async function assertCanEdit(request: FastifyRequest): Promise<void> {
  if (!billingEnabled() || request.profile.role !== "counselor") return;
  if (!accessFor(await readPlan(request), new Date()).canEdit) throw forbidden("Your plan is read-only until the payment is fixed.");
}

const toCents = (dollars: number) => Math.round(dollars * 100);

export type CheckoutInput = { counselorId: string; email: string | null; interval: BillingInterval; students: number; existingCustomerId: string | null };

/** The Checkout Session parameters for a new plan. Pure: the route sends them. */
export function checkoutParams(input: CheckoutInput, urls: { success: string; cancel: string }): Stripe.Checkout.SessionCreateParams {
  const amount = toCents(periodPrice(input.students, input.interval));
  return {
    mode: "subscription",
    client_reference_id: input.counselorId,
    ...(input.existingCustomerId ? { customer: input.existingCustomerId } : input.email ? { customer_email: input.email } : {}),
    metadata: { counselor_id: input.counselorId },
    subscription_data: { metadata: { counselor_id: input.counselorId, students: String(input.students) } },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amount,
          recurring: { interval: input.interval },
          product_data: { name: "Meridies plan", description: `${Math.max(1, input.students)} student${input.students === 1 ? "" : "s"}` },
        },
      },
    ],
    custom_text: {
      submit: { message: "Full refund within your first month. Email team@meridiesai.com." },
    },
    allow_promotion_codes: false,
    success_url: urls.success,
    cancel_url: urls.cancel,
  };
}

/** Apply a webhook patch to the row with this subscription or customer. Returns false if no row matched. */
export async function updatePlanBy(
  svc: SupabaseClient,
  by: { subscriptionId?: string; customerId?: string },
  patch: PlanPatch
): Promise<boolean> {
  for (const [col, val] of [
    ["stripe_subscription_id", by.subscriptionId],
    ["stripe_customer_id", by.customerId],
  ] as const) {
    if (!val) continue;
    const next: Record<string, unknown> = { ...patch };
    // Keep the earlier start of a failing payment: a retry must not restart the ladder.
    if (patch.status === "past_due") {
      const cur = await svc.from("plan_subscriptions").select("past_due_since").eq(col, val).maybeSingle();
      if (cur.error) throw new Error(`read plan: ${cur.error.code}`);
      const prior = (cur.data as { past_due_since?: string | null } | null)?.past_due_since;
      if (prior) next.past_due_since = prior;
    }
    const { data, error } = await svc.from("plan_subscriptions").update(next).eq(col, val).select("counselor_id");
    if (error) throw new Error(`update plan: ${error.code}`);
    if ((data ?? []).length > 0) return true;
  }
  return false;
}

/**
 * Keep Stripe's amount in step with the roster: when the student count lands on a different price, change the subscription
 * (prorated). Best effort and idempotent; a failure is the caller's to log.
 */
export async function syncPlanAmount(request: FastifyRequest): Promise<{ changed: boolean }> {
  if (!billingEnabled()) return { changed: false };
  const plan = await readPlan(request);
  if (!plan || plan.kind !== "standard" || plan.status !== "active" || !plan.stripe_subscription_id || !plan.billing_interval) return { changed: false };
  const stripe = stripeClient();
  if (!stripe) throw billingUnavailable();
  const students = await activeStudentCount(request);
  if (monthlyPrice(students) === monthlyPrice(plan.billed_students ?? 0)) return { changed: false };
  const sub = await stripe.subscriptions.retrieve(plan.stripe_subscription_id);
  const item = sub.items.data[0];
  const productId = typeof item?.price.product === "string" ? item.price.product : item?.price.product.id;
  if (!item || !productId) return { changed: false };
  await stripe.subscriptions.update(sub.id, {
    items: [
      {
        id: item.id,
        price_data: { currency: "usd", product: productId, unit_amount: toCents(periodPrice(students, plan.billing_interval)), recurring: { interval: plan.billing_interval } },
      },
    ],
    proration_behavior: "create_prorations",
    metadata: { students: String(students) },
  });
  const svc = serviceClient();
  if (svc) await svc.from("plan_subscriptions").update({ billed_students: students }).eq("counselor_id", request.auth.userId);
  return { changed: true };
}
