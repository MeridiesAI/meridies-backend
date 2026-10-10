/**
 * Firm branding.
 *
 * The workspace takes its colour from the firm's logo or banner, so the accent
 * records where it came from as well as what it is — that way re-uploading a
 * logo can re-derive a sampled accent without overwriting one an admin typed.
 *
 * Firm teams (BACKEND_TODO §6). `profiles.firm_id` is one of the columns whose
 * UPDATE grant is withheld from `authenticated`, so creating, joining and
 * leaving a firm go through SECURITY DEFINER functions (migration
 * 20261007000006): create_firm, accept_firm_invitation, set_firm_member_role,
 * remove_firm_member.
 *
 *   POST   /firms                          start a firm (a solo counselor becomes owner)
 *   GET    /firms/mine/members             who is in it
 *   POST   /firms/mine/invites             invite a consultant by email (owner/admin)
 *   GET    /firms/mine/invites             open and past invitations (owner/admin)
 *   POST   /firms/mine/invites/:id/revoke
 *   POST   /firms/join                     accept an invitation (the token from the email)
 *   PATCH  /firms/mine/members/:profileId  change a seat (owner/admin)
 *   DELETE /firms/mine/members/:profileId  remove someone, or yourself to leave
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { env } from "../env.js";
import { crmError } from "../lib/crm.js";
import { brandedEmail, brandedText, sendEmail } from "../lib/email.js";
import { forbidden, fromPostgrest, notFound } from "../lib/errors.js";
import { newInviteToken } from "../lib/invites.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { toFirm } from "../lib/serialize.js";

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Use a #RRGGBB colour");

const brandingBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    website: z.string().trim().url().max(500).nullable().optional(),
    logoUrl: z.string().trim().url().max(2000).nullable().optional(),
    bannerUrl: z.string().trim().url().max(2000).nullable().optional(),
    // Validated here as well as by the CHECK constraint: this value is
    // interpolated into styles by the client, so a named colour or a css
    // function must never get through.
    accentColor: hexColor.nullable().optional(),
    accentColorSource: z.enum(["default", "logo", "banner", "manual"]).optional(),
  })
  .strict();

export default async function firmRoutes(app: FastifyInstance) {
  app.get("/mine", { preHandler: [app.authenticate, requireRole("counselor")] }, async (request) => {
    const firmId = request.profile.firm_id;
    if (!firmId) return null;

    const { data, error } = await request.db
      .from("firms")
      .select("*")
      .eq("id", firmId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) return null;
    return toFirm(data as Record<string, unknown>);
  });

  /**
   * Update branding. RLS restricts UPDATE to firm owners and admins; the check
   * here exists so a seat-holder gets a straight 403 rather than a silent
   * no-op that looks like the save worked.
   */
  app.patch(
    "/mine",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("firms:branding", 60, 60)],
    },
    async (request) => {
      const b = brandingBody.parse(request.body);
      const firmId = request.profile.firm_id;
      if (!firmId) throw notFound("You're not part of a firm yet");

      const { data: membership } = await request.db
        .from("firm_members")
        .select("seat_role")
        .eq("firm_id", firmId)
        .eq("profile_id", request.auth.userId)
        .maybeSingle();
      if (!membership || !["owner", "admin"].includes(String(membership.seat_role))) {
        throw forbidden("Only a firm owner or admin can change branding");
      }

      const update: Record<string, unknown> = {};
      if (b.name !== undefined) update.name = b.name;
      if (b.website !== undefined) update.website = b.website;
      if (b.logoUrl !== undefined) {
        update.logo_url = b.logoUrl;
        update.logo_updated_at = new Date().toISOString();
      }
      if (b.bannerUrl !== undefined) update.banner_url = b.bannerUrl;
      if (b.accentColor !== undefined) {
        update.accent_color = b.accentColor;
        // A colour arriving without a stated source was typed by a person.
        update.accent_color_source = b.accentColorSource ?? (b.accentColor ? "manual" : "default");
      } else if (b.accentColorSource !== undefined) {
        update.accent_color_source = b.accentColorSource;
      }

      const { data, error } = await request.db
        .from("firms")
        .update(update)
        .eq("id", firmId)
        .select("*")
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That firm isn't on file");
      return toFirm(data as Record<string, unknown>);
    }
  );

  // ---- Teams ------------------------------------------------------------------------

  const counselor = [app.authenticate, requireRole("counselor")];
  const uuid = z.string().uuid();

  app.post("/", { preHandler: [...counselor, limit("firms:create", 5, 3600)] }, async (request, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(200) }).strict().parse(request.body);
    const { data, error } = await request.db.rpc("create_firm", { p_name: name });
    if (error) throw crmError(error);
    return reply.code(201).send({ firmId: String(data) });
  });

  app.get("/mine/members", { preHandler: [...counselor, limit("firms:members", 120, 60)] }, async (request) => {
    const firmId = request.profile.firm_id;
    if (!firmId) return [];
    const { data, error } = await request.db
      .from("firm_members")
      .select("profile_id, seat_role, joined_at, profile:profiles!firm_members_profile_id_fkey(full_name, email)")
      .eq("firm_id", firmId)
      .order("joined_at");
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as Record<string, unknown>[]).map((m) => {
      const p = (m.profile ?? {}) as Record<string, unknown>;
      return {
        profileId: String(m.profile_id),
        seatRole: String(m.seat_role),
        joinedAt: String(m.joined_at),
        fullName: (p.full_name as string | null) ?? null,
        email: (p.email as string | null) ?? null,
      };
    });
  });

  app.post("/mine/invites", { preHandler: [...counselor, limit("firms:invite", 30, 3600)] }, async (request, reply) => {
    const b = z
      .object({ email: z.string().trim().toLowerCase().email().max(320), seatRole: z.enum(["admin", "counselor", "assistant"]).optional() })
      .strict()
      .parse(request.body);
    const firmId = request.profile.firm_id;
    if (!firmId) throw notFound("Start a firm first");
    const token = newInviteToken();
    const { data, error } = await request.db
      .from("firm_invitations")
      .insert({
        firm_id: firmId,
        email: b.email,
        seat_role: b.seatRole ?? "counselor",
        token_hash: createHash("sha256").update(token).digest("hex"),
        invited_by: request.auth.userId,
      })
      .select("id, email, seat_role, status, created_at, expires_at")
      .single();
    if (error) {
      if (error.code === "23505") throw crmError({ code: "P0001", message: "That address already has an open invitation" });
      if (error.code === "42501") throw forbidden("Only a firm owner or admin can invite");
      throw fromPostgrest(error);
    }
    const { data: firm } = await request.db.from("firms").select("name").eq("id", firmId).maybeSingle();
    const firmName = String((firm as Record<string, unknown> | null)?.name ?? "a practice");
    const url = `${env.APP_URL.replace(/\/+$/, "")}/join-firm/${token}`;
    const message = {
      heading: `Join ${firmName} on Meridies`,
      paragraphs: [
        `${request.profile.full_name ?? "A colleague"} invited you to join ${firmName} on Meridies as a ${b.seatRole ?? "counselor"}.`,
        "Sign in with this email address, then accept the invitation. It expires in 14 days.",
      ],
      cta: { label: "Accept the invitation", url },
    };
    const sent = await sendEmail({
      to: b.email,
      subject: `Join ${firmName} on Meridies`,
      html: brandedEmail(message),
      text: brandedText(message),
      template: "firm-invite",
      recipient_kind: "counselor",
      logger: request.log,
    });
    const row = data as Record<string, unknown>;
    return reply.code(201).send({
      id: String(row.id),
      email: String(row.email),
      seatRole: String(row.seat_role),
      status: String(row.status),
      expiresAt: String(row.expires_at),
      emailSent: sent.sent,
    });
  });

  app.get("/mine/invites", { preHandler: [...counselor, limit("firms:invites", 120, 60)] }, async (request) => {
    const firmId = request.profile.firm_id;
    if (!firmId) return [];
    const { data, error } = await request.db
      .from("firm_invitations")
      .select("id, email, seat_role, status, created_at, expires_at, accepted_at")
      .eq("firm_id", firmId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw fromPostgrest(error);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      email: String(r.email),
      seatRole: String(r.seat_role),
      status: String(r.status),
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
      acceptedAt: (r.accepted_at as string | null) ?? null,
    }));
  });

  app.post("/mine/invites/:id/revoke", { preHandler: [...counselor, limit("firms:invite", 60, 3600)] }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { data, error } = await request.db
      .from("firm_invitations")
      .update({ status: "revoked" })
      .eq("id", id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That invitation isn't open");
    return { id, status: "revoked" };
  });

  app.post("/join", { preHandler: [...counselor, limit("firms:join", 15, 3600)], config: { allowPending: true } }, async (request) => {
    const { token } = z.object({ token: z.string().trim().min(16).max(200) }).strict().parse(request.body);
    const { data, error } = await request.db.rpc("accept_firm_invitation", { p_token: token });
    if (error) throw crmError(error);
    return { firmId: String(data) };
  });

  app.patch("/mine/members/:profileId", { preHandler: [...counselor, limit("firms:members", 60, 60)] }, async (request) => {
    const { profileId } = z.object({ profileId: uuid }).parse(request.params);
    const { seatRole } = z.object({ seatRole: z.enum(["admin", "counselor", "assistant"]) }).strict().parse(request.body);
    const { error } = await request.db.rpc("set_firm_member_role", { p_profile: profileId, p_role: seatRole });
    if (error) throw crmError(error);
    return { profileId, seatRole };
  });

  app.delete("/mine/members/:profileId", { preHandler: [...counselor, limit("firms:members", 60, 60)] }, async (request, reply) => {
    const { profileId } = z.object({ profileId: uuid }).parse(request.params);
    const { error } = await request.db.rpc("remove_firm_member", { p_profile: profileId });
    if (error) throw crmError(error);
    return reply.code(204).send();
  });
}
