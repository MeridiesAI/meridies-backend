/**
 * Payment Tracker card payments: the Stripe client, whether the migration is
 * in, the practice's connected account, and pay link tokens.
 *
 * Every function takes the Supabase client to use. Routes pass the caller's
 * own client (RLS decides) wherever a counselor is asking, and the service
 * client only on the public pay page and the webhook, where nobody is signed
 * in (routes/pay.ts, routes/stripeWebhook.ts, routes/pipelineStripe.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { env, hasStripe } from "../env.js";
import { deriveAccount, type AccountDTO } from "./payments.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import { payUrl } from "./stripeConnect.js";

type Row = Record<string, unknown>;

/** Pay link tokens are stored as their sha256, like the unsubscribe tokens. */
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

let cachedStripe: Stripe | null = null;

/** Null without STRIPE_SECRET_KEY. */
export function stripeClient(): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!cachedStripe) {
    cachedStripe = new Stripe(env.STRIPE_SECRET_KEY, {
      maxNetworkRetries: 2,
      timeout: 15_000,
      appInfo: { name: "Meridies", url: "https://meridiesai.com" },
    });
  }
  return cachedStripe;
}

// ---- Is the migration in? (20261030000001) -----------------------------------
// A zero-row probe, like paymentCreditsReady: ready is kept for the process,
// missing is re-asked after 30 s. It also needs the credits migration, which
// card payments build on (credit_cents).

const RECHECK_MS = 30_000;
let ready = false;
let missingAt = 0;

export async function stripeReady(db: SupabaseClient): Promise<boolean> {
  if (ready) return true;
  if (Date.now() - missingAt < RECHECK_MS) return false;
  const [acct, pay, tok] = await Promise.all([
    db.from("practice_stripe_accounts").select("practice_id").limit(0),
    db.from("pipeline_payments").select("via_stripe, refunded_cents, stripe_payment_intent_id, credit_cents").limit(0),
    db.from("pipeline_pay_tokens").select("token_hash").limit(0),
  ]);
  const error = acct.error ?? pay.error ?? tok.error;
  if (!error) {
    ready = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    missingAt = Date.now();
    return false;
  }
  throw new Error(`stripe readiness probe: ${error.code ?? "unknown"}`);
}

/** Keys, service role, public origin and migration: everything card payments need. */
export async function stripeConfigured(db: SupabaseClient): Promise<boolean> {
  return hasStripe && (await stripeReady(db));
}

/** For tests: forget what the probe learned. */
export function resetStripeReadyForTests() {
  ready = false;
  missingAt = 0;
}

// ---- The practice's account ------------------------------------------------------

export const STRIPE_ACCOUNT_COLUMNS = "practice_id, firm_id, counselor_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted";

export async function practiceAccount(db: SupabaseClient, practiceId: string): Promise<Row | null> {
  const { data, error } = await db
    .from("practice_stripe_accounts")
    .select(STRIPE_ACCOUNT_COLUMNS)
    .eq("practice_id", practiceId)
    .maybeSingle();
  if (error) throw new Error(`read practice stripe account: ${error.code ?? "unknown"}`);
  return (data as Row | null) ?? null;
}

/** The capability flags off a Stripe Account object. */
export function accountFlags(a: { charges_enabled?: boolean | null; payouts_enabled?: boolean | null; details_submitted?: boolean | null }) {
  return {
    charges_enabled: a.charges_enabled === true,
    payouts_enabled: a.payouts_enabled === true,
    details_submitted: a.details_submitted === true,
  };
}

// ---- Pay link tokens ---------------------------------------------------------------

/**
 * Mint a pay link for an invoice. The caller's own client inserts the hash, so
 * RLS checks they may bill the family; the plaintext exists only in the link.
 */
export async function mintPayLink(db: SupabaseClient, invoiceId: string, userId: string): Promise<string> {
  if (!env.PUBLIC_API_URL) throw new Error("PUBLIC_API_URL is unset");
  const token = randomBytes(32).toString("base64url");
  const { error } = await db.from("pipeline_pay_tokens").insert({ token_hash: hashToken(token), invoice_id: invoiceId, created_by: userId });
  if (error) throw new Error(`mint pay link: ${error.code ?? "unknown"}`);
  return payUrl(env.PUBLIC_API_URL, token);
}

export async function invoiceForToken(svc: SupabaseClient, token: string): Promise<Row | null> {
  const { data, error } = await svc.from("pipeline_pay_tokens").select("invoice_id").eq("token_hash", hashToken(token)).maybeSingle();
  if (error) throw new Error(`read pay token: ${error.code ?? "unknown"}`);
  if (!data) return null;
  const inv = await svc.from("pipeline_invoices").select("*").eq("id", String((data as Row).invoice_id)).maybeSingle();
  if (inv.error) throw new Error(`read invoice: ${inv.error.code ?? "unknown"}`);
  return (inv.data as Row | null) ?? null;
}

// ---- A family's account, read with a given client ------------------------------------

/** The same read as routes/pipeline.ts loadAccount, for the pay page and the webhook (no signed-in user). */
export async function readAccount(db: SupabaseClient, contactId: string, today: string): Promise<AccountDTO | null> {
  const [pkg, invoices, payments, refunds] = await Promise.all([
    db.from("pipeline_packages").select("*").eq("contact_id", contactId).maybeSingle(),
    db.from("pipeline_invoices").select("*").eq("contact_id", contactId).limit(500),
    db.from("pipeline_payments").select("*").eq("contact_id", contactId).limit(500),
    db.from("pipeline_credit_refunds").select("*").eq("contact_id", contactId).limit(500),
  ]);
  const error = pkg.error ?? invoices.error ?? payments.error ?? refunds.error;
  if (error) throw new Error(`read account: ${error.code ?? "unknown"}`);
  if (!pkg.data) return null;
  return deriveAccount(pkg.data as Row, (invoices.data ?? []) as Row[], (payments.data ?? []) as Row[], today, (refunds.data ?? []) as Row[]);
}
