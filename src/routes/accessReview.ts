/**
 * The account review link (lib/accessReview.ts). Public: the token in the path
 * is the capability, and it is emailed only to the review inbox.
 *
 *   GET  /access-review/:token   who is being approved, and a button. Changes nothing.
 *   POST /access-review/:token   approve. The token works once.
 *
 * Unknown, used and expired tokens all get the same page.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  TOKEN_SHAPE, hashReviewToken, loadApplicant, reviewPage, sendApprovedEmail, type ReviewView,
} from "../lib/accessReview.js";
import { unavailable } from "../lib/errors.js";
import { serviceClient } from "../lib/supabase.js";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function send(reply: FastifyReply, status: number, view: ReviewView) {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Robots-Tag", "noindex")
    .header("Content-Security-Policy", CSP)
    .type("text/html; charset=utf-8")
    .send(reviewPage(view));
}

export default async function accessReviewRoutes(app: FastifyInstance) {
  // The page's form posts an empty urlencoded body; accept it and ignore it.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 1024 },
    (_request, _body, done) => done(null, {})
  );

  // A human opens this a handful of times; anything faster is guessing.
  const config = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  app.get("/access-review/:token", { config }, async (request, reply) => {
    const svc = serviceClient();
    if (!svc) throw unavailable("Account review is unavailable on this server");
    const { token } = request.params as { token: string };
    if (!TOKEN_SHAPE.test(token)) return send(reply, 404, { kind: "invalid" });

    const { data, error } = await svc
      .from("counselor_access_requests")
      .select("profile_id, expires_at, used_at")
      .eq("token_hash", hashReviewToken(token))
      .maybeSingle();
    if (error) {
      request.log.error({ code: error.code }, "access review: request read failed");
      throw unavailable("Account review is unavailable right now");
    }
    if (!data || data.used_at || new Date(String(data.expires_at)).getTime() <= Date.now()) {
      return send(reply, 404, { kind: "invalid" });
    }
    const applicant = await loadApplicant(svc, String(data.profile_id));
    if (!applicant) return send(reply, 404, { kind: "invalid" });
    return send(reply, 200, { kind: "confirm", applicant });
  });

  app.post("/access-review/:token", { config }, async (request, reply) => {
    const svc = serviceClient();
    if (!svc) throw unavailable("Account review is unavailable on this server");
    const { token } = request.params as { token: string };
    if (!TOKEN_SHAPE.test(token)) return send(reply, 404, { kind: "invalid" });

    const { data, error } = await svc.rpc("approve_counselor_by_token", { p_token_hash: hashReviewToken(token) });
    if (error) {
      request.log.error({ code: error.code }, "access review: approve failed");
      throw unavailable("Account review is unavailable right now");
    }
    const row = (Array.isArray(data) ? data[0] : data) as { profile_id?: string } | null | undefined;
    if (!row?.profile_id) return send(reply, 404, { kind: "invalid" });

    const applicant = await loadApplicant(svc, row.profile_id);
    if (!applicant) return send(reply, 404, { kind: "invalid" });
    await sendApprovedEmail(applicant, request.log);
    return send(reply, 200, { kind: "approved", applicant });
  });
}
