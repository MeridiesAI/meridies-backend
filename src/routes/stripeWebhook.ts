/**
 * Stripe's Connect webhook: card payments and refunds on the practices'
 * connected accounts, and those accounts' status.
 *
 *   POST /webhooks/stripe
 *
 * The signature (Stripe-Signature, STRIPE_WEBHOOK_SECRET) is checked over the
 * raw body before anything is read. `lib/stripeConnect.ts` decides what an
 * event means; this file does it with the service role (nobody is signed in):
 *
 *   checkout.session.completed / .async_payment_succeeded   record the payment
 *       against the invoice's family, once per PaymentIntent, and only when it
 *       was taken on the account of the practice that issued the invoice.
 *   charge.refunded, charge.refund.updated, refund.updated / .failed
 *       set the payment's refunded_cents to Stripe's running total.
 *   account.updated, account.application.deauthorized
 *       the practice's charges / payouts flags.
 *
 * Handled event ids go in stripe_webhook_events, so a redelivery is answered
 * without work; everything it does is idempotent anyway. A 5xx makes Stripe
 * retry (for up to three days): used while card payments aren't switched on,
 * on a database error, and for a refund of a Meridies payment that isn't
 * recorded yet.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, hasStripe } from "../env.js";
import { todayIn } from "../lib/crm.js";
import { HttpError } from "../lib/errors.js";
import { serializeErr } from "../lib/requestLog.js";
import {
  cardPaymentRow,
  checkPaymentTarget,
  isDuplicate,
  planStripeEvent,
  refundedFor,
  refundWithoutPayment,
  stripeUnavailable,
  type StripeAction,
  type StripeEventLike,
} from "../lib/stripeConnect.js";
import { practiceAccount, readAccount, stripeClient, stripeReady } from "../lib/stripePractice.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

/** Retry later: Stripe redelivers on anything but 2xx. */
const retry = (message: string) => new HttpError(503, message, "stripe_retry");

