/**
 * Firm branding.
 *
 * The workspace takes its colour from the firm's logo or banner, so the accent
 * records where it came from as well as what it is — that way re-uploading a
 * logo can re-derive a sampled accent without overwriting one an admin typed.
 *
 * There is deliberately no create-a-firm route here: `profiles.firm_id` is one
 * of the columns whose UPDATE grant is withheld from `authenticated` (see the
 * privileged-columns migration), so joining a firm cannot be a plain PATCH and
 * must go through a SECURITY DEFINER function when that flow is built.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { forbidden, fromPostgrest, notFound } from "../lib/errors.js";
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
}
