/**
 * Stripe's plan-billing webhook: POST /webhooks/stripe-billing, signed with STRIPE_BILLING_WEBHOOK_SECRET.
 *
 * A separate endpoint with its own secret from the Connect webhook (/webhooks/stripe, STRIPE_WEBHOOK_SECRET), so a
 * billing event can never reach the invoice-payment code and a practice's payment event can never change a plan:
 * each endpoint verifies only its own signature. `lib/billingPlan.ts` decides what an event means; this applies it.
 *
 * Handled event ids go in plan_billing_events, so a redelivery is answered without work (every change is idempotent
 * anyway). A 5xx makes Stripe retry.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { env } from "../env.js";
import { billingEnabled, updatePlanBy } from "../lib/billing.js";
import { planBillingEvent, type BillingAction, type BillingEventLike } from "../lib/billingPlan.js";
import { HttpError } from "../lib/errors.js";
import { serializeErr } from "../lib/requestLog.js";
import { keyLivemode } from "../lib/stripeConnect.js";
import { stripeClient } from "../lib/stripePractice.js";
import { serviceClient } from "../lib/supabase.js";

export type BillingWebhookDeps = {
  stripe: Pick<Stripe, "webhooks" | "subscriptions"> | null;
  svc: SupabaseClient | null;
  secret: string | null;
  livemode: boolean | null;
  enabled: boolean;
};

function envDeps(): BillingWebhookDeps {
  return {
    stripe: stripeClient(),
    svc: serviceClient(),
    secret: env.STRIPE_BILLING_WEBHOOK_SECRET ?? null,
    livemode: keyLivemode(env.STRIPE_SECRET_KEY),
    enabled: billingEnabled(),
  };
}

const retry = (m: string) => new HttpError(503, m, "stripe_retry");
const unavailable = () => new HttpError(503, "Plan billing isn't switched on yet", "billing_unavailable");

/** Do what an action means. Exported for tests. */
export async function applyBillingAction(deps: Pick<BillingWebhookDeps, "stripe">, svc: SupabaseClient, action: BillingAction): Promise<string> {
  switch (action.kind) {
    case "ignore":
      return action.reason;
    case "link": {
      // Our own checkout named the Consultant. A row may exist (a founding or custom account): its kind is kept.
      const { error } = await svc.from("plan_subscriptions").upsert(
        { counselor_id: action.counselorId, stripe_customer_id: action.customerId, stripe_subscription_id: action.subscriptionId, ...action.patch },
        { onConflict: "counselor_id" }
      );
      if (error) throw new Error(`link plan: ${error.code}`);
      return "linked";
    }
    case "update":
      return (await updatePlanBy(svc, action.by, action.patch)) ? "updated" : "no matching plan";
    case "refund-cancel": {
      const found = await svc
        .from("plan_subscriptions")
        .select("counselor_id, stripe_subscription_id, money_back_used_at")
        .eq("stripe_customer_id", action.customerId)
        .maybeSingle();
      if (found.error) throw new Error(`read plan: ${found.error.code}`);
      const row = found.data as { counselor_id: string; stripe_subscription_id: string | null; money_back_used_at: string | null } | null;
      if (!row) return "no matching plan";
      if (row.money_back_used_at) return "money-back already used";
      if (row.stripe_subscription_id && deps.stripe) {
        try {
          await deps.stripe.subscriptions.cancel(row.stripe_subscription_id);
        } catch (err) {
          // Already cancelled in Stripe is fine; anything else is retried.
          if ((err as { code?: string }).code !== "resource_missing") throw err;
        }
      }
      const { error } = await svc
        .from("plan_subscriptions")
        .update({ status: "canceled", canceled_at: new Date().toISOString(), money_back_used_at: new Date().toISOString() })
        .eq("counselor_id", row.counselor_id);
      if (error) throw new Error(`cancel plan: ${error.code}`);
      return "refunded and cancelled";
    }
  }
}

export default async function billingWebhookRoutes(app: FastifyInstance, opts: { deps?: () => BillingWebhookDeps } = {}) {
  const depsOf = opts.deps ?? envDeps;
  // The signature is over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post("/stripe-billing", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply: FastifyReply) => {
    const deps = depsOf();
    const { stripe, svc, secret } = deps;
    if (!deps.enabled || !stripe || !svc || !secret) throw unavailable();

    const raw = typeof request.body === "string" ? request.body : "";
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || !signature) return reply.code(400).send({ error: "Invalid signature" });
    let event: BillingEventLike;
    try {
      event = stripe.webhooks.constructEvent(raw, signature, secret) as unknown as BillingEventLike;
    } catch {
      return reply.code(400).send({ error: "Invalid signature" });
    }

    const done = await svc.from("plan_billing_events").select("id").eq("id", event.id).maybeSingle();
    if (done.error) {
      request.log.error({ err: serializeErr(done.error) }, "billing webhook: could not read handled events");
      throw retry("Try again");
    }
    if (done.data) return { received: true, duplicate: true };

    let outcome: string;
    try {
      outcome = await applyBillingAction(deps, svc, planBillingEvent(event, { livemode: deps.livemode }));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      request.log.error({ err: serializeErr(err), type: event.type }, "billing webhook: could not handle the event");
      throw retry("Try again");
    }

    const { error } = await svc.from("plan_billing_events").insert({ id: event.id, type: event.type.slice(0, 120) });
    if (error && error.code !== "23505") request.log.warn({ err: serializeErr(error) }, "billing webhook: could not note the event");
    request.log.info({ type: event.type, outcome }, "billing webhook");
    return { received: true, outcome };
  });
}
