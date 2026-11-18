/**
 * Acceptance of the Meridies platform terms (migration 20261129000001, table platform_terms_acceptances).
 * Not agreement_acceptances: that table belongs to a Consultant's client agreements.
 *
 *   GET  /terms/status   { version, accepted, acceptedAt, required }   (`required` only for a Consultant, and only with
 *                        TERMS_UPDATE_PROMPT_ENABLED=true; the app shows its prompt then)
 *   POST /terms/accept   { version }  records that this user accepted that version. Idempotent.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { badRequest, fromPostgrest, HttpError, unavailable } from "../lib/errors.js";
import { limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { serviceClient } from "../lib/supabase.js";

const acceptBody = z.object({ version: z.string().trim().min(1).max(40) }).strict();
const notSwitchedOn = () => new HttpError(503, "Terms acceptance isn't switched on yet", "terms_unavailable");

export const promptEnabled = (flag: string | undefined) => flag === "true";

export default async function platformTermsRoutes(app: FastifyInstance) {
  const config = { allowPending: true };

  app.get("/status", { preHandler: [app.authenticate], config }, async (request) => {
    const version = env.TERMS_VERSION;
    const { data, error } = await request.db
      .from("platform_terms_acceptances")
      .select("accepted_at")
      .eq("user_id", request.auth.userId)
      .eq("terms_version", version)
      .maybeSingle();
    if (error) throw isResultsNotApplied(error) || error.code === "42P01" ? notSwitchedOn() : fromPostgrest(error);
    const accepted = Boolean(data);
    return {
      version,
      accepted,
      acceptedAt: (data as { accepted_at?: string } | null)?.accepted_at ?? null,
      required: !accepted && request.profile.role === "counselor" && promptEnabled(env.TERMS_UPDATE_PROMPT_ENABLED),
    };
  });

  app.post("/accept", { preHandler: [app.authenticate, limit("terms:accept", 30, 3600)], config }, async (request) => {
    const { version } = acceptBody.parse(request.body);
    // Only the version in force can be accepted: a stale page can't record an old text as current.
    if (version !== env.TERMS_VERSION) throw badRequest("Those terms have been updated. Reload and read the new version.");
    const svc = serviceClient();
    if (!svc) throw unavailable("Terms acceptance needs the service role key.");
    const { error } = await svc
      .from("platform_terms_acceptances")
      .upsert({ user_id: request.auth.userId, terms_version: version }, { onConflict: "user_id,terms_version", ignoreDuplicates: true });
    if (error) throw isResultsNotApplied(error) || error.code === "42P01" ? notSwitchedOn() : fromPostgrest(error);
    return { version, accepted: true };
  });
}
