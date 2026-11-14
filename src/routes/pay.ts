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
import {
  billToOf,
  invoiceStatus,
  logoOrigin,
  readPractice,
  renderInvoicePageBody,
  renderPageMessage,
  renderPayPage,
  type InvoiceDocument,
} from "../lib/invoiceDocument.js";
import { agreementsEnabled, mintAgreementLinkAsService } from "../lib/agreements.js";
import { feeFor, buildExtras, sourceFromInvoiceRow } from "../lib/invoiceSettings.js";
import { takesCardMethod } from "../lib/paymentMethods.js";
import { planLine } from "../lib/payments.js";
import { serializeErr } from "../lib/requestLog.js";
import { invoiceOwed, META_CONTACT, META_FEE, META_INVOICE, META_PRACTICE, PAY_TOKEN, payUrl } from "../lib/stripeConnect.js";
import { invoiceForToken, practiceAccount, readAccount, stripeClient, stripeReady } from "../lib/stripePractice.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

// Chrome applies form-action to the redirect after a form post, so Stripe's Checkout origin is allowed.
// The practice's logo is the only image, from its own origin.
export function payCsp(imgOrigin: string | null): string {
  return (
    "default-src 'none'; style-src 'unsafe-inline'; " +
    (imgOrigin ? `img-src ${imgOrigin}; ` : "") +
    "form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'"
  );
}

function page(reply: FastifyReply, status: number, body: string, doc: InvoiceDocument | null = null) {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Robots-Tag", "noindex")
    .header("Content-Security-Policy", payCsp(logoOrigin(doc)))
    .type("text/html; charset=utf-8")
    .send(renderPayPage(doc?.number ? `Invoice ${doc.number}` : "Pay an invoice", body));
}

/** What the family reads after a card payment on this invoice failed (lib/cardIssues.ts). Nothing was charged. */
export function failureNote(f: { reason: string } | null): string | null {
  if (!f) return null;
  const reason = f.reason.trim().replace(/\.$/, "");
  return `Your last card payment didn't go through${reason ? ` (${reason})` : ""}, and nothing was charged. You can try again, with another card if you need to.`;
}

const INVALID = renderPageMessage("This link isn't valid", "Use the pay link in the invoice email you received.");
const UNAVAILABLE = renderPageMessage(
  "Card payments aren't available right now",
  "Try again later, or reply to the invoice email to pay another way."
);

type Ready =
  | { ok: false; status: number; body: string; doc?: InvoiceDocument }
  | { ok: true; invoice: Row; contact: Row; owedCents: number; number: string; label: string; dueOn: string; accountId: string; doc: InvoiceDocument };

