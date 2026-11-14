/**
 * Parent account invitations (migration 20261123000002; lib/parentInvites.ts).
 *
 *   POST /parent-invites            counselor: Invite to Meridies / Resend invite for one parent row  { guardianId }
 *   POST /parent-invites/preview    public: is this link good, and who is it from                     { token }
 *   POST /parent-invites/accept     public: make the parent account from a good link                  { token, fullName, password }
 *   POST /parent-invites/claim      signed in (Google): redeem the invitation for this account, or say why not  { token? }
 *
 * The token travels in the body, never the path or the query, so no log line carries it. Before the migration the
 * three answer 503 `parent_accounts_unavailable` (the app: "isn't switched on yet").
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { consumeRateLimit, enforceRateLimit, limit } from "../lib/limits.js";
import { PASSWORD_MIN, isInviteToken } from "../lib/parentAccounts.js";
import { claimParentInvite, counselorInvite, previewParentInvite, redeemParentInvite } from "../lib/parentInvites.js";
import { anonClient } from "../lib/supabase.js";

/** Invitations one parent row may be sent in a day (a resend or two, a typo fixed). */
export const INVITES_PER_PARENT_PER_DAY = 3;

const token = z.string().refine(isInviteToken, "That link isn't valid");

export default async function parentInviteRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("parent-invites:send", 40, 3600, "That's a lot of invitations this hour. Try again later."),
      ],
    },
    async (request, reply) => {
      const { guardianId } = z.object({ guardianId: z.string().uuid() }).strict().parse(request.body);
      // The row must be one of the caller's students' parents (RLS hides the rest); the database checks again.
      const { data: g, error } = await request.db.from("guardians").select("id, student_id").eq("id", guardianId).maybeSingle();
      if (error || !g) throw new HttpError(404, "That parent isn't on file", "guardian_not_found");
      await resolveStudentId(request, String((g as { student_id: string }).student_id), "edit");
      if (!(await consumeRateLimit(`parent-invite:guardian:${guardianId}`, INVITES_PER_PARENT_PER_DAY, 86_400, request.log))) {
        throw new HttpError(429, "This parent has had a few invitations today. Try again tomorrow.", "invite_rate_limited");
      }
      const result = await counselorInvite({
        db: request.db,
        guardianId,
        counselorId: request.auth.userId,
        counselorName: request.profile.full_name ?? null,
        counselorEmail: request.profile.email ?? null,
        log: request.log,
      });
      return reply.code(201).send(result);
    }
  );

  app.post("/preview", async (request) => {
    await enforceRateLimit(`parent-invites:preview:${request.ip}`, 60, 3600, "Too many tries. Try again in an hour.");
    const body = z.object({ token }).strict().parse(request.body);
    return previewParentInvite(anonClient(), body.token);
  });

  app.post("/accept", async (request, reply) => {
    await enforceRateLimit(`parent-invites:accept:${request.ip}`, 10, 3600, "Too many tries. Try again in an hour.");
    const body = z
      .object({
        token,
        fullName: z.string().trim().min(1, "Add your name").max(120),
        password: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters for your password.`).max(200),
      })
      .strict()
      .parse(request.body);
    const out = await redeemParentInvite({ token: body.token, fullName: body.fullName, password: body.password, anon: anonClient(), log: request.log });
    return reply.code(201).send(out);
  });

  /**
   * Back from Google on the parent path (the app's /join-parent/google). The invitation came back in the app's
   * httpOnly cookie and is posted here in the body. Open to every role (a parent signing in, a role-less first sign-in,
   * a student or counselor who is refused) and to a pending counselor, so each gets its own answer. A refusal is a
   * 4xx with `code` (and `maskedEmail` for a different Google account) and `signedOut` when the account the path
   * just made was taken back; the invitation stays unused.
   */
  app.post(
    "/claim",
    {
      preHandler: [app.authenticate, limit("parent-invites:claim", 20, 3600, "Too many tries. Try again in an hour.")],
      config: { allowParent: true, allowPending: true },
    },
    async (request, reply) => {
      const body = z.object({ token: token.optional() }).strict().parse(request.body ?? {});
      const r = await claimParentInvite({
        userId: request.auth.userId,
        profile: request.profile,
        token: body.token ?? null,
        anon: anonClient(),
        log: request.log,
      });
      if (r.outcome === "parent") return { outcome: "parent" };
      return reply.code(r.status).send({ error: r.message, code: r.code, ...(r.maskedEmail ? { maskedEmail: r.maskedEmail } : {}), signedOut: r.signedOut });
    }
  );
}
