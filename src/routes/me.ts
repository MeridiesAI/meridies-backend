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
 *   GET   /me/messages                 the texts and emails sent to the student
 *   GET   /me/intake                   what the counselor asked for on New student
 *   PATCH /me/intake/:taskId           a typed answer instead of a file
 *   POST  /me/intake/submit            send every answered item to the counselor
 *   GET   /me/setup                    "Getting started": what is left once confirmed
 *   GET   /me/invitations              pending invitations to my email (no tokens)
 *   POST  /me/invitations/:id/accept   accept one, as the student
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
import { loadMyIntake, saveMyAnswer, submitMyIntake } from "../lib/newStudentIntake.js";
import { STUDENT_STEPS, openSteps, setupFacts } from "../lib/studentSetup.js";
import { acceptMyInvitation, listMyInvitations } from "../lib/myInvitations.js";
import { toMeridiesUser } from "../lib/serialize.js";
import { hydrate } from "./tasks.js";

const settingsPatch = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    theme: z.enum(THEMES),
  })
  .partial()
  .strict();

const messagesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();

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
    info ? Promise.resolve(info) : loadStudentInfo(request.db, me, request.log),
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

  /**
   * What Meridies sent the student by text and email, newest first: task
   * assignments, AxIS's hand-in verdicts, reminders, the counselor's
   * composer messages. Read on the student's own client; RLS
   * (`message_deliveries_student_self`) returns only rows addressed to them.
   */
  app.get(
    "/messages",
    { preHandler: [...student, limit("me:messages", 120, 60)] },
    async (request) => {
      const { limit: max } = messagesQuery.parse(request.query);
      const me = request.auth.userId;
      const { data, error } = await request.db
        .from("message_deliveries")
        .select("id, channel, subject, body, status, sent_at, created_at")
        .eq("student_id", me)
        .eq("recipient_kind", "student")
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(max);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => ({
        id: String(r.id),
        channel: r.channel === "sms" ? "sms" : "email",
        subject: typeof r.subject === "string" ? r.subject : null,
        body: typeof r.body === "string" ? r.body.slice(0, 600) : "",
        status: String(r.status),
        sentAt: typeof r.sent_at === "string" ? r.sent_at : null,
        createdAt: String(r.created_at),
      }));
    }
  );

  app.get(
    "/polygon/years",
    { preHandler: [...student, limit("me:polygon-years", 120, 60)] },
    async (request) => loadPolygonYears(request.db, request.auth.userId)
  );

  // New-student onboarding (20261015000001): the red-outlined request card.
  async function myIntake(request: FastifyRequest) {
    const intake = await loadMyIntake(request);
    if (!intake) return null;
    const { data, error } = await request.db
      .from("deliverables")
      .select("*")
      .eq("student_id", request.auth.userId)
      .eq("intake_invitation_id", intake.invitationId)
      .order("created_at");
    if (error) throw fromPostgrest(error);
    return { ...intake, tasks: await hydrate(request, (data ?? []) as Record<string, unknown>[]) };
  }

  app.get(
    "/intake",
    { preHandler: [...student, limit("me:intake", 240, 60)] },
    async (request) => ({ intake: await myIntake(request) })
  );

  app.patch(
    "/intake/:taskId",
    { preHandler: [...student, limit("me:intake-write", 240, 60)] },
    async (request) => {
      const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params);
      const { answer } = z
        .object({ answer: z.string().max(500).nullable() })
        .strict()
        .parse(request.body);
      await saveMyAnswer(request, taskId, answer);
      return { intake: await myIntake(request) };
    }
  );

  app.post(
    "/intake/submit",
    { preHandler: [...student, limit("me:intake-submit", 10, 60)] },
    async (request) => {
      await submitMyIntake(request);
      return { intake: await myIntake(request) };
    }
  );

  // "Getting started": only once the counselor confirmed this student, except
  // "Fill out your profile", which a student who skipped step 2 sees at once.
  app.get(
    "/setup",
    { preHandler: [...student, limit("me:setup", 240, 60)] },
    async (request) => {
      const intake = await loadMyIntake(request);
      const steps = intake?.confirmedAt ? STUDENT_STEPS : STUDENT_STEPS.filter((s) => s.key === "profile");
      const facts = (await setupFacts(request, [request.auth.userId])).get(request.auth.userId);
      return { steps: facts ? openSteps(steps, facts) : [] };
    }
  );

  // The Connect step: invitations sent to this account's confirmed address.
  app.get(
    "/invitations",
    { preHandler: [...student, limit("me:invitations", 60, 60)] },
    async (request) => ({ invitations: await listMyInvitations(request) })
  );

  app.post(
    "/invitations/:id/accept",
    { preHandler: [...student, limit("me:invitations-accept", 15, 3600, "Too many attempts. Try again in an hour.")] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await acceptMyInvitation(request, id);
      const { data: profile, error } = await request.db
        .from("profiles")
        .select("*")
        .eq("id", request.auth.userId)
        .single();
      if (error) throw fromPostgrest(error);
      let counselorName: string | null = null;
      if (profile.counselor_id) {
        const { data } = await request.db.from("profiles").select("full_name").eq("id", profile.counselor_id).maybeSingle();
        counselorName = data?.full_name ?? null;
      }
      return toMeridiesUser(profile as never, { counselorName });
    }
  );
}