function dbFail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}: ${error?.code ?? "unknown"}`);
}

async function recordPayment(svc: SupabaseClient, a: Extract<StripeAction, { kind: "record-payment" }>): Promise<string> {
  const inv = await svc.from("pipeline_invoices").select("id, contact_id, number, number_scope").eq("id", a.invoiceId).maybeSingle();
  if (inv.error) dbFail("read invoice", inv.error);
  if (!inv.data) return "invoice not found";
  const invoice = {
    id: String(inv.data.id),
    contactId: String(inv.data.contact_id),
    practiceId: String(inv.data.number_scope),
    number: String(inv.data.number),
  };
  const acct = await practiceAccount(svc, invoice.practiceId);
  const check = checkPaymentTarget(a, invoice, acct ? String(acct.stripe_account_id) : null);
  if (!check.ok) return check.reason;

  // Already recorded (a redelivery, or the other of completed / async_payment_succeeded).
  const seen = await svc.from("pipeline_payments").select("id").eq("stripe_payment_intent_id", a.paymentIntentId).maybeSingle();
  if (seen.error) dbFail("read payment", seen.error);
  if (seen.data) return "already recorded";

  const contact = await svc.from("pipeline_contacts").select("counselor_id").eq("id", invoice.contactId).maybeSingle();
  if (contact.error) dbFail("read contact", contact.error);
  const prof = contact.data
    ? await svc.from("profiles").select("timezone").eq("id", String(contact.data.counselor_id)).maybeSingle()
    : { data: null };
  const timezone = ((prof.data as Row | null)?.timezone as string | null) ?? null;
  const account = await readAccount(svc, invoice.contactId, todayIn(timezone));

  const { error } = await svc.from("pipeline_payments").insert(cardPaymentRow(a, invoice, account, { credits: true, timezone }));
  if (isDuplicate(error)) return "already recorded";
  if (error) dbFail("insert payment", error);
  return "recorded";
}

async function applyRefund(svc: SupabaseClient, chargeId: string, paymentIntentId: string | null, amountRefunded: number): Promise<"updated" | "missing"> {
  const q = svc.from("pipeline_payments").select("id, amount_cents, refunded_cents").eq("via_stripe", true);
  const found = paymentIntentId
    ? await q.eq("stripe_payment_intent_id", paymentIntentId).maybeSingle()
    : await q.eq("stripe_charge_id", chargeId).maybeSingle();
  if (found.error) dbFail("read payment", found.error);
  const row = found.data as Row | null;
  if (!row) return "missing";
  const refunded = refundedFor(Number(row.amount_cents), amountRefunded);
  const { error } = await svc
    .from("pipeline_payments")
    .update({ refunded_cents: refunded, stripe_charge_id: chargeId })
    .eq("id", String(row.id));
  if (error) dbFail("update refund", error);
  return "updated";
}

async function handle(svc: SupabaseClient, action: StripeAction): Promise<string> {
  switch (action.kind) {
    case "ignore":
      return action.reason;
    case "record-payment":
      return recordPayment(svc, action);
    case "refund": {
      const r = await applyRefund(svc, action.chargeId, action.paymentIntentId, action.refundedCents);
      if (r === "missing" && refundWithoutPayment(action) === "retry") throw retry("Payment not recorded yet");
      return r === "missing" ? "not a Meridies payment" : "refund recorded";
    }
    case "refund-recheck": {
      const stripe = stripeClient();
      if (!stripe) throw stripeUnavailable();
      const charge = await stripe.charges.retrieve(action.chargeId, {}, { stripeAccount: action.account });
      const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null);
      const r = await applyRefund(svc, charge.id, pi, charge.amount_refunded);
      return r === "missing" ? "not a Meridies payment" : "refund rechecked";
    }
    case "account": {
      const { error } = await svc
        .from("practice_stripe_accounts")
        .update({
          charges_enabled: action.chargesEnabled,
          payouts_enabled: action.payoutsEnabled,
          details_submitted: action.detailsSubmitted,
        })
        .eq("stripe_account_id", action.account);
      if (error) dbFail("update account", error);
      return "account updated";
    }
  }
}

export default async function stripeWebhookRoutes(app: FastifyInstance) {
  // The signature is over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post("/stripe", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply: FastifyReply) => {
    const stripe = stripeClient();
    const svc = serviceClient();
    if (!hasStripe || !stripe || !svc || !env.STRIPE_WEBHOOK_SECRET) throw stripeUnavailable();

    const raw = typeof request.body === "string" ? request.body : "";
    const signature = request.headers["stripe-signature"];
    let event: StripeEventLike;
    try {
      event = stripe.webhooks.constructEvent(raw, typeof signature === "string" ? signature : "", env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return reply.code(400).send({ error: "Invalid signature" });
    }

    // Before the migration: Stripe keeps the event and retries.
    if (!(await stripeReady(svc))) throw stripeUnavailable();

    const done = await svc.from("stripe_webhook_events").select("id").eq("id", event.id).maybeSingle();
    if (done.error) {
      request.log.error({ err: serializeErr(done.error) }, "stripe webhook: could not read handled events");
      throw retry("Try again");
    }
    if (done.data) return { received: true, duplicate: true };

    let outcome: string;
    try {
      outcome = await handle(svc, planStripeEvent(event));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      request.log.error({ err: serializeErr(err), type: event.type }, "stripe webhook: could not handle the event");
      throw retry("Try again");
    }

    const { error } = await svc
      .from("stripe_webhook_events")
      .insert({ id: event.id, type: event.type.slice(0, 120), account: event.account ?? null });
    if (error && !isDuplicate(error)) request.log.warn({ err: serializeErr(error) }, "stripe webhook: could not note the event");
    request.log.info({ type: event.type, outcome }, "stripe webhook");
    return { received: true };
  });
}
