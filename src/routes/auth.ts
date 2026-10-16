/**
 * Identity. There is no signup/login here any more — Supabase Auth owns that,
 * and the frontend talks to it directly. This route only answers "who am I"
 * and lets a user edit their own profile.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accessStatusOf } from "../lib/access.js";
import { requestAccess, reviewBase } from "../lib/accessReview.js";
import { badRequest, forbidden, fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { limit } from "../lib/limits.js";
import { isProfileTooLarge, MAX_PROFILE_BYTES, mergeProfile, profileBytes } from "../lib/profileSize.js";
import { toMeridiesUser } from "../lib/serialize.js";
import { serviceClient } from "../lib/supabase.js";

const updateMeSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    onboardingStep: z.number().int().min(0).max(50),
    onboardingComplete: z.boolean(),
    phone: z.string().trim().max(40),
    timezone: z.string().trim().max(80),
    title: z.string().trim().max(120),
    headline: z.string().trim().max(300),
    hometown: z.string().trim().max(200),
    highSchool: z.string().trim().max(200),
    gradYear: z.string().trim().regex(/^(\d{4})?$/, "Use a four-digit year, like 2027"),
    // Free-form intake answers. Merged, not replaced, so a partial save can
    // never wipe answers the client didn't happen to send. Bounded: a save of
    // profile.intakeAnswers runs the questionnaire sync in the database
    // (20261023010002), so nobody parks a megabyte here. The patch is checked
    // here and the merged value below (lib/profileSize.ts).
    profile: z
      .record(z.unknown())
      .refine((p) => profileBytes(p) <= MAX_PROFILE_BYTES, "Profile is too large"),
  })
  .partial()
  .strict();

/** Confirm an OAuth sign-up's role, exactly once. */
const confirmRoleSchema = z.object({ role: z.enum(["student", "counselor"]) }).strict();

export default async function authRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: app.authenticate, config: { allowPending: true } }, async (request) => {
    const p = request.profile;

    let counselorName: string | null = null;
    if (p.counselor_id) {
      const { data } = await request.db
        .from("profiles")
        .select("full_name")
        .eq("id", p.counselor_id)
        .maybeSingle();
      counselorName = data?.full_name ?? null;
    }

    return toMeridiesUser(p, { counselorName });
  });

  app.patch(
    "/me",
    { preHandler: [app.authenticate, limit("auth:patch", 60, 60)], config: { allowPending: true } },
    async (request) => {
      const patch = updateMeSchema.parse(request.body);

      const update: Record<string, unknown> = {};
      if (patch.fullName !== undefined) update.full_name = patch.fullName;
      if (patch.onboardingStep !== undefined) update.onboarding_step = patch.onboardingStep;
      if (patch.onboardingComplete !== undefined)
        update.onboarding_complete = patch.onboardingComplete;
      if (patch.phone !== undefined) update.phone = patch.phone;
      if (patch.timezone !== undefined) update.timezone = patch.timezone;
      if (patch.title !== undefined) update.title = patch.title;
      if (patch.headline !== undefined) update.headline = patch.headline;
      if (patch.hometown !== undefined) update.hometown = patch.hometown;
      if (patch.highSchool !== undefined) update.high_school = patch.highSchool;
      if (patch.gradYear !== undefined) update.grad_year = patch.gradYear;
      if (patch.profile !== undefined) {
        const { merged, tooLarge } = mergeProfile(request.profile.profile, patch.profile);
        if (tooLarge) throw badRequest("Profile is too large");
        update.profile = merged;
      }

      // `role` is deliberately absent: a user cannot promote themselves.
      const { data, error } = await request.db
        .from("profiles")
        .update(update)
        .eq("id", request.auth.userId)
        .select("*")
        .maybeSingle();

      if (isProfileTooLarge(error)) throw badRequest("Profile is too large");
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("Profile not found");

      return toMeridiesUser(data as never, { counselorName: null });
    }
  );

  /**
   * OAuth sign-ups never pick a role, so handle_new_user defaults them to
   * `student` with role_confirmed=false. This sets the real role once.
   *
   * It goes through the `confirm_user_role` function rather than an UPDATE,
   * because `profiles.role` is not writable by `authenticated` at all — that
   * column grant was revoked after a check showed a student could otherwise
   * PATCH themselves into a counselor straight through PostgREST.
   */
  app.post(
    "/confirm-role",
    { preHandler: [app.authenticate, limit("auth:confirm-role", 10, 3600)], config: { allowPending: true } },
    async (request, reply) => {
      const { role } = confirmRoleSchema.parse(request.body);

      const { data, error } = await request.db.rpc("confirm_user_role", { p_role: role });

      if (error) {
        if (/already set/i.test(error.message ?? "")) {
          return reply.code(409).send({
            error: "Your role is already set. Contact support to change it.",
          });
        }
        throw fromPostgrest(error);
      }

      return toMeridiesUser(data as never, { counselorName: null });
    }
  );

  /**
   * A pending counselor asks Meridies to review their account. The holding
   * screen calls this on every visit; inside 24 hours of the last request it
   * does nothing. `emailed` says whether a review email left just now.
   */
  app.post(
    "/request-access",
    {
      preHandler: [app.authenticate, limit("auth:request-access", 10, 3600)],
      config: { allowPending: true },
    },
    async (request) => {
      const status = accessStatusOf(request.profile);
      if (status === null) throw forbidden("Only counselor accounts are reviewed");
      if (status === "approved") return { status, emailed: false };

      const svc = serviceClient();
      if (!svc || !reviewBase()) throw unavailable("Account review is unavailable right now");
      const outcome = await requestAccess(svc, request.auth.userId, request.log);
      return { status, emailed: outcome === "sent" };
    }
  );
}
