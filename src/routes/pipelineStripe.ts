/**
 * Payment Tracker card payments: connecting the practice's Stripe account.
 *
 *   GET  /pipeline/stripe           { configured, connected, chargesEnabled, payoutsEnabled, canManage }
 *   POST /pipeline/stripe/connect   { url }: Stripe's onboarding page for the practice's account
 *
 * One Standard account per practice (the firm, or a solo counselor), created
 * on the first Connect. Only a firm owner/admin or a solo counselor connects
 * (`canManage`, the workspace's `isAdmin`); everyone in the practice sees the
 * status. Stripe returns the window to the app's Contact Pipeline with
 * `?stripe=return`, where the Payment Tracker opens itself.
 *
 * Not switched on is calm: without the Stripe keys, the service role, a
 * PUBLIC_API_URL or the migration (20261030000001), GET answers
 * `configured: false` and Connect 503 `stripe_unavailable`.
 *
 * The account row is written with the service role (clients have no write
 * grant on practice_stripe_accounts), and only after the caller's own client
 * showed they run the practice.
 */

import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { crmError, loadWorkspace } from "../lib/crm.js";
import { forbidden, HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { serializeErr } from "../lib/requestLog.js";
import { stripeStatus, stripeUnavailable } from "../lib/stripeConnect.js";
import { accountFlags, practiceAccount, stripeClient, stripeConfigured, STRIPE_ACCOUNT_COLUMNS } from "../lib/stripePractice.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

/** Where Stripe sends the window back to (and where an expired onboarding link starts again). */
export function stripeReturnUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/dashboard/counselor/contact-pipeline?stripe=return`;
}

const stripeFailed = () => new HttpError(502, "Stripe didn't answer. Try again in a minute.", "stripe_error");

export default async function pipelineStripeRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/stripe", { preHandler: [...counselor, limit("pipeline:stripe", 60, 60)] }, async (request) => {
    const ws = await loadWorkspace(request);
    const configured = await stripeConfigured(request.db);
    if (!configured) return stripeStatus(false, ws.isAdmin, null);

    const practiceId = ws.firmId ?? request.auth.userId;
    let row: Row | null;
    try {
      row = await practiceAccount(request.db, practiceId);
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "stripe: could not read the practice's account");
      throw crmError(null);
    }

    // Back from onboarding before Stripe's account.updated webhook arrived: ask Stripe.
    if (row && row.charges_enabled !== true) {
      const stripe = stripeClient();
      const svc = serviceClient();
      if (stripe && svc) {
        try {
          const acct = await stripe.accounts.retrieve(String(row.stripe_account_id));
          const flags = accountFlags(acct);
          if (flags.charges_enabled || flags.payouts_enabled || flags.details_submitted) {
            const { data } = await svc
              .from("practice_stripe_accounts")
              .update(flags)
              .eq("practice_id", practiceId)
              .select(STRIPE_ACCOUNT_COLUMNS)
              .maybeSingle();
            if (data) row = data as Row;
          }
        } catch (err) {
          // The stored flags stand; the webhook will catch up.
          request.log.warn({ err: serializeErr(err) }, "stripe: could not refresh the practice's account");
        }
      }
    }
    return stripeStatus(true, ws.isAdmin, row);
  });

  app.post("/stripe/connect", { preHandler: [...counselor, limit("pipeline:stripe-connect", 10, 60)] }, async (request) => {
    const ws = await loadWorkspace(request);
    if (!(await stripeConfigured(request.db))) throw stripeUnavailable();
    if (!ws.isAdmin) throw forbidden("A firm owner or admin connects the firm's Stripe account");
    const stripe = stripeClient();
    const svc = serviceClient();
    if (!stripe || !svc) throw stripeUnavailable();

    const practiceId = ws.firmId ?? request.auth.userId;
    let row = await practiceAccount(svc, practiceId);
    if (!row) {
      let accountId: string;
      try {
        // The idempotency key stops a double click (or two admins at once) making two accounts.
        const acct = await stripe.accounts.create(
          {
            type: "standard",
            country: "US",
            email: request.profile.email ?? undefined,
            metadata: { meridies_practice_id: practiceId, meridies_firm_id: ws.firmId ?? "" },
          },
          { idempotencyKey: `meridies-connect-${practiceId}` }
        );
        accountId = acct.id;
      } catch (err) {
        request.log.error({ err: serializeErr(err) }, "stripe: could not create the connected account");
        throw stripeFailed();
      }
      const { error } = await svc.from("practice_stripe_accounts").insert({
        practice_id: practiceId,
        firm_id: ws.firmId,
        counselor_id: ws.firmId ? null : request.auth.userId,
        stripe_account_id: accountId,
        created_by: request.auth.userId,
      });
      // 23505: someone else's Connect stored it first; theirs is the account.
      if (error && error.code !== "23505") {
        request.log.error({ err: serializeErr(error) }, "stripe: could not store the connected account");
        throw crmError(null);
      }
      row = await practiceAccount(svc, practiceId);
      if (!row) throw crmError(null);
    }

    try {
      const back = stripeReturnUrl(env.APP_URL);
      const link = await stripe.accountLinks.create({
        account: String(row.stripe_account_id),
        type: "account_onboarding",
        refresh_url: back,
        return_url: back,
      });
      return { url: link.url };
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "stripe: could not create the onboarding link");
      throw stripeFailed();
    }
  });
}
