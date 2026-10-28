/**
 * One-click unsubscribe from the monthly Time saved emails (RFC 8058). Public: the
 * token in the path is the capability. One token per recipient and email type,
 * reused in every email, so a link never expires; it switches off only that type.
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

const INVALID = "<h1>This link isn't valid</h1><p>Use the link in one of your Time saved emails, or turn these emails off in Meridies Settings.</p>";

export default async function kpiUnsubscribeRoutes(app: FastifyInstance) {
  // RFC 8058: mail clients POST `List-Unsubscribe=One-Click` as a form (urlencoded or
  // multipart), with no cookies or auth. The body is accepted and ignored: the token is the request.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_r, _b, done) => done(null, {}));
  app.addContentTypeParser("multipart/form-data", { parseAs: "string", bodyLimit: 4096 }, (_r, _b, done) => done(null, {}));
  const config = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  async function lookup(token: string) {
    const svc = serviceClient();
    if (!svc) throw unavailable("Unsubscribe is unavailable on this server");
    if (!UNSUBSCRIBE_TOKEN.test(token)) return { svc, id: null, kind: null };
    const { data, error } = await svc.from("kpi_unsubscribe_tokens").select("recipient_id, kind").eq("token_hash", hashToken(token)).maybeSingle();
    if (error) throw unavailable("Unsubscribe is unavailable right now");
    return {
      svc,
      id: (data?.recipient_id as string | undefined) ?? null,
      kind: (data?.kind as "consultant" | "firm" | undefined) ?? null,
    };
  }

  const WHAT = { consultant: "monthly Time saved emails", firm: "monthly firm Time saved summaries" } as const;

  // Opening the link only shows a button, so a mail scanner that prefetches links unsubscribes no one.
  app.get("/kpi/unsubscribe/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { id, kind } = await lookup(token);
    if (!id || !kind) return page(reply, 404, INVALID);
    return page(reply, 200, `<h1>Stop the ${WHAT[kind]}?</h1>
<form method="post"><button type="submit" style="padding:10px 16px;font-size:15px">Unsubscribe</button></form>
<p style="color:#6b7280">You can turn them back on in Meridies Settings.</p>`);
  });

  // The button, and mail clients' one-click (List-Unsubscribe-Post), post here.
  app.post("/kpi/unsubscribe/:token", { config }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { svc, id, kind } = await lookup(token);
    if (!id || !kind) return page(reply, 404, INVALID);
    const column = kind === "firm" ? "firm_email" : "monthly_email";
    const { error } = await svc.from("kpi_baselines").upsert({ counselor_id: id, [column]: false }, { onConflict: "counselor_id" });
    if (error) throw unavailable("Unsubscribe is unavailable right now");
    return page(reply, 200, `<h1>You're unsubscribed</h1><p>You won't get the ${WHAT[kind]}. Turn them back on any time in Meridies Settings.</p>`);
  });
}
