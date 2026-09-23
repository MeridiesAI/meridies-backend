/**
 * Scheduled meetings.
 *
 * `meeting_notes` records what was said; this records that a session was going
 * to happen at all, which is what the calendar and the "next meetings" card
 * read. Modes are Google Meet, Microsoft Teams, in person and phone — Zoom was
 * dropped in the v5 brief and its absence is deliberate.
 *
 * `createConference: true` books the session on the counselor's own Google or
 * Outlook calendar with a real Meet / Teams link (lib/suiteApi.ts), and the
 * meeting remembers the event so moving or cancelling it here does the same
 * there. The calendar call runs first: a meeting is never saved claiming a
 * link that the provider refused to create. No invitation is sent by this API.
 *
 * The counselor owns the calendar: a student sees their own meetings and cannot
 * move them.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import type { SuiteProvider } from "../lib/oauth.js";
import { toMeeting } from "../lib/serialize.js";
import {
  createConferenceEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  type CalendarEventInput,
} from "../lib/suiteApi.js";

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
    mode: z.enum(["google-meet", "teams", "in-person", "phone"]).optional(),
    location: z.string().trim().max(300).nullable().optional(),
    joinUrl: z.string().url().max(2000).nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable().optional(),
    agenda: z.string().trim().max(4000).nullable().optional(),
    guardiansInvited: z.boolean().optional(),
    deadlineId: z.string().uuid().nullable().optional(),
    /** Create the event, with a Meet/Teams link, on the connected calendar. */
    createConference: z.boolean().optional(),
  })
  .strict();

/** Which connected suite hosts a conference mode. */
function conferenceProvider(mode: string): SuiteProvider {
  if (mode === "google-meet") return "google";
  if (mode === "teams") return "microsoft";
  throw badRequest("Only Google Meet and Teams meetings get a calendar event with a link");
}

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
      const mode = body.mode ?? "google-meet";

      let calendar: { provider: SuiteProvider; eventId: string; joinUrl: string } | null = null;
      if (body.createConference) {
        const provider = conferenceProvider(mode);
        if (!body.endsAt) throw badRequest("A calendar event needs an end time");
        const created = await createConferenceEvent(
          request.auth.userId,
          provider,
          { title: body.title, startsAt: body.startsAt, endsAt: body.endsAt, description: body.agenda ?? null },
          request.log
        );
        calendar = { provider, ...created };
      }

      const { data, error } = await request.db
        .from("meetings")
        .insert({
          student_id: student,
          counselor_id: request.auth.userId,
          title: body.title,
          mode,
          location: body.location ?? null,
          join_url: calendar?.joinUrl ?? body.joinUrl ?? null,
          calendar_provider: calendar?.provider ?? null,
          calendar_event_id: calendar?.eventId ?? null,
          starts_at: body.startsAt,
          ends_at: body.endsAt ?? null,
          agenda: body.agenda ?? null,
          guardians_invited: body.guardiansInvited ?? false,
          deadline_id: body.deadlineId ?? null,
          created_by: request.auth.userId,
        })
        .select("*")
        .single();
      if (error) {
        // Don't leave an event on their calendar for a meeting that doesn't exist.
        if (calendar) {
          await deleteCalendarEvent(request.auth.userId, calendar.provider, calendar.eventId, request.log).catch(
            () => undefined
          );
        }
        throw fromPostgrest(error);
      }
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

      const existing = await loadMeeting(request, id);
      await resolveStudentId(request, String(existing.student_id), "edit");

      const calendarValues: Record<string, unknown> = {};
      await syncCalendar(request, existing, patch, calendarValues);

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
      // A calendar-backed meeting's link belongs to the calendar, not the form.
      if (existing.calendar_event_id && !("calendar_event_id" in calendarValues)) delete values.join_url;
      Object.assign(values, calendarValues);

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
      const existing = await loadMeeting(request, id);
      await resolveStudentId(request, String(existing.student_id), "edit");

      await dropCalendarEvent(request, existing);
      const { error } = await request.db.from("meetings").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}

/** The stored meeting — its real student_id, never the one a client claimed. */
async function loadMeeting(request: FastifyRequest, id: string): Promise<Row> {
  const { data, error } = await request.db
    .from("meetings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That meeting doesn't exist");
  return data as Row;
}

type MeetingPatch = z.infer<typeof meetingPatch>;

/**
 * Remove the calendar event behind a meeting. Best effort: a counselor must be
 * able to cancel or delete a meeting in Meridies even after disconnecting
 * Google, so a failure is logged rather than blocking the change.
 */
async function dropCalendarEvent(request: FastifyRequest, meeting: Row): Promise<boolean> {
  const provider = meeting.calendar_provider as SuiteProvider | null;
  const eventId = meeting.calendar_event_id as string | null;
  if (!provider || !eventId) return false;
  try {
    await deleteCalendarEvent(String(meeting.counselor_id), provider, eventId, request.log);
  } catch (err) {
    request.log.warn(
      { provider, err: err instanceof Error ? err.message : "unknown" },
      "calendar event delete failed; meeting changed in Meridies only"
    );
  }
  return true;
}

/**
 * Carry a patch to the calendar event, and add the resulting columns to
 * `values`. Moves and renames are strict — if the provider refuses, nothing is
 * saved, so Meridies and the calendar never disagree about when a session is.
 */
async function syncCalendar(
  request: FastifyRequest,
  existing: Row,
  patch: MeetingPatch,
  values: Record<string, unknown>
): Promise<void> {
  const provider = existing.calendar_provider as SuiteProvider | null;
  const eventId = existing.calendar_event_id as string | null;
  const nextMode = patch.mode ?? String(existing.mode);

  const cancelling = patch.status === "cancelled";
  const leavingConference = Boolean(provider) && patch.mode !== undefined && patch.mode !== existing.mode;
  if (provider && eventId && (cancelling || leavingConference)) {
    await dropCalendarEvent(request, existing);
    values.calendar_provider = null;
    values.calendar_event_id = null;
    if (leavingConference && patch.joinUrl === undefined) values.join_url = null;
    if (!patch.createConference) return;
  } else if (provider && eventId) {
    const change: Partial<CalendarEventInput> = {};
    if (patch.title !== undefined) change.title = patch.title;
    if (patch.startsAt !== undefined) change.startsAt = patch.startsAt;
    if (patch.endsAt) change.endsAt = patch.endsAt;
    if (patch.agenda !== undefined) change.description = patch.agenda;
    if (Object.keys(change).length > 0) {
      await updateCalendarEvent(String(existing.counselor_id), provider, eventId, change, request.log);
    }
    return;
  }

  if (patch.createConference && !cancelling) {
    const target = conferenceProvider(nextMode);
    const startsAt = patch.startsAt ?? (existing.starts_at as string);
    const endsAt = patch.endsAt ?? (existing.ends_at as string | null);
    if (!endsAt) throw badRequest("A calendar event needs an end time");
    const created = await createConferenceEvent(
      request.auth.userId,
      target,
      {
        title: patch.title ?? String(existing.title),
        startsAt,
        endsAt,
        description: patch.agenda !== undefined ? patch.agenda : ((existing.agenda as string | null) ?? null),
      },
      request.log
    );
    values.calendar_provider = target;
    values.calendar_event_id = created.eventId;
    values.join_url = created.joinUrl;
  }
}
