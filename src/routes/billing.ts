/**
 * Plan billing for Consultants (Feature 4). Everything answers `{ enabled: false }` or 503 billing_unavailable unless
 * BILLING_ENABLED=true.
 *
 *   GET  /billing/plan      what plan the caller is on and what it allows. Prices appear ONLY for a standard plan:
 *                           a founding or custom Consultant never gets a number, a count prompt or a price change.
 *   GET  /billing/preview   { add } the price now and after adding that many students (standard plans only)
 *   POST /billing/checkout  { interval } a Stripe Checkout link for a new standard plan
 *   POST /billing/portal    a Stripe customer-portal link (update card, see invoices)
 *   POST /billing/sync      move the Stripe amount to the roster's current price (standard, active plans)
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { activeStudentCount, billingEnabled, billingUnavailable, checkoutParams, readPlan, syncPlanAmount } from "../lib/billing.js";
import { accessFor, canSeePricing, daysPastDue, moneyBackAvailable } from "../lib/billingPlan.js";
import { monthlyPrice, periodPrice, priceChange } from "../lib/billingPricing.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { stripeClient } from "../lib/stripePractice.js";

const checkoutBody = z.object({ interval: z.enum(["month", "year"]) }).strict();
const previewQuery = z.object({ add: z.coerce.number().int().min(1).max(500).default(1) });

export default async function billingRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];
  const config = { allowPending: true };
  const urls = () => ({
    success: `${env.APP_URL.replace(/\/+$/, "")}/dashboard/counselor/billing?checkout=done`,
    cancel: `${env.APP_URL.replace(/\/+$/, "")}/dashboard/counselor/billing?checkout=cancelled`,
  });

  app.get("/plan", { preHandler: [...counselor, limit("billing:plan", 120, 60)], config }, async (request) => {
    if (!billingEnabled()) return { enabled: false };
    const plan = await readPlan(request);
    const now = new Date();
    const access = accessFor(plan, now);
    const kind = plan?.kind ?? "standard";
    const students = await activeStudentCount(request);
    const base = {
      enabled: true,
      kind,
      status: plan?.status ?? "none",
      state: access.state,
      canAddStudents: access.canAddStudents,
      canEdit: access.canEdit,
      locked: access.locked,
      daysPastDue: daysPastDue(plan, now),
      currentPeriodEnd: plan?.current_period_end ?? null,
      cancelAtPeriodEnd: plan?.cancel_at_period_end ?? false,
      hasBillingPortal: Boolean(plan?.stripe_customer_id),
    };
    if (!canSeePricing(plan)) return base;
    const interval = plan?.billing_interval ?? "month";
    return {
      ...base,
      students,
      interval,
      price: periodPrice(students, interval),
      monthlyPrice: monthlyPrice(students),
      moneyBackAvailable: moneyBackAvailable(plan),
    };
  });

  app.get("/preview", { preHandler: [...counselor, limit("billing:preview", 120, 60)], config }, async (request) => {
    if (!billingEnabled()) throw billingUnavailable();
    const plan = await readPlan(request);
    // A founding or custom Consultant has no price to preview: say so as "not found", not "forbidden".
    if (!canSeePricing(plan)) throw notFound("Not found");
    const { add } = previewQuery.parse(request.query);
    const students = await activeStudentCount(request);
    const interval = plan?.billing_interval ?? "month";
    return { students, add, interval, ...priceChange(students, students + add, interval) };
  });

  app.post("/checkout", { preHandler: [...counselor, limit("billing:checkout", 20, 3600)], config }, async (request) => {
    if (!billingEnabled()) throw billingUnavailable();
    const stripe = stripeClient();
    if (!stripe) throw billingUnavailable();
    const body = checkoutBody.parse(request.body);
    const plan = await readPlan(request);
    if (!canSeePricing(plan)) throw notFound("Not found");
    if (plan?.status === "active" || plan?.status === "past_due") throw conflict("You already have a plan. Use Manage billing to change it.");
    const students = await activeStudentCount(request);
    const session = await stripe.checkout.sessions.create(
      checkoutParams(
        { counselorId: request.auth.userId, email: request.profile.email ?? null, interval: body.interval, students, existingCustomerId: plan?.stripe_customer_id ?? null },
        urls()
      )
    );
    if (!session.url) throw badRequest("Stripe didn't return a checkout link. Try again.");
    return { url: session.url };
  });

  app.post("/portal", { preHandler: [...counselor, limit("billing:portal", 30, 3600)], config }, async (request) => {
    if (!billingEnabled()) throw billingUnavailable();
    const stripe = stripeClient();
    if (!stripe) throw billingUnavailable();
    const plan = await readPlan(request);
    if (!plan?.stripe_customer_id) throw notFound("You don't have a billing account yet");
    const session = await stripe.billingPortal.sessions.create({
      customer: plan.stripe_customer_id,
      return_url: `${env.APP_URL.replace(/\/+$/, "")}/dashboard/counselor/billing`,
    });
    return { url: session.url };
  });

  app.post("/sync", { preHandler: [...counselor, limit("billing:sync", 60, 3600)], config }, async (request) => {
    if (!billingEnabled()) throw billingUnavailable();
    return syncPlanAmount(request);
  });
}
