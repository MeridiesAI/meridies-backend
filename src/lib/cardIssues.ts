/**
 * Payment Tracker card payments that went wrong: a failed card payment, and a
 * dispute a family opened with their bank.
 *
 * Neither is money received, so neither is a `pipeline_payments` row. The
 * webhook (routes/stripeWebhook.ts) keeps one `pipeline_card_issues` row per
 * Stripe event (the event id is unique), and what the tracker shows is
 * derived on every read, like the balances:
 *
 *   - an invoice shows its latest card failure (`cardFailure`, with Stripe's
 *     reason) while it is still owed and no card payment on it is newer;
 *   - a card payment shows its dispute (`dispute`, the latest status).
 *
 * Nothing here changes what counts as paid. A dispute is a flag: a lost
 * dispute is not taken off the payment (the counselor records what they decide).
 *
 * The table is a migration that may not be applied yet (`cardIssuesReady`):
 * until it is, the webhook notes the event in audit_log instead, and the
 * tracker shows no failure line (`cardFailure: null`, `dispute: null`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountDTO } from "./payments.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;

export const CARD_ISSUES_TABLE = "pipeline_card_issues";

export type CardFailureDTO = {
  /** Stripe's words, e.g. "Your card was declined." */
  reason: string;
  /** Stripe's code, e.g. "generic_decline", "insufficient_funds"; null when it gave none. */
  code: string | null;
  amountCents: number | null;
  failedAt: string;
};

export type CardDisputeDTO = {
  /** Stripe's dispute status: needs_response, under_review, won, lost, warning_needs_response, ... */
  status: string;
  /** Stripe's dispute reason: fraudulent, duplicate, product_not_received, ... */
  reason: string | null;
  amountCents: number | null;
  openedAt: string;
  updatedAt: string;
};

// ---- Is the migration in? -----------------------------------------------------
// A zero-row probe like stripeReady: present is kept for the process, missing
// is re-asked after 30 s.

const RECHECK_MS = 30_000;
let ready = false;
let missingAt = 0;

export async function cardIssuesReady(db: SupabaseClient): Promise<boolean> {
  if (ready) return true;
  if (Date.now() - missingAt < RECHECK_MS) return false;
  const { error } = await db.from(CARD_ISSUES_TABLE).select("id").limit(0);
  if (!error) {
    ready = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    missingAt = Date.now();
    return false;
  }
  throw new Error(`card issues readiness probe: ${error.code ?? "unknown"}`);
}

/** For tests: forget what the probe learned. */
export function resetCardIssuesReadyForTests() {
  ready = false;
  missingAt = 0;
}

/** The family's issue rows, or none before the migration. Throws on a real database error. */
export async function readCardIssues(db: SupabaseClient, contactIds: string[]): Promise<Row[]> {
  if (contactIds.length === 0 || !(await cardIssuesReady(db))) return [];
  const q = db.from(CARD_ISSUES_TABLE).select("*");
  const { data, error } = await (contactIds.length === 1 ? q.eq("contact_id", contactIds[0]) : q.in("contact_id", contactIds)).limit(10000);
  if (error) throw new Error(`read card issues: ${error.code ?? "unknown"}`);
  return (data ?? []) as Row[];
}

// ---- Deriving what to show ------------------------------------------------------

const TERMINAL = new Set(["won", "lost", "warning_closed"]);
const time = (v: unknown) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : 0;
};
const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));

/**
 * Add `cardFailure` to every invoice and `dispute` to every payment.
 * `paymentRows` are the raw `pipeline_payments` rows (for `invoice_id` and
 * `created_at`, which the payment DTO doesn't carry).
 */
export function withCardIssues(account: AccountDTO, issueRows: Row[], paymentRows: Row[]): AccountDTO {
  const mine = issueRows.filter((r) => String(r.contact_id) === account.contactId);
  const failures = mine.filter((r) => r.kind === "payment_failed");
  const disputes = mine.filter((r) => r.kind === "dispute");
  const rawPayments = paymentRows.filter((r) => String(r.contact_id) === account.contactId);

  const invoices = account.invoices.map((inv) => {
    if (inv.state === "paid" || inv.state === "void") return { ...inv, cardFailure: null };
    const latest = failures
      .filter((f) => String(f.invoice_id) === inv.id)
      .sort((a, b) => time(b.occurred_at) - time(a.occurred_at))[0];
    if (!latest) return { ...inv, cardFailure: null };
    // A card payment on this invoice recorded after the failure: the family tried again and it went through.
    const paidSince = rawPayments.some(
      (p) => p.via_stripe === true && String(p.invoice_id) === inv.id && time(p.created_at) >= time(latest.occurred_at)
    );
    if (paidSince) return { ...inv, cardFailure: null };
    const failure: CardFailureDTO = {
      reason: String(latest.reason ?? "") || "The card payment didn't go through.",
      code: (latest.reason_code as string | null) ?? null,
      amountCents: numOrNull(latest.amount_cents),
      failedAt: String(latest.occurred_at),
    };
    return { ...inv, cardFailure: failure };
  });

  const payments = account.payments.map((p) => {
    const rows = disputes.filter((d) => String(d.payment_id) === p.id);
    if (rows.length === 0) return { ...p, dispute: null };
    // Stripe doesn't promise order, and created is in seconds: the latest event
    // wins, and on a tie a closed status beats an open one.
    const sorted = [...rows].sort(
      (a, b) =>
        time(b.occurred_at) - time(a.occurred_at) ||
        Number(TERMINAL.has(String(b.dispute_status))) - Number(TERMINAL.has(String(a.dispute_status)))
    );
    const latest = sorted[0];
    const opened = sorted[sorted.length - 1];
    const dispute: CardDisputeDTO = {
      status: String(latest.dispute_status ?? "needs_response"),
      reason: (latest.reason_code as string | null) ?? null,
      amountCents: numOrNull(latest.amount_cents),
      openedAt: String(opened.occurred_at),
      updatedAt: String(latest.occurred_at),
    };
    return { ...p, dispute };
  });

  return { ...account, invoices, payments };
}

// ---- The row the webhook writes ----------------------------------------------------

const clip = (s: string | null, n: number) => (s ? s.slice(0, n) : null);

export function cardIssueRow(i: {
  eventId: string;
  kind: "payment_failed" | "dispute";
  contactId: string;
  invoiceId: string;
  paymentId: string | null;
  account: string;
  paymentIntentId: string | null;
  disputeId: string | null;
  amountCents: number | null;
  reasonCode: string | null;
  reason: string | null;
  disputeStatus: string | null;
  created: number;
}): Row {
  return {
    stripe_event_id: i.eventId,
    kind: i.kind,
    contact_id: i.contactId,
    invoice_id: i.invoiceId,
    payment_id: i.kind === "dispute" ? i.paymentId : null,
    stripe_account_id: i.account,
    stripe_payment_intent_id: clip(i.paymentIntentId, 255),
    stripe_dispute_id: i.kind === "dispute" ? clip(i.disputeId, 255) : null,
    amount_cents: i.amountCents,
    reason_code: clip(i.reasonCode, 80),
    reason: clip(i.reason, 300),
    dispute_status: i.kind === "dispute" ? clip(i.disputeStatus, 40) : null,
    occurred_at: new Date(i.created * 1000).toISOString(),
  };
}
