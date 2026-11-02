/**
 * An invoice's pay link, opened by the family. Public: the token in the path
 * is the capability (stored hashed, minted by GET /pipeline/invoices/:id/pay-link
 * and put in the invoice email).
 *
 *   GET  /pay/:token   the invoice, what is still owed, and a "Pay by card" button.
 *                      Changes nothing, so a mail scanner that prefetches it starts
 *                      no Checkout. `?paid=1` is where Stripe returns after paying.
 *   POST /pay/:token   a fresh Stripe Checkout Session on the practice's connected
 *                      account for what is owed right now, and a redirect to it.
 *
 * A fresh session per click means a link never expires and never asks for
 * more than is owed. The payment is recorded by Stripe's webhook
 * (routes/stripeWebhook.ts), never by the return to `?paid=1`.
 *
 * Service role: nobody is signed in. It reads only the invoice the token names,
 * its family's billing rows and the practice's Stripe account, and writes
 * nothing. It refuses when the practice's counselor isn't approved.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { env, hasStripe } from "../env.js";
import { approvedCounselorIds } from "../lib/access.js";
import { todayIn } from "../lib/crm.js";
import { formatUsd } from "../lib/payments.js";
import { serializeErr } from "../lib/requestLog.js";
import { invoiceOwed, META_CONTACT, META_INVOICE, META_PRACTICE, PAY_TOKEN, payUrl } from "../lib/stripeConnect.js";
import { invoiceForToken, practiceAccount, readAccount, stripeClient, stripeReady } from "../lib/stripePractice.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

// Chrome applies form-action to the redirect after a form post, so Stripe's Checkout origin is allowed.
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function page(reply: FastifyReply, status: number, body: string) {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Robots-Tag", "noindex")
    .header("Content-Security-Policy", CSP)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pay an invoice</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1f2937">${body}</body></html>`);
}

const INVALID = "<h1>This link isn't valid</h1><p>Use the pay link in the invoice email you received.</p>";
const UNAVAILABLE = "<h1>Card payments aren't available right now</h1><p>Try again later, or reply to the invoice email to pay another way.</p>";

type Ready =
  | { ok: false; status: number; body: string }
  | { ok: true; invoice: Row; contact: Row; owedCents: number; number: string; label: string; dueOn: string; accountId: string };

export default async function payRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_r, _b, done) => done(null, {}));
  const config = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  /** Everything both routes check, in order: the link, the switch, the invoice, the practice. */
  async function prepare(token: string): Promise<Ready> {
    const svc = serviceClient();
    if (!hasStripe || !svc) return { ok: false, status: 503, body: UNAVAILABLE };
    if (!PAY_TOKEN.test(token)) return { ok: false, status: 404, body: INVALID };
    if (!(await stripeReady(svc))) return { ok: false, status: 503, body: UNAVAILABLE };
    const invoice = await invoiceForToken(svc, token);
    if (!invoice) return { ok: false, status: 404, body: INVALID };

    const contactRes = await svc
      .from("pipeline_contacts")
      .select("id, firm_id, counselor_id, student_name, parent_email, student_email")
      .eq("id", String(invoice.contact_id))
      .maybeSingle();
    if (contactRes.error) throw new Error(`read contact: ${contactRes.error.code ?? "unknown"}`);
    const contact = contactRes.data as Row | null;
    if (!contact) return { ok: false, status: 404, body: INVALID };
    const approved = await approvedCounselorIds(svc, [String(contact.counselor_id)]);
    if (!approved.has(String(contact.counselor_id))) return { ok: false, status: 503, body: UNAVAILABLE };

    const tz = await svc.from("profiles").select("timezone").eq("id", String(contact.counselor_id)).maybeSingle();
    const account = await readAccount(svc, String(invoice.contact_id), todayIn((tz.data as Row | null)?.timezone as string | null));
    if (!account) return { ok: false, status: 404, body: INVALID };
    const { state, owedCents, invoice: dto } = invoiceOwed(account, String(invoice.id));
    if (!dto) return { ok: false, status: 404, body: INVALID };
    const heading = `<h1>Invoice ${esc(dto.number)}</h1>`;
    if (state === "void") return { ok: false, status: 410, body: `${heading}<p>This invoice was cancelled. There's nothing to pay.</p>` };
    if (state === "paid" || owedCents <= 0) return { ok: false, status: 200, body: `${heading}<p>This invoice is paid. Thank you.</p>` };

    const acct = await practiceAccount(svc, String(invoice.number_scope));
    if (acct?.charges_enabled !== true) return { ok: false, status: 503, body: UNAVAILABLE };
    return {
      ok: true,
      invoice,
      contact,
      owedCents,
      number: dto.number,
      label: dto.label,
      dueOn: dto.dueOn,
      accountId: String(acct.stripe_account_id),
    };
  }

  app.get("/pay/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { paid } = (request.query ?? {}) as { paid?: string };
    if (paid === "1" && PAY_TOKEN.test(token)) {
      return page(reply, 200, "<h1>Thank you</h1><p>Your payment went through. It can take a minute to show on the invoice, and Stripe emails your receipt.</p>");
    }
    let r: Ready;
    try {
      r = await prepare(token);
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "pay: could not load the invoice");
      return page(reply, 503, UNAVAILABLE);
    }
    if (!r.ok) return page(reply, r.status, r.body);
    const name = String(r.contact.student_name ?? "").trim();
    return page(
      reply,
      200,
      `<h1>Invoice ${esc(r.number)}</h1>
<p>${esc(r.label)}${name ? ` for ${esc(name)}` : ""}</p>
<p style="font-size:22px;font-weight:bold">${esc(formatUsd(r.owedCents))} due ${esc(r.dueOn)}</p>
<form method="post"><button type="submit" style="padding:12px 18px;font-size:16px">Pay ${esc(formatUsd(r.owedCents))} by card</button></form>
<p style="color:#6b7280;font-size:13px">You'll pay on Stripe's secure page. The payment goes straight to the practice.</p>`
    );
  });

  app.post("/pay/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    let r: Ready;
    try {
      r = await prepare(token);
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "pay: could not load the invoice");
      return page(reply, 503, UNAVAILABLE);
    }
    if (!r.ok) return page(reply, r.status, r.body);
    const stripe = stripeClient();
    if (!stripe || !env.PUBLIC_API_URL) return page(reply, 503, UNAVAILABLE);

    const here = payUrl(env.PUBLIC_API_URL, token);
    const name = String(r.contact.student_name ?? "").trim();
    const practiceId = String(r.invoice.number_scope);
    const metadata = { [META_INVOICE]: String(r.invoice.id), [META_CONTACT]: String(r.contact.id), [META_PRACTICE]: practiceId };
    const email = String(r.contact.parent_email || r.contact.student_email || "");
    try {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          // Cards (and wallets that pay by card): paid the moment Checkout completes.
          allowed_payment_method_types: ["card", "link"],
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: r.owedCents,
                product_data: { name: `Invoice ${r.number}: ${r.label}${name ? ` for ${name}` : ""}`.slice(0, 250) },
              },
            },
          ],
          ...(email ? { customer_email: email } : {}),
          metadata,
          // Copied onto the PaymentIntent (and its charge), so a refund event can be told apart.
          payment_intent_data: { metadata, description: `Invoice ${r.number}` },
          success_url: `${here}?paid=1`,
          cancel_url: here,
        },
        { stripeAccount: r.accountId }
      );
      if (!session.url) throw new Error("Checkout Session without a url");
      return reply.header("Cache-Control", "no-store").redirect(session.url, 303);
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "pay: could not start Stripe Checkout");
      return page(reply, 503, UNAVAILABLE);
    }
  });
}
