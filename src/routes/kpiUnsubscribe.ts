/**
 * One-click unsubscribe from the monthly Time saved emails. Public: the token in
 * the path is the capability; only its hash is stored, and each email carries a
 * fresh one.
 *
 *   GET  /kpi/unsubscribe/:token   a page with a button. Changes nothing.
 *   POST /kpi/unsubscribe/:token   unsubscribe (also what mail clients' one-click sends).
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

const INVALID = "<h1>This link has expired</h1><p>Use the link in your most recent email, or turn these emails off in Meridies Settings.</p>";

export default async function kpiUnsubscribeRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_r, _b, done) => done(null, {}));
  const config = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  async function lookup(token: string) {
    const svc = serviceClient();
    if (!svc) throw unavailable("Unsubscribe is unavailable on this server");
    if (!UNSUBSCRIBE_TOKEN.test(token)) return { svc, id: null };
    const { data, error } = await svc.from("kpi_baselines").select("counselor_id").eq("unsubscribe_token_hash", hashToken(token)).maybeSingle();
    if (error) throw unavailable("Unsubscribe is unavailable right now");
    return { svc, id: (data?.counselor_id as string | undefined) ?? null };
  }

  app.get("/kpi/unsubscribe/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { id } = await lookup(token);
    if (!id) return page(reply, 404, INVALID);
    return page(reply, 200, `<h1>Stop the monthly Time saved emails?</h1>
<form method="post"><button type="submit" style="padding:10px 16px;font-size:15px">Unsubscribe</button></form>
<p style="color:#6b7280">You can turn them back on in Meridies Settings.</p>`);
  });

  app.post("/kpi/unsubscribe/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { svc, id } = await lookup(token);
    if (!id) return page(reply, 404, INVALID);
    const { error } = await svc.from("kpi_baselines").update({ monthly_email: false }).eq("counselor_id", id);
    if (error) throw unavailable("Unsubscribe is unavailable right now");
    return page(reply, 200, "<h1>You're unsubscribed</h1><p>You won't get the monthly Time saved emails. Turn them back on any time in Meridies Settings.</p>");
  });
}
