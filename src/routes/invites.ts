/**
 * Counselors mint invite codes; students redeem them.
 *
 * Redemption goes through the `redeem_invite_code` database function rather
 * than a SELECT-then-UPDATE here: clients can't read codes they don't own, so a
 * code has to be *known*, not discovered. The function also does the linkage in
 * one transaction, which a two-step API call cannot.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, conflict, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { formatInviteCode, generateInviteCode, isValidInviteCode } from "../lib/invite-code.js";
import { enforceQuota, limit } from "../lib/limits.js";
import { toInvite, toMeridiesUser } from "../lib/serialize.js";

const redeemSchema = z.object({ code: z.string().trim().min(1).max(20) });
const createSchema = z
  .object({
    label: z.string().trim().max(120).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .optional();

const MAX_GENERATE_ATTEMPTS = 5;

export default async function inviteRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("invites:create", 20, 3600)],
    },
    async (request, reply) => {
      const body = createSchema.parse(request.body ?? undefined) ?? {};

      // A counselor with a legitimate roster still doesn't mint 200 codes a day.
      await enforceQuota(
        request.auth.userId,
        "invites",
        "day",
        50,
        "You've generated a lot of invite codes today. Try again tomorrow."
      );

      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString()
        : null;

      for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
        const code = generateInviteCode();
        const { data, error } = await request.db
          .from("invite_codes")
          .insert({
            code,
            counselor_id: request.auth.userId,
            label: body.label ?? null,
            expires_at: expiresAt,
          })
          .select("code, created_at, redeemed_at, label, expires_at, revoked_at")
          .single();

        if (!error && data) return reply.code(201).send(toInvite(data));
        // Unique collision on `code` is vanishingly rare — just try again.
        if (error && error.code !== "23505") throw fromPostgrest(error);
      }

      throw conflict("Could not generate a unique invite code, try again");
    }
  );

  app.get(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request) => {
      const { data, error } = await request.db
        .from("invite_codes")
        .select(
          "code, created_at, redeemed_at, label, expires_at, revoked_at, " +
            "redeemed_by_profile:profiles!invite_codes_redeemed_by_fkey(full_name)"
        )
        .eq("counselor_id", request.auth.userId)
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) throw fromPostgrest(error);
      return (data ?? []).map((row) => toInvite(row as never));
    }
  );

  app.post(
    "/revoke",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:revoke", 60, 3600)] },
    async (request) => {
      const { code } = redeemSchema.parse(request.body);
      const { data, error } = await request.db
        .from("invite_codes")
        .update({ revoked_at: new Date().toISOString() })
        .eq("code", formatInviteCode(code))
        .eq("counselor_id", request.auth.userId)
        .is("redeemed_by", null)
        .select("code, created_at, redeemed_at, label, expires_at, revoked_at")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("No unredeemed code of yours matches that");
      return toInvite(data);
    }
  );

  app.post(
    "/redeem",
    {
      // Tight: this is the one endpoint where guessing has a payoff.
      preHandler: [
        app.authenticate,
        requireRole("student"),
        limit("invites:redeem", 10, 3600, "Too many invite attempts. Try again in an hour."),
      ],
    },
    async (request) => {
      const { code } = redeemSchema.parse(request.body);
      if (!isValidInviteCode(code)) throw badRequest("That code isn't formatted correctly");

      const { error } = await request.db.rpc("redeem_invite_code", {
        p_code: formatInviteCode(code),
      });

      if (error) {
        // The function raises with meaningful, non-enumerable messages.
        const message = error.message?.replace(/^ERROR:\s*/i, "") || "Could not redeem that code";
        const status = /already been used|already connected/i.test(message)
          ? 409
          : /does not exist/i.test(message)
            ? 404
            : 400;
        throw status === 409
          ? conflict(message)
          : status === 404
            ? notFound(message)
            : badRequest(message);
      }

      const { data: profile, error: profileError } = await request.db
        .from("profiles")
        .select("*")
        .eq("id", request.auth.userId)
        .single();
      if (profileError) throw fromPostgrest(profileError);

      let counselorName: string | null = null;
      if (profile.counselor_id) {
        const { data } = await request.db
          .from("profiles")
          .select("full_name")
          .eq("id", profile.counselor_id)
          .maybeSingle();
        counselorName = data?.full_name ?? null;
      }

      return toMeridiesUser(profile as never, { counselorName });
    }
  );
}