export default async function payRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_r, _b, done) => done(null, {}));
  const config = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  /** Everything both routes check, in order: the link, the switch, the invoice, the practice. */
  async function prepare(token: string): Promise<Ready> {
    const svc = serviceClient();
    if (!svc) return { ok: false, status: 503, body: UNAVAILABLE };
    // Without Stripe keys only a composer invoice (one that names its ways to pay) has a page: it shows them, no card button.
    if (!hasStripe && !PAY_TOKEN.test(token)) return { ok: false, status: 503, body: UNAVAILABLE };
    if (!PAY_TOKEN.test(token)) return { ok: false, status: 404, body: INVALID };
    if (!(await stripeReady(svc))) return { ok: false, status: 503, body: UNAVAILABLE };
    const invoice = await invoiceForToken(svc, token);
    if (!invoice) return { ok: false, status: 404, body: INVALID };
    // An invoice from before the composer is a card invoice: with Stripe off it is unavailable, as it always was.
    const composerInvoice = Array.isArray(invoice.accepted_methods);
    if (!hasStripe && !composerInvoice) return { ok: false, status: 503, body: UNAVAILABLE };

    const contactRes = await svc
      .from("pipeline_contacts")
      .select("id, firm_id, counselor_id, student_name, parent_name, parent_email, student_email")
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
    // The invoice as the email showed it, with what it owes now (invoiceOwed: nothing computed here).
    const live = account.invoices
      .filter((i) => i.state !== "void")
      .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.number.localeCompare(b.number, undefined, { numeric: true }));
    const nth = live.findIndex((i) => i.id === dto.id) + 1;
    const practice = await readPractice(svc, {
      firmId: (contact.firm_id as string | null) ?? null,
      counselorId: String(contact.counselor_id),
    });
    const status = owedCents <= 0 && state !== "void" ? "paid" : invoiceStatus(state ?? dto.state);
    // The composer's additions, as the invoice went out: its look, ways to pay, lines, note, card fee, contract.
    const practiceId = String(contact.firm_id ?? contact.counselor_id);
    const extras = await buildExtras(svc, practiceId, sourceFromInvoiceRow(invoice));
    let contract: InvoiceDocument["contract"] = null;
    if (agreementsEnabled() && typeof invoice.agreement_id === "string") {
      const ag = await svc.from("agreements").select("title, status, contact_id").eq("id", invoice.agreement_id).maybeSingle();
      const a = ag.data as Row | null;
      // Only an open agreement of THIS family (a forged pointer to someone else's never gets a link).
      if (a && String(a.contact_id) === String(invoice.contact_id) && (a.status === "draft" || a.status === "sent")) {
        contract = { title: String(a.title), action: `/pay/${token}/contract` };
      }
    }
    const base: InvoiceDocument = {
      practice,
      number: dto.number,
      issuedOn: dto.issuedOn,
      dueOn: dto.dueOn,
      billTo: { ...billToOf(contact), email: null },
      lines: extras?.lines ?? [{ description: account.packageName, detail: dto.label, amountCents: dto.amountCents }],
      subtotalCents: dto.amountCents,
      creditAppliedCents: dto.creditAppliedCents,
      alreadyPaidCents: dto.paidCents,
      amountDueCents: owedCents,
      status,
      payUrl: null,
      plan: nth > 0 ? planLine(account, nth) : null,
      footnote: failureNote(dto.cardFailure ?? null),
      ...(extras ? { style: extras.style, methods: extras.methods, note: extras.note, feeCents: feeFor(extras, owedCents) } : {}),
      contract,
    };
    if (status === "void") return { ok: false, status: 410, body: renderInvoicePageBody(base), doc: base };
    if (status === "paid") return { ok: false, status: 200, body: renderInvoicePageBody(base), doc: base };

    // A composer invoice with no card on it (or no card account yet) is a page of ways to pay, with no button.
    const cardsAccepted = takesCardMethod(extras?.acceptedKeys);
    const acct = hasStripe && cardsAccepted ? await practiceAccount(svc, String(invoice.number_scope)) : null;
    if (acct?.charges_enabled !== true) {
      return composerInvoice ? { ok: false, status: 200, body: renderInvoicePageBody(base), doc: base } : { ok: false, status: 503, body: UNAVAILABLE };
    }
    // The button posts back to this same address.
    const doc: InvoiceDocument = { ...base, payUrl: "" };
    return {
      ok: true,
      invoice,
      contact,
      owedCents,
      number: dto.number,
      label: dto.label,
      dueOn: dto.dueOn,
      accountId: String(acct.stripe_account_id),
      doc,
    };
  }

  app.get("/pay/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { paid } = (request.query ?? {}) as { paid?: string };
    if (paid === "1" && PAY_TOKEN.test(token)) {
      // Only a link that exists gets the thank-you page: a made-up token
      // otherwise gives anyone a Meridies-hosted "your payment went through".
      const svc = serviceClient();
      let known = false;
      try {
        known = Boolean(svc && (await stripeReady(svc)) && (await invoiceForToken(svc, token)));
      } catch (err) {
        request.log.error({ err: serializeErr(err) }, "pay: could not load the invoice");
        return page(reply, 503, UNAVAILABLE);
      }
      if (!known) return page(reply, 404, INVALID);
      return page(
        reply,
        200,
        renderPageMessage("Thank you", "Your payment went through. It can take a minute to show on the invoice, and Stripe emails your receipt.")
      );
    }
    let r: Ready;
    try {
      r = await prepare(token);
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "pay: could not load the invoice");
      return page(reply, 503, UNAVAILABLE);
    }
    if (!r.ok) return page(reply, r.status, r.body, r.doc ?? null);
    return page(reply, 200, renderInvoicePageBody(r.doc), r.doc);
  });

  /**
   * "Review and accept the agreement" on the pay page: the invoice's contract (or agreement), through a fresh
   * private /agree link minted for this click (the service role; the family's emailed link keeps working). Only the
   * agreement THIS invoice names, only while it is still open and belongs to the invoice's own family, and only
   * for an approved counselor's practice. A redirect to the usual agreement page, which does the accepting.
   */
  app.post("/pay/:token/contract", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const svc = serviceClient();
    if (!svc || !PAY_TOKEN.test(token) || !agreementsEnabled() || !env.PUBLIC_API_URL) return page(reply, 404, INVALID);
    try {
      if (!(await stripeReady(svc))) return page(reply, 503, UNAVAILABLE);
      const invoice = await invoiceForToken(svc, token);
      if (!invoice || typeof invoice.agreement_id !== "string") return page(reply, 404, INVALID);
      const [ag, contact] = await Promise.all([
        svc.from("agreements").select("id, status, contact_id, counselor_id").eq("id", invoice.agreement_id).maybeSingle(),
        svc.from("pipeline_contacts").select("counselor_id").eq("id", String(invoice.contact_id)).maybeSingle(),
      ]);
      const a = ag.data as Row | null;
      const c = contact.data as Row | null;
      if (ag.error || contact.error) throw new Error("read agreement for pay page");
      if (!a || !c || String(a.contact_id) !== String(invoice.contact_id) || (a.status !== "draft" && a.status !== "sent")) return page(reply, 404, INVALID);
      const counselorId = String(c.counselor_id);
      if (!(await approvedCounselorIds(svc, [counselorId])).has(counselorId)) return page(reply, 503, UNAVAILABLE);
      const { url } = await mintAgreementLinkAsService(svc, String(a.id), { publicApiUrl: env.PUBLIC_API_URL, supersede: false });
      return reply.header("Cache-Control", "no-store").redirect(url, 303);
    } catch (err) {
      request.log.error({ err: serializeErr(err) }, "pay: could not open the agreement");
      return page(reply, 503, UNAVAILABLE);
    }
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
    if (!r.ok) return page(reply, r.status, r.body, r.doc ?? null);
    const stripe = stripeClient();
    if (!stripe || !env.PUBLIC_API_URL) return page(reply, 503, UNAVAILABLE);

    const here = payUrl(env.PUBLIC_API_URL, token);
    const name = String(r.contact.student_name ?? "").trim();
    const practiceId = String(r.invoice.number_scope);
    // A passed-on card fee (lib/invoiceCardFee.ts) is charged on top and recorded in the metadata so the webhook counts only the invoice.
    const feeCents = r.doc.feeCents ?? 0;
    const metadata = {
      [META_INVOICE]: String(r.invoice.id),
      [META_CONTACT]: String(r.contact.id),
      [META_PRACTICE]: practiceId,
      ...(feeCents > 0 ? { [META_FEE]: String(feeCents) } : {}),
    };
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
                unit_amount: r.owedCents + feeCents,
                product_data: { name: `Invoice ${r.number}: ${r.label}${name ? ` for ${name}` : ""}${feeCents > 0 ? " (includes card fee)" : ""}`.slice(0, 250) },
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
