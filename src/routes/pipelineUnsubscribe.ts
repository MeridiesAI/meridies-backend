/**
 * One-click unsubscribe from a Contact Pipeline email sequence (RFC 8058).
 * Public: the token in the path is the capability, as for the Time saved
 * emails (routes/kpiUnsubscribe.ts). A token belongs to one contact; using it
 * stamps the contact's `email_opted_out_at`, and a trigger stops every running
 * sequence for them. They are sent nothing more by any sequence.
 *
 *   GET  /pipeline/unsubscribe/:token   a page with a button. Changes nothing.
 *   POST /pipeline/unsubscribe/:token   unsubscribe (also what mail clients' one-click sends).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { unavailable } from "../lib/errors.js";
import { hashToken, UNSUBSCRIBE_TOKEN } from "../lib/kpi/monthly.js";
import { serviceClient } from "../lib/supabase.js";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(reply: FastifyReply, status: number, body: string) {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Robots-Tag", "noindex")
    .header("Content-Security-Policy", CSP)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Meridies emails</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1f2937">${body}</body></html>`);
}

const INVALID = "<h1>This link isn't valid</h1><p>Use the unsubscribe link in one of the emails you received.</p>";

export default async function pipelineUnsubscribeRoutes(app: FastifyInstance) {
  // RFC 8058: mail clients POST `List-Unsubscribe=One-Click` as a form, with no cookies or auth.
  // The body is accepted and ignored: the token is the request.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_r, _b, done) => done(null, {}));
  app.addContentTypeParser("multipart/form-data", { parseAs: "string", bodyLimit: 4096 }, (_r, _b, done) => done(null, {}));
  const config = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  async function lookup(token: string) {
    const svc = serviceClient();
    if (!svc) throw unavailable("Unsubscribe is unavailable on this server");
    if (!UNSUBSCRIBE_TOKEN.test(token)) return { svc, contactId: null };
    const { data, error } = await svc
      .from("pipeline_unsubscribe_tokens")
      .select("contact_id")
      .eq("token_hash", hashToken(token))
      .maybeSingle();
    if (error) throw unavailable("Unsubscribe is unavailable right now");
    return { svc, contactId: (data?.contact_id as string | undefined) ?? null };
  }

  // Opening the link only shows a button, so a mail scanner that prefetches links unsubscribes no one.
  app.get("/pipeline/unsubscribe/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { contactId } = await lookup(token);
    if (!contactId) return page(reply, 404, INVALID);
    return page(
      reply,
      200,
      `<h1>Stop these emails?</h1>
<form method="post"><button type="submit" style="padding:10px 16px;font-size:15px">Unsubscribe</button></form>`
    );
  });

  app.post("/pipeline/unsubscribe/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { svc, contactId } = await lookup(token);
    if (!contactId) return page(reply, 404, INVALID);
    const { error } = await svc
      .from("pipeline_contacts")
      .update({ email_opted_out_at: new Date().toISOString() })
      .eq("id", contactId)
      .is("email_opted_out_at", null);
    if (error) throw unavailable("Unsubscribe is unavailable right now");
    return page(reply, 200, "<h1>You're unsubscribed</h1><p>You won't get any more emails from this sequence.</p>");
  });
}
