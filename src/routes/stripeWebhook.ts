/**
 * Stripe's Connect webhook: card payments, failed card payments, refunds and
 * disputes on the practices' connected accounts, and those accounts' status.
 *
 *   POST /webhooks/stripe
 *
 * The signature (Stripe-Signature, STRIPE_WEBHOOK_SECRET) is checked over the
 * raw body before anything is read, and an event of the other mode than the
 * platform key (a test payment reaching a live endpoint) is ignored.
 * `lib/stripeConnect.ts` decides what an event means; this file does it with
 * the service role (nobody is signed in):
 *
 *   checkout.session.completed / .async_payment_succeeded   record the payment
 *       against the invoice's family, once per PaymentIntent, and only when it
 *       was taken on the account of the practice that issued the invoice.
 *   payment_intent.payment_failed, checkout.session.async_payment_failed
 *       note the failure on the invoice (lib/cardIssues.ts), with Stripe's
 *       reason. Never a payment. Same account check.
 *   checkout.session.expired   nothing: an abandoned Checkout changes nothing.
 *   charge.refunded, charge.refund.updated, refund.updated / .failed
 *       set the payment's refunded_cents to the charge's running total, read
 *       from Stripe (events can arrive out of order, so never from the payload).
 *   charge.dispute.*   flag the card payment as disputed, with the status.
 *   account.updated, account.application.deauthorized
 *       the practice's charges / payouts flags (account.updated re-reads the
 *       account for the same reason).
 *
 * Handled event ids go in stripe_webhook_events, so a redelivery is answered
 * without work; everything it does is idempotent anyway (the PaymentIntent and
 * the issue's event id are unique, a refund is an absolute total). A 5xx makes
 * Stripe retry (for up to three days in live mode, a few hours in a sandbox):
 * used while card payments aren't switched on, on a database or Stripe error,
 * and for a refund of a Meridies payment that isn't recorded yet.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { env, hasStripe } from "../env.js";
import { cardIssueRow, cardIssuesReady, CARD_ISSUES_TABLE } from "../lib/cardIssues.js";
import { todayIn } from "../lib/crm.js";
import { HttpError } from "../lib/errors.js";
import { serializeErr } from "../lib/requestLog.js";
import {
  cardPaymentRow,
  checkPaymentTarget,
  isDuplicate,
  keyLivemode,
  planStripeEvent,
  feeOfCharge,
  refundedFor,
  refundWithoutPayment,
  stripeUnavailable,
  type InvoiceForPayment,
  type StripeAction,
  type StripeEventLike,
} from "../lib/stripeConnect.js";
import { accountFlags, practiceAccount, readAccount, stripeClient, stripeReady } from "../lib/stripePractice.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;
type Log = { warn: (o: object, msg: string) => void };

/** The parts of the Stripe client the webhook uses. Tests pass a fake. */
export type WebhookStripe = Pick<Stripe, "webhooks"> & {
  charges: Pick<Stripe["charges"], "retrieve">;
  accounts: Pick<Stripe["accounts"], "retrieve">;
};

export type WebhookDeps = {
  stripe: WebhookStripe | null;
  svc: SupabaseClient | null;
  webhookSecret: string | null;
  /** The platform key's mode; null accepts both (no key to tell). */
  livemode: boolean | null;
  /** Everything card payments need is configured (hasStripe). */
  enabled: boolean;
};

function envDeps(): WebhookDeps {
  return {
    stripe: stripeClient(),
    svc: serviceClient(),
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    livemode: keyLivemode(env.STRIPE_SECRET_KEY),
    enabled: hasStripe,
  };
}

/** Retry later: Stripe redelivers on anything but 2xx. */
const retry = (message: string) => new HttpError(503, message, "stripe_retry");

