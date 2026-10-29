/**
 * Payment Tracker card payments (Stripe Connect): the pure rules.
 *
 * Each practice (a firm, or a solo counselor) connects its own Standard Stripe
 * account; a family pays an open invoice through a Checkout Session created on
 * that account (a direct charge: the practice is paid and pays Stripe's fee),
 * and Stripe's Connect webhook tells us. Nothing here talks to Stripe or the
 * database: `planStripeEvent` reads a verified event and says what to do,
 * `cardPaymentRow` turns that into the `pipeline_payments` row, and the routes
 * (routes/stripeWebhook.ts, routes/pay.ts, routes/pipelineStripe.ts) do it.
 *
 * Idempotency: a payment is keyed by its PaymentIntent (a unique index), so a
 * repeated or out-of-order `checkout.session.completed` records it once; a
 * refund writes Stripe's own running total (`charge.amount_refunded`), so a
 * repeated `charge.refunded` can't count it twice.
 */

import { HttpError } from "./errors.js";
import { planPayment, type AccountDTO, type InvoiceState } from "./payments.js";

type Row = Record<string, unknown>;

/** Metadata keys a Meridies Checkout Session (and its PaymentIntent) carries. */
export const META_INVOICE = "meridies_invoice_id";
export const META_CONTACT = "meridies_contact_id";
export const META_PRACTICE = "meridies_practice_id";

export const STRIPE_UNAVAILABLE_MESSAGE = "Card payments aren't switched on yet";
export const stripeUnavailable = () => new HttpError(503, STRIPE_UNAVAILABLE_MESSAGE, "stripe_unavailable");

/** The pay link's capability: 32 random bytes, base64url. */
export const PAY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/;

// ---- What GET /pipeline/stripe answers ---------------------------------------

export type StripeStatusDTO = {
  configured: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  canManage: boolean;
};

/** Configured means keys, service role, a public origin and the migration; then the practice's row decides. */
export function stripeStatus(configured: boolean, canManage: boolean, row: Row | null): StripeStatusDTO {
  if (!configured) return { configured: false, connected: false, chargesEnabled: false, payoutsEnabled: false, canManage };
  return {
    configured: true,
    connected: Boolean(row),
    chargesEnabled: row?.charges_enabled === true,
    payoutsEnabled: row?.payouts_enabled === true,
    canManage,
  };
}

// ---- Pay links ----------------------------------------------------------------

export type PayLinkReason = "not-configured" | "not-connected" | "void" | "paid";

/** Why an invoice has no pay link, or null when it gets one. */
export function payLinkBlock(state: InvoiceState | null, owedCents: number, chargesEnabled: boolean): PayLinkReason | null {
  if (state === "void") return "void";
  if (state === "paid" || owedCents <= 0) return "paid";
  if (!chargesEnabled) return "not-connected";
  return null;
}

export function payUrl(publicApiUrl: string, token: string): string {
  return `${publicApiUrl.replace(/\/+$/, "")}/pay/${token}`;
}

/** What an invoice still asks the family for: its amount, less credit applied and what payments settled. */
export function invoiceOwed(a: AccountDTO, invoiceId: string): { state: InvoiceState | null; owedCents: number; invoice: AccountDTO["invoices"][number] | null } {
  const invoice = a.invoices.find((i) => i.id === invoiceId) ?? null;
  if (!invoice) return { state: null, owedCents: 0, invoice: null };
  const owedCents = invoice.state === "void" ? 0 : Math.max(0, invoice.amountCents - invoice.creditAppliedCents - invoice.paidCents);
  return { state: invoice.state, owedCents, invoice };
}

// ---- Webhook events -------------------------------------------------------------

