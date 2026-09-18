/**
 * Counselors invite students by email; students accept a tokenized link.
 *
 * The linkage (setting the student's `counselor_id`) goes through the
 * `accept_invitation` database function, not a SELECT-then-UPDATE here: that
 * column's UPDATE grant is withheld from `authenticated`, so a SECURITY DEFINER
 * function is the only writer — and the token can't be enumerated, so an invite
 * has to be *received*, not discovered.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, conflict, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { appJoinUrl, newInviteToken } from "../lib/invites.js";
import { enforceQuota, limit } from "../lib/limits.js";
import { sendInviteEmail } from "../lib/email.js";
import { anonClient } from "../lib/supabase.js";
import { toInvitation, toMeridiesUser } from "../lib/serialize.js";

const inviteSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(320) })
  .strict();
const revokeSchema = z.object({ id: z.string().uuid() }).strict();
const acceptSchema = z.object({ token: z.string().trim().min(10).max(200) }).strict();
const previewSchema = z.object({ token: z.string().trim().min(10).max(200) });

export default async function inviteRoutes(app: FastifyInstance) {
  // Counselor invites a student by email — creates the invitation and emails it.
  app.post(
    "/",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:create", 30, 3600)] },
    async (request, reply) => {
      const { email } = inviteSchema.parse(request.body);

      // A real roster doesn't send 100 invites a day.
      await enforceQuota(
        request.auth.userId,
        "invites",
        "day",
        100,
        "You've sent a lot of invitations today. Try again tomorrow."
      );

      // Supersede any still-pending invite to the same address so a resend
      // doesn't pile up duplicates — the newest link is the one that works.
      await request.db
        .from("invitations")
        .update({ status: "revoked" })
        .eq("counselor_id", request.auth.userId)
        .eq("email", email)
        .eq("status", "pending");

      const token = newInviteToken();
      const { data, error } = await request.db
        .from("invitations")
        .insert({ counselor_id: request.auth.userId, email, token })
        .select("id, email, status, created_at, expires_at, accepted_at")
        .single();
      if (error) throw fromPostgrest(error);

      const { sent } = await sendInviteEmail({
        to: email,
        counselorName: request.profile.full_name ?? null,
        acceptUrl: appJoinUrl(token),
        logger: request.log,
      });

      return reply.code(201).send({ ...toInvitation(data), emailSent: sent });
    }
  );

  // Counselor lists their invitations (pending + accepted + revoked).
  app.get("/", { preHandler: [app.authenticate, requireRole("counselor")] }, async (request) => {
    const { data, error } = await request.db
      .from("invitations")
      .select(
        "id, email, status, created_at, expires_at, accepted_at, " +
          "accepted_by_profile:profiles!invitations_accepted_by_fkey(full_name)"
      )
      .eq("counselor_id", request.auth.userId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw fromPostgrest(error);
    return (data ?? []).map((row) => toInvitation(row as never));
  });

  // Counselor revokes a still-pending invitation.
  app.post(
    "/revoke",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("invites:revoke", 60, 3600)] },
    async (request) => {
      const { id } = revokeSchema.parse(request.body);
      const { data, error } = await request.db
        .from("invitations")
        .update({ status: "revoked" })
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .eq("status", "pending")
        .select("id, email, status, created_at, expires_at, accepted_at")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("No pending invitation of yours matches that");
      return toInvitation(data);
    }
  );

  // Public: the accept landing page shows who invited the student, before they
  // have an account. The token is the secret; this returns nothing an invited
  // student doesn't already know.
  app.get("/preview", async (request) => {
    const { token } = previewSchema.parse(request.query);
    const { data, error } = await anonClient().rpc("invitation_preview", { p_token: token });
    if (error) throw fromPostgrest(error);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { counselor_name?: string | null; invited_email?: string | null; valid?: boolean }
      | undefined;
    return {
      counselorName: row?.counselor_name ?? null,
      invitedEmail: row?.invited_email ?? null,
      valid: Boolean(row?.valid),
    };
  });

  // Signed-in student accepts an invitation → linked to the counselor.
  app.post(
    "/accept",
    {
      preHandler: [
        app.authenticate,
        requireRole("student"),
        limit("invites:accept", 15, 3600, "Too many attempts. Try again in an hour."),
      ],
    },
    async (request) => {
      const { token } = acceptSchema.parse(request.body);

      const { error } = await request.db.rpc("accept_invitation", { p_token: token });
      if (error) {
        const message =
          error.message?.replace(/^ERROR:\s*/i, "") || "Could not accept that invitation";
        const isConflict = /already been used|already connected/i.test(message);
        throw isConflict ? conflict(message) : badRequest(message);
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