function dbFail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}: ${error?.code ?? "unknown"}`);
}

async function readInvoice(svc: SupabaseClient, invoiceId: string): Promise<InvoiceForPayment | null> {
  const inv = await svc.from("pipeline_invoices").select("id, contact_id, number, number_scope").eq("id", invoiceId).maybeSingle();
  if (inv.error) dbFail("read invoice", inv.error);
  if (!inv.data) return null;
  return {
    id: String(inv.data.id),
    contactId: String(inv.data.contact_id),
    practiceId: String(inv.data.number_scope),
    number: String(inv.data.number),
  };
}

async function recordPayment(svc: SupabaseClient, a: Extract<StripeAction, { kind: "record-payment" }>): Promise<string> {
  const invoice = await readInvoice(svc, a.invoiceId);
  if (!invoice) return "invoice not found";
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

/**
 * Keep a failure or dispute: a `pipeline_card_issues` row once that migration
 * is in, else an audit_log row (so nothing Stripe said is lost) and 200.
 */
async function keepIssue(svc: SupabaseClient, row: Row, log: Log): Promise<string> {
  if (await cardIssuesReady(svc)) {
    const { error } = await svc.from(CARD_ISSUES_TABLE).insert(row);
    if (isDuplicate(error)) return "already noted";
    if (error) dbFail("insert card issue", error);
    return "noted";
  }
  const action = row.kind === "dispute" ? "pipeline.card_dispute" : "pipeline.card_payment_failed";
  const { error } = await svc.from("audit_log").insert({
    actor_id: null,
    action,
    entity_type: "pipeline_invoice",
    entity_id: row.invoice_id,
    metadata: {
      stripe_event_id: row.stripe_event_id,
      stripe_account_id: row.stripe_account_id,
      stripe_payment_intent_id: row.stripe_payment_intent_id,
      stripe_dispute_id: row.stripe_dispute_id,
      payment_id: row.payment_id,
      contact_id: row.contact_id,
      amount_cents: row.amount_cents,
      reason_code: row.reason_code,
      reason: row.reason,
      dispute_status: row.dispute_status,
      occurred_at: row.occurred_at,
    },
  });
  if (error) dbFail("insert audit_log", error);
  log.warn({ action, invoiceId: row.invoice_id }, "stripe webhook: card issues table not applied; noted in audit_log");
  return "noted in audit_log";
}

async function noteFailure(svc: SupabaseClient, a: Extract<StripeAction, { kind: "card-failure" }>, log: Log): Promise<string> {
  const invoice = await readInvoice(svc, a.invoiceId);
  if (!invoice) return "invoice not found";
  const acct = await practiceAccount(svc, invoice.practiceId);
  const check = checkPaymentTarget(a, invoice, acct ? String(acct.stripe_account_id) : null);
  if (!check.ok) return check.reason;
  return keepIssue(
    svc,
    cardIssueRow({
      eventId: a.eventId,
      kind: "payment_failed",
      contactId: invoice.contactId,
      invoiceId: invoice.id,
      paymentId: null,
      account: a.account,
      paymentIntentId: a.paymentIntentId,
      disputeId: null,
      amountCents: a.amountCents,
      reasonCode: a.reasonCode,
      reason: a.reason,
      disputeStatus: null,
      created: a.created,
    }),
    log
  );
}

async function noteDispute(svc: SupabaseClient, a: Extract<StripeAction, { kind: "dispute" }>, log: Log): Promise<string> {
  const q = svc.from("pipeline_payments").select("id, contact_id, invoice_id").eq("via_stripe", true);
  const found = a.paymentIntentId
    ? await q.eq("stripe_payment_intent_id", a.paymentIntentId).maybeSingle()
    : await q.eq("stripe_charge_id", String(a.chargeId)).maybeSingle();
  if (found.error) dbFail("read payment", found.error);
  const payment = found.data as Row | null;
  if (!payment || !payment.invoice_id) return "not a Meridies payment";
  const invoice = await readInvoice(svc, String(payment.invoice_id));
  if (!invoice) return "invoice not found";
  const acct = await practiceAccount(svc, invoice.practiceId);
  const check = checkPaymentTarget({ account: a.account, contactId: String(payment.contact_id), practiceId: null }, invoice, acct ? String(acct.stripe_account_id) : null);
  if (!check.ok) return check.reason;
  return keepIssue(
    svc,
    cardIssueRow({
      eventId: a.eventId,
      kind: "dispute",
      contactId: invoice.contactId,
      invoiceId: invoice.id,
      paymentId: String(payment.id),
      account: a.account,
      paymentIntentId: a.paymentIntentId,
      disputeId: a.disputeId,
      amountCents: a.amountCents,
      reasonCode: a.reason,
      reason: null,
      disputeStatus: a.status,
      created: a.created,
    }),
    log
  );
}

async function applyRefund(svc: SupabaseClient, chargeId: string, paymentIntentId: string | null, amountRefunded: number, feeCents: number): Promise<"updated" | "missing"> {
  const q = svc.from("pipeline_payments").select("id, amount_cents, refunded_cents").eq("via_stripe", true);
  const found = paymentIntentId
    ? await q.eq("stripe_payment_intent_id", paymentIntentId).maybeSingle()
    : await q.eq("stripe_charge_id", chargeId).maybeSingle();
  if (found.error) dbFail("read payment", found.error);
  const row = found.data as Row | null;
  if (!row) return "missing";
  const refunded = refundedFor(Number(row.amount_cents), amountRefunded, feeCents);
  const { error } = await svc
    .from("pipeline_payments")
    .update({ refunded_cents: refunded, stripe_charge_id: chargeId })
    .eq("id", String(row.id));
  if (error) dbFail("update refund", error);
  return "updated";
}

/** The charge as Stripe has it now: its running refund total is the truth, whatever order events came in. */
async function liveCharge(stripe: WebhookStripe | null, chargeId: string, account: string) {
  if (!stripe) throw stripeUnavailable();
  const charge = await stripe.charges.retrieve(chargeId, {}, { stripeAccount: account });
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null);
  return { id: charge.id, paymentIntentId: pi, amountRefunded: charge.amount_refunded, feeCents: feeOfCharge((charge as { metadata?: unknown }).metadata) };
}

/** Stripe refuses to read an account that disconnected the platform. */
function isAccountGone(err: unknown): boolean {
  const e = err as { type?: string; code?: string; statusCode?: number } | null;
  return e?.type === "StripePermissionError" || e?.code === "account_invalid" || e?.statusCode === 403;
}

async function setAccountFlags(svc: SupabaseClient, account: string, flags: { charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean }) {
  const { error } = await svc.from("practice_stripe_accounts").update(flags).eq("stripe_account_id", account);
  if (error) dbFail("update account", error);
}

/** Do what an event means. Exported for tests. */
export async function handleStripeAction(deps: Pick<WebhookDeps, "stripe">, svc: SupabaseClient, action: StripeAction, log: Log): Promise<string> {
  switch (action.kind) {
    case "ignore":
      return action.reason;
    case "record-payment":
      return recordPayment(svc, action);
    case "card-failure":
      return noteFailure(svc, action, log);
    case "dispute":
      return noteDispute(svc, action, log);
    case "refund": {
      const live = await liveCharge(deps.stripe, action.chargeId, action.account);
      const r = await applyRefund(svc, live.id, live.paymentIntentId ?? action.paymentIntentId, live.amountRefunded, live.feeCents);
      if (r === "missing" && refundWithoutPayment(action) === "retry") throw retry("Payment not recorded yet");
      return r === "missing" ? "not a Meridies payment" : "refund recorded";
    }
    case "refund-recheck": {
      const live = await liveCharge(deps.stripe, action.chargeId, action.account);
      const r = await applyRefund(svc, live.id, live.paymentIntentId, live.amountRefunded, live.feeCents);
      return r === "missing" ? "not a Meridies payment" : "refund rechecked";
    }
    case "account": {
      // A deauthorization is final; account.updated re-reads the account (a stale event must not turn charges back on or off).
      if (action.source === "deauthorized") {
        await setAccountFlags(svc, action.account, { charges_enabled: false, payouts_enabled: false, details_submitted: false });
        return "account updated";
      }
      if (!deps.stripe) throw stripeUnavailable();
      let flags;
      try {
        flags = accountFlags(await deps.stripe.accounts.retrieve(action.account));
      } catch (err) {
        if (!isAccountGone(err)) throw err;
        flags = { charges_enabled: false, payouts_enabled: false, details_submitted: false };
      }
      await setAccountFlags(svc, action.account, flags);
      return "account updated";
    }
  }
}

export default async function stripeWebhookRoutes(app: FastifyInstance, opts: { deps?: () => WebhookDeps } = {}) {
  const depsOf = opts.deps ?? envDeps;
  // The signature is over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post("/stripe", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply: FastifyReply) => {
    const deps = depsOf();
    const { stripe, svc, webhookSecret } = deps;
    if (!deps.enabled || !stripe || !svc || !webhookSecret) throw stripeUnavailable();

    const raw = typeof request.body === "string" ? request.body : "";
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || !signature) return reply.code(400).send({ error: "Invalid signature" });
    let event: StripeEventLike;
    try {
      event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
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
      outcome = await handleStripeAction(deps, svc, planStripeEvent(event, { livemode: deps.livemode }), request.log);
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
    return { received: true, outcome };
  });
}