/** The parts of a Stripe event this reads. Stripe's own types satisfy it. */
export type StripeEventLike = {
  id: string;
  type: string;
  account?: string | null;
  created: number;
  livemode?: boolean;
  data: { object: unknown };
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
/** A PaymentIntent or Charge reference: an id, or the expanded object. */
const ref = (v: unknown): string | null => str(v) ?? str(obj(v).id);

export type StripeAction =
  | {
      kind: "record-payment";
      eventId: string;
      account: string;
      invoiceId: string;
      contactId: string | null;
      practiceId: string | null;
      amountCents: number;
      paymentIntentId: string;
      sessionId: string;
      /** Seconds since the epoch, when Stripe made the event. */
      created: number;
    }
  | { kind: "refund"; eventId: string; account: string; chargeId: string; paymentIntentId: string | null; refundedCents: number; meridies: boolean }
  /** A Refund object changed (one failed or was cancelled): re-read its charge for the running total. */
  | { kind: "refund-recheck"; eventId: string; account: string; chargeId: string }
  | { kind: "account"; eventId: string; account: string; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }
  | { kind: "ignore"; eventId: string; reason: string };

/** Read a verified event. Anything that isn't a Meridies pay-link payment, refund or account change is ignored. */
export function planStripeEvent(event: StripeEventLike): StripeAction {
  const eventId = event.id;
  const o = obj(event.data?.object);
  const account = str(event.account);
  const ignore = (reason: string): StripeAction => ({ kind: "ignore", eventId, reason });

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (!account || !ACCOUNT_ID.test(account)) return ignore("not from a connected account");
      const meta = obj(o.metadata);
      const invoiceId = str(meta[META_INVOICE]);
      if (!invoiceId || !UUID.test(invoiceId)) return ignore("not a Meridies pay link");
      if (o.mode !== "payment") return ignore("not a one-time payment");
      // A card session completes paid; an async method completes unpaid and succeeds later.
      if (o.payment_status !== "paid") return ignore("not paid yet");
      if (String(o.currency ?? "").toLowerCase() !== "usd") return ignore("not in USD");
      const amountCents = Number(o.amount_total);
      if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 100_000_000) return ignore("amount out of range");
      const paymentIntentId = ref(o.payment_intent);
      const sessionId = str(o.id);
      if (!paymentIntentId || !sessionId) return ignore("no PaymentIntent");
      const contactId = str(meta[META_CONTACT]);
      const practiceId = str(meta[META_PRACTICE]);
      return {
        kind: "record-payment",
        eventId,
        account,
        invoiceId,
        contactId: contactId && UUID.test(contactId) ? contactId : null,
        practiceId: practiceId && UUID.test(practiceId) ? practiceId : null,
        amountCents,
        paymentIntentId,
        sessionId,
        created: Number(event.created) || Math.floor(Date.now() / 1000),
      };
    }
    case "charge.refunded": {
      if (!account) return ignore("not from a connected account");
      const chargeId = str(o.id);
      if (!chargeId) return ignore("no charge");
      const refundedCents = Math.max(0, Math.trunc(Number(o.amount_refunded) || 0));
      return {
        kind: "refund",
        eventId,
        account,
        chargeId,
        paymentIntentId: ref(o.payment_intent),
        refundedCents,
        meridies: Boolean(str(obj(o.metadata)[META_INVOICE])),
      };
    }
    case "charge.refund.updated":
    case "refund.updated":
    case "refund.failed": {
      if (!account) return ignore("not from a connected account");
      const chargeId = ref(o.charge);
      if (!chargeId) return ignore("no charge");
      return { kind: "refund-recheck", eventId, account, chargeId };
    }
    case "account.updated": {
      const id = str(o.id) ?? account;
      if (!id || !ACCOUNT_ID.test(id)) return ignore("no account");
      return {
        kind: "account",
        eventId,
        account: id,
        chargesEnabled: o.charges_enabled === true,
        payoutsEnabled: o.payouts_enabled === true,
        detailsSubmitted: o.details_submitted === true,
      };
    }
    case "account.application.deauthorized": {
      // The practice disconnected Meridies from its Stripe dashboard: no more pay links.
      if (!account || !ACCOUNT_ID.test(account)) return ignore("no account");
      return { kind: "account", eventId, account, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
    }
    default:
      return ignore(`unhandled ${event.type}`);
  }
}

/** A refund event for a charge whose payment isn't recorded yet: retry later if it was ours, else drop it. */
export function refundWithoutPayment(action: Extract<StripeAction, { kind: "refund" }>): "retry" | "ignore" {
  return action.meridies ? "retry" : "ignore";
}

// ---- Recording a card payment ----------------------------------------------------

export type InvoiceForPayment = {
  id: string;
  contactId: string;
  /** coalesce(firm_id, counselor_id): which practice billed it. */
  practiceId: string;
  number: string;
};

export type RecordCheck =
  | { ok: true }
  | { ok: false; reason: "account-mismatch" | "contact-mismatch" | "practice-mismatch" };

/**
 * The event is signed by Stripe, but any connected account's events reach the
 * endpoint: a payment counts only when it was taken on the account of the
 * practice that issued the invoice, and the metadata agrees with the invoice.
 */
export function checkPaymentTarget(
  action: Extract<StripeAction, { kind: "record-payment" }>,
  invoice: InvoiceForPayment,
  practiceAccountId: string | null
): RecordCheck {
  if (!practiceAccountId || practiceAccountId !== action.account) return { ok: false, reason: "account-mismatch" };
  if (action.contactId && action.contactId !== invoice.contactId) return { ok: false, reason: "contact-mismatch" };
  if (action.practiceId && action.practiceId !== invoice.practiceId) return { ok: false, reason: "practice-mismatch" };
  return { ok: true };
}

/** A date (YYYY-MM-DD) for a moment, where the practice is. */
export function dateIn(epochSeconds: number, timezone: string | null | undefined): string {
  const d = new Date(epochSeconds * 1000);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone?.trim() || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * The `pipeline_payments` row for a card payment. Money above what the package
 * has left (a family that paid twice, or paid after a cheque was recorded) is
 * held as credit when credits exist, the counselor's "record the extra as
 * credit" answer made for them, since the money has already moved.
 */
export function cardPaymentRow(
  action: Extract<StripeAction, { kind: "record-payment" }>,
  invoice: InvoiceForPayment,
  account: AccountDTO | null,
  opts: { credits: boolean; timezone: string | null }
): Row {
  const overpaymentCents = account ? planPayment(account, action.amountCents).overpaymentCents : 0;
  return {
    contact_id: invoice.contactId,
    amount_cents: action.amountCents,
    ...(opts.credits && overpaymentCents > 0 ? { credit_cents: Math.min(overpaymentCents, action.amountCents) } : {}),
    received_on: dateIn(action.created, opts.timezone),
    method: "card",
    note: `Paid by card · ${invoice.number}`.slice(0, 300),
    via_stripe: true,
    stripe_payment_intent_id: action.paymentIntentId,
    stripe_checkout_session_id: action.sessionId,
    invoice_id: invoice.id,
    created_by: null,
  };
}

/** Postgres's unique violation: the PaymentIntent (or the event) is already recorded. */
export function isDuplicate(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

/** Stripe's running total for a charge, never above what the payment was. */
export function refundedFor(paymentAmountCents: number, chargeAmountRefunded: number): number {
  return Math.min(Math.max(0, Math.trunc(chargeAmountRefunded)), paymentAmountCents);
}

