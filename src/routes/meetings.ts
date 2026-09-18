/**
 * Scheduled meetings.
 *
 * `meeting_notes` records what was said; this records that a session was going
 * to happen at all, which is what the calendar and the "next meetings" card
 * read. Modes are Google Meet, in person and phone — Zoom was dropped in the v5
 * brief and its absence is deliberate.
 *
 * The counselor owns the calendar: a student sees their own meetings and cannot
 * move them.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { toMeeting } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  studentId: z.string().uuid().optional(),
  status: z.enum(["scheduled", "held", "cancelled", "no-show"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const meetingBody = z
  .object({
    studentId: z.string().uuid(),
    title: z.string().trim().min(1).max(300),
    mode: z.enum(["google-meet", "in-person", "phone"]).optional(),
    location: z.string().trim().max(300).nullable().optional(),
    joinUrl: z.string().url().max(2000).nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable().optional(),
    agenda: z.string().trim().max(4000).nullable().optional(),
    guardiansInvited: z.boolean().optional(),
    deadlineId: z.string().uuid().nullable().optional(),
  })
  .strict();

const meetingPatch = meetingBody
  .omit({ studentId: true })
  .extend({
    status: z.enum(["scheduled", "held", "cancelled", "no-show"]),
    meetingNoteId: z.string().uuid().nullable(),
  })
  .partial()
  .strict();

export default async function meetingRoutes(app: FastifyInstance) {
  app.get(
    "/",
    { preHandler: [app.authenticate, limit("meetings:list", 240, 60)] },
    async (request) => {
      const q = listQuery.parse(request.query);

      let builder = request.db.from("meetings").select("*");

      // A counselor with no studentId wants their whole calendar; with one, they
      // want that student's — and resolveStudentId is what proves they may.
      if (q.studentId || request.profile.role === "student") {
        const student = await resolveStudentId(request, q.studentId, "view");
        builder = builder.eq("student_id", student);
      } else {
        builder = builder.eq("counselor_id", request.auth.userId);
      }

      if (q.status) builder = builder.eq("status", q.status);
      if (q.from) builder = builder.gte("starts_at", q.from);
      if (q.to) builder = builder.lte("starts_at", q.to);

      const { data, error } = await builder
        .order("starts_at", { ascending: true })
        .limit(q.limit ?? 100);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => toMeeting(r as Row));
    }
  );

  app.get(
    "/:id",
    { preHandler: [app.authenticate, limit("meetings:read", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db
        .from("meetings")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That meeting doesn't exist");
      return toMeeting(data as Row);
    }
  );

  app.post(
    "/",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:create", 120, 60)],
    },
    async (request, reply) => {
      const body = meetingBody.parse(request.body);
      const student = await resolveStudentId(request, body.studentId, "edit");

      const { data, error } = await request.db
        .from("meetings")
        .insert({
          student_id: student,
          counselor_id: request.auth.userId,
          title: body.title,
          mode: body.mode ?? "google-meet",
          location: body.location ?? null,
          join_url: body.joinUrl ?? null,
          starts_at: body.startsAt,
          ends_at: body.endsAt ?? null,
          agenda: body.agenda ?? null,
          guardians_invited: body.guardiansInvited ?? false,
          deadline_id: body.deadlineId ?? null,
          created_by: request.auth.userId,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return reply.code(201).send(toMeeting(data as Row));
    }
  );

  app.patch(
    "/:id",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:update", 240, 60)],
    },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const patch = meetingPatch.parse(request.body);

      const owner = await loadOwner(request, id);
      await resolveStudentId(request, owner, "edit");

      const values: Record<string, unknown> = {};
      if (patch.title !== undefined) values.title = patch.title;
      if (patch.mode !== undefined) values.mode = patch.mode;
      if (patch.location !== undefined) values.location = patch.location;
      if (patch.joinUrl !== undefined) values.join_url = patch.joinUrl;
      if (patch.startsAt !== undefined) values.starts_at = patch.startsAt;
      if (patch.endsAt !== undefined) values.ends_at = patch.endsAt;
      if (patch.agenda !== undefined) values.agenda = patch.agenda;
      if (patch.guardiansInvited !== undefined) values.guardians_invited = patch.guardiansInvited;
      if (patch.deadlineId !== undefined) values.deadline_id = patch.deadlineId;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.meetingNoteId !== undefined) values.meeting_note_id = patch.meetingNoteId;

      const { data, error } = await request.db
        .from("meetings")
        .update(values)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toMeeting(data as Row);
    }
  );

  /**
   * Deleting a meeting that happened loses the record that it happened, so the
   * calendar cancels rather than deletes unless the meeting is still scheduled.
   */
  app.delete(
    "/:id",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:delete", 60, 60)],
    },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await loadOwner(request, id);
      await resolveStudentId(request, owner, "edit");

      const { error } = await request.db.from("meetings").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}

/** The meeting's real student_id — never the one a client claimed. */
async function loadOwner(request: FastifyRequest, id: string): Promise<string> {
  const { data, error } = await request.db
    .from("meetings")
    .select("student_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That meeting doesn't exist");
  return data.student_id as string;
}
