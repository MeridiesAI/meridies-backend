/**
 * The signed-in student's own view (SV Demo v2), under /me. Student-only:
 * "me" is always the caller's JWT, and no route here takes a student id.
 *
 *   GET   /me/overview                 header facts + the info card + preferences
 *   PATCH /me/overview                 edit the info card (the counselor's fields,
 *                                      minus the parent's contact details)
 *   GET   /me/preferences              banner, theme, reminder channels
 *   PATCH /me/preferences              change any of them
 *   POST  /me/preferences/banner-upload a signed upload URL for a banner image
 *   PATCH /me/settings                 display name and theme, nothing else
 *   GET   /me/polygon                  the strength profile, read-only
 *   GET   /me/polygon/years            its recorded freshman-to-now history
 *
 * Everything else the student view shows is an existing route the student
 * may already call for themselves: tasks (/tasks), files (/files/*), the
 * Application sheets (/application/*) and Profile Update (/profile-updates).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  applyInfoPatch,
  infoPatchSchema,
  loadPolygon,
  loadPolygonYears,
  loadStudentInfo,
  type StudentInfo,
} from "../lib/studentPage.js";
import {
  BANNER_TYPES,
  bannerUploadUrl,
  loadPreferences,
  preferencesPatch,
  savePreferences,
  THEMES,
} from "../lib/studentView.js";

const settingsPatch = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    theme: z.enum(THEMES),
  })
  .partial()
  .strict();

const bannerUploadBody = z
  .object({
    contentType: z.enum(Object.keys(BANNER_TYPES) as [keyof typeof BANNER_TYPES, ...(keyof typeof BANNER_TYPES)[]]),
  })
  .strict();

async function counselorOf(request: FastifyRequest) {
  const counselorId = request.profile.counselor_id;
  if (!counselorId) return null;
  const { data, error } = await request.db
    .from("profiles")
    .select("id, full_name")
    .eq("id", counselorId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  return data ? { id: String(data.id), name: String(data.full_name ?? "") } : null;
}

async function overview(request: FastifyRequest, info?: StudentInfo) {
  const me = request.auth.userId;
  const [card, counselor, preferences] = await Promise.all([
    info ? Promise.resolve(info) : loadStudentInfo(request.db, me),
    counselorOf(request),
    loadPreferences(request.db, me),
  ]);
  if (!card) throw notFound("Your profile isn't set up yet");
  return {
    // The header: "Class of 2027 · Ithaca High School · with <counselor>".
    classYear: card.gradYear,
    highSchool: card.highSchool,
    counselor,
    // The same DTO the counselor's info card reads (GET /student-page/:id/info).
    info: card,
    preferences,
  };
}

export default async function meRoutes(app: FastifyInstance) {
  const student = [app.authenticate, requireRole("student")];

  app.get(
    "/overview",
    { preHandler: [...student, limit("me:overview", 240, 60)] },
    async (request) => overview(request)
  );

  app.patch(
    "/overview",
    { preHandler: [...student, limit("me:overview-write", 240, 60)] },
    async (request) => {
      const patch = infoPatchSchema.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
      const info = await applyInfoPatch(request, request.auth.userId, patch);
      return overview(request, info);
    }
  );

  app.get(
    "/preferences",
    { preHandler: [...student, limit("me:preferences", 240, 60)] },
    async (request) => loadPreferences(request.db, request.auth.userId)
  );

  app.patch(
    "/preferences",
    { preHandler: [...student, limit("me:preferences-write", 120, 60)] },
    async (request) => {
      const patch = preferencesPatch.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
      return savePreferences(request.db, request.auth.userId, patch);
    }
  );

  app.post(
    "/preferences/banner-upload",
    { preHandler: [...student, limit("me:banner-upload", 20, 3600, "That's a lot of banner uploads.")] },
    async (request, reply) => {
      const { contentType } = bannerUploadBody.parse(request.body);
      return reply.code(201).send(await bannerUploadUrl(request.db, request.auth.userId, contentType));
    }
  );

  /** Settings: the display name and the theme. Nothing else is the student's to change here. */
  app.patch(
    "/settings",
    { preHandler: [...student, limit("me:settings", 60, 60)] },
    async (request) => {
      const patch = settingsPatch.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
      const me = request.auth.userId;

      let fullName = request.profile.full_name;
      if (patch.fullName !== undefined) {
        const { data, error } = await request.db
          .from("profiles")
          .update({ full_name: patch.fullName })
          .eq("id", me)
          .select("full_name")
          .maybeSingle();
        if (error) throw fromPostgrest(error);
        if (!data) throw notFound("Profile not found");
        fullName = String(data.full_name);
      }

      const preferences =
        patch.theme !== undefined
          ? await savePreferences(request.db, me, { theme: patch.theme })
          : await loadPreferences(request.db, me);

      return { fullName, theme: preferences.theme };
    }
  );

  // The strength profile: read-only for the student (RLS refuses their
  // writes), with today's derived scores computed in memory.
  app.get(
    "/polygon",
    { preHandler: [...student, limit("me:polygon", 240, 60)] },
    async (request) => loadPolygon(request.db, request.auth.userId, { persist: false })
  );

  app.get(
    "/polygon/years",
    { preHandler: [...student, limit("me:polygon-years", 120, 60)] },
    async (request) => loadPolygonYears(request.db, request.auth.userId)
  );
}
