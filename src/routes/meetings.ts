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
 * link that the provider refused to create. That provider event carries no
 * attendees and sends nobody anything.
 *
 * Invitations are Meridies' own: with `sendInvites` on, each invited student
 * (and their guardians, when the meeting invites them) is emailed an
 * iCalendar invite that any calendar can add, connected or not, and moves,
 * cancellations and deletions follow (lib/meetingInvites.ts). The emails go
 * out after the response; the response says who they are going to
 * (`invites`). `notifyAttendees: false` on a PATCH keeps one change to
 * Meridies; switching `sendInvites` itself always tells invitees.
 *
 * The counselor owns the calendar: a student sees their own meetings and cannot
 * move them.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, forbidden, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  INVITES_UNAVAILABLE,
  inviteColumns,
  inviteEndError,
  invitesReady,
  latestInvitePerAddress,
  loadAttendeeIds,
  meetingState,
  prepareInviteRound,
  startInviteDelivery,
  type InviteRoundSummary,
} from "../lib/meetingInvites.js";
import {
  calendarAccess,
  NOT_OWNER_CONFERENCE,
  NOT_OWNER_SKIP,
  ownsMeeting,
} from "../lib/meetingCalendar.js";
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
    /**
     * Every student invited (Demo booker's multi-select). The primary
     * `studentId` is always one of them whether listed or not.
     */
    attendeeIds: z.array(z.string().uuid()).max(30).optional(),
    /** Email each invitee an iCalendar invite, and every change after it. Needs an end time. */
    sendInvites: z.boolean().optional(),
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
    /** Email this change to invitees when invites are on (default true). */
    notifyAttendees: z.boolean(),
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
        // Their own meetings and the ones they were invited to.
        const invited = await invitedMeetingIds(request, student);
        builder = invited.length
          ? builder.or(`student_id.eq.${student},id.in.(${invited.join(",")})`)
          : builder.eq("student_id", student);
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
      return withAttendees(request, (data ?? []) as Row[]);
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
      return (await withAttendees(request, [data as Row]))[0];
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
      const invitees = await checkAttendees(request, student, body.attendeeIds);
      const ready = await invitesReady(request.db);
      const endError = inviteEndError(ready, body.sendInvites === true, body.endsAt);
      if (endError) throw badRequest(endError);

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
          ...inviteColumns(ready, body.sendInvites),
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
      const saved = data as Row;
      if (invitees.length > 0) {
        const { error: aErr } = await request.db
          .from("meeting_attendees")
          .upsert(
            invitees.map((id) => ({ meeting_id: saved.id, student_id: id })),
            { onConflict: "meeting_id,student_id", ignoreDuplicates: true }
          );
        if (aErr) throw fromPostgrest(aErr);
      }
      let invites: InviteRoundSummary = { status: "none" };
      if (body.sendInvites && !ready) invites = INVITES_UNAVAILABLE;
      else if (body.sendInvites) {
        const prepared = await prepareInviteRound(request, {
          before: null,
          after: meetingState(saved),
          attendeesBefore: [],
          attendeesAfter: [student, ...invitees],
          notify: true,
        });
        invites = prepared.summary;
        startInviteDelivery(prepared.round, request.log);
      }
      return reply.code(201).send({ ...(await withAttendees(request, [saved]))[0], invites });
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
      const primary = String(existing.student_id);
      await resolveStudentId(request, primary, "edit");
      const invitees =
        patch.attendeeIds === undefined
          ? null
          : await checkAttendees(request, primary, patch.attendeeIds);

      const ready = await invitesReady(request.db);
      const before = meetingState(existing);
      const endError = inviteEndError(
        ready,
        patch.sendInvites ?? before.sendInvites,
        patch.endsAt !== undefined ? patch.endsAt : before.endsAt
      );
      if (endError) throw badRequest(endError);
      // Who held the invite before this change, read before anything moves.
      const tracking = ready && (before.sendInvites || patch.sendInvites === true);
      const attendeesBefore = tracking ? await attendeeIds(request, before) : [];

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
      Object.assign(values, calendarValues, inviteColumns(ready, patch.sendInvites));

      // Only the invitees changed (or nothing did): nothing to write on the meeting row itself.
      let saved = existing;
      if (Object.keys(values).length > 0) {
        const { data, error } = await request.db
          .from("meetings")
          .update(values)
          .eq("id", id)
          .select("*")
          .single();
        if (error) throw fromPostgrest(error);
        saved = data as Row;
      }

      // The row change is committed, so invitees hear about it even if the
      // attendee write then fails: the round runs on what actually persisted.
      let attendeeError: unknown = null;
      if (invitees) {
        try {
          await replaceAttendees(request, id, primary, invitees);
        } catch (err) {
          attendeeError = err;
        }
      }

      let invites: InviteRoundSummary = { status: "none" };
      if (patch.sendInvites && !ready) invites = INVITES_UNAVAILABLE;
      if (tracking) {
        const attendeesAfter = !invitees
          ? attendeesBefore
          : attendeeError
            ? await attendeeIds(request, before).catch(() => null)
            : [primary, ...invitees];
        if (attendeesAfter) {
          const prepared = await prepareInviteRound(request, {
            before,
            after: meetingState(saved),
            attendeesBefore,
            attendeesAfter,
            notify: patch.notifyAttendees ?? true,
          });
          invites = prepared.summary;
          startInviteDelivery(prepared.round, request.log);
        } else {
          invites = { status: "skipped", reason: "Couldn't read who is invited" };
        }
      }
      if (attendeeError) throw attendeeError;
      return { ...(await withAttendees(request, [saved]))[0], invites };
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

      // Who to tell is read while the meeting and its attendees still exist.
      const before = meetingState(existing);
      let prepared: Awaited<ReturnType<typeof prepareInviteRound>> | null = null;
      if (before.sendInvites && (await invitesReady(request.db))) {
        const attendees = await attendeeIds(request, before).catch(() => null);
        prepared = attendees
          ? await prepareInviteRound(request, { before, after: null, attendeesBefore: attendees, attendeesAfter: [], notify: true })
          : { summary: { status: "skipped", reason: "Couldn't read who is invited" }, round: null };
      }

      await dropCalendarEvent(request, existing);
      const { error } = await request.db.from("meetings").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      startInviteDelivery(prepared?.round ?? null, request.log);
      return { deleted: true, invites: prepared?.summary ?? ({ status: "none" } satisfies InviteRoundSummary) };
    }
  );

  /**
   * Who was emailed this meeting's calendar invite and how each send stands:
   * the newest attempt per address, from message_deliveries (RLS returns the
   * rows of students on the caller's caseload). Before 20261023090001 there
   * is no meeting link to read, so the list is empty.
   */
  app.get(
    "/:id/invites",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:invites", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const existing = await loadMeeting(request, id);
      await resolveStudentId(request, String(existing.student_id), "view");
      const { data, error } = await request.db
        .from("message_deliveries")
        .select("id, student_id, recipient_kind, to_email, template, status, channel, error, sent_at, delivered_at, created_at")
        .eq("meeting_id", id)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) {
        if (error.code === "42703" || error.code === "PGRST204") return [];
        throw fromPostgrest(error);
      }
      return latestInvitePerAddress((data ?? []) as Row[]);
    }
  );
}

/** The students invited to a meeting, primary first. A read error throws (who to tell is never guessed). */
async function attendeeIds(request: FastifyRequest, meeting: ReturnType<typeof meetingState>): Promise<string[]> {
  try {
    return await loadAttendeeIds(request.db, meeting);
  } catch (err) {
    throw fromPostgrest(err as { message: string; code?: string });
  }
}

/** Meetings a student is invited to without being the primary attendee. */
async function invitedMeetingIds(request: FastifyRequest, studentId: string): Promise<string[]> {
  const { data, error } = await request.db
    .from("meeting_attendees")
    .select("meeting_id")
    .eq("student_id", studentId)
    .limit(2000);
  if (error) throw fromPostgrest(error);
  return (data ?? []).map((r) => String((r as Row).meeting_id));
}

/**
 * The extra students on a booking, each one the counselor may edit. The
 * primary is dropped from the list: the database adds it on its own.
 */
async function checkAttendees(
  request: FastifyRequest,
  primary: string,
  ids: string[] | undefined
): Promise<string[]> {
  const extra = [...new Set(ids ?? [])].filter((id) => id !== primary);
  for (const id of extra) await resolveStudentId(request, id, "edit");
  return extra;
}

async function replaceAttendees(
  request: FastifyRequest,
  meetingId: string,
  primary: string,
  extra: string[]
): Promise<void> {
  const keep = [primary, ...extra];
  const { error: dErr } = await request.db
    .from("meeting_attendees")
    .delete()
    .eq("meeting_id", meetingId)
    .not("student_id", "in", `(${keep.join(",")})`);
  if (dErr) throw fromPostgrest(dErr);
  if (extra.length === 0) return;
  const { error } = await request.db
    .from("meeting_attendees")
    .upsert(
      extra.map((id) => ({ meeting_id: meetingId, student_id: id })),
      { onConflict: "meeting_id,student_id", ignoreDuplicates: true }
    );
  if (error) throw fromPostgrest(error);
}

/** Meetings with `attendeeIds`: the primary first, then everyone else invited. */
async function withAttendees(request: FastifyRequest, rows: Row[]) {
  const byMeeting = new Map<string, string[]>();
  if (rows.length > 0) {
    const { data, error } = await request.db
      .from("meeting_attendees")
      .select("meeting_id, student_id")
      .in("meeting_id", rows.map((r) => String(r.id)))
      .limit(5000);
    if (error) throw fromPostgrest(error);
    for (const a of (data ?? []) as Row[]) {
      const list = byMeeting.get(String(a.meeting_id)) ?? [];
      list.push(String(a.student_id));
      byMeeting.set(String(a.meeting_id), list);
    }
  }
  return rows.map((r) => {
    const primary = String(r.student_id);
    const others = (byMeeting.get(String(r.id)) ?? []).filter((id) => id !== primary);
    return { ...toMeeting(r), attendeeIds: [primary, ...others] };
  });
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
 *
 * Only the meeting's owner's event is ever deleted, with the caller's own
 * token (lib/meetingCalendar.ts). On someone else's meeting the event is left
 * alone and false comes back, so the pointer is kept for its owner.
 */
async function dropCalendarEvent(request: FastifyRequest, meeting: Row): Promise<boolean> {
  const access = calendarAccess(meeting, request.auth.userId);
  if (access.kind === "none") return false;
  if (access.kind === "not-owner") {
    request.log.warn({ provider: access.provider }, NOT_OWNER_SKIP);
    return false;
  }
  try {
    await deleteCalendarEvent(access.ownerId, access.provider, access.eventId, request.log);
  } catch (err) {
    request.log.warn(
      { provider: access.provider, err: err instanceof Error ? err.message : "unknown" },
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
  const nextMode = patch.mode ?? String(existing.mode);
  const cancelling = patch.status === "cancelled";
  const access = calendarAccess(existing, request.auth.userId);

  // Booking a calendar event puts it on the caller's calendar, so only the
  // meeting's owner may: anyone else's event would never be theirs to move.
  if (patch.createConference && !cancelling && !ownsMeeting(existing, request.auth.userId)) {
    throw forbidden(NOT_OWNER_CONFERENCE);
  }

  // Someone else's meeting: change it in Meridies, never their calendar, and
  // keep the pointer (only its owner may clear it).
  if (access.kind === "not-owner") {
    const touchesEvent =
      cancelling ||
      (patch.mode !== undefined && patch.mode !== existing.mode) ||
      patch.title !== undefined ||
      patch.startsAt !== undefined ||
      patch.endsAt !== undefined ||
      patch.agenda !== undefined;
    if (touchesEvent) request.log.warn({ provider: access.provider }, NOT_OWNER_SKIP);
    return;
  }

  const leavingConference = access.kind === "owner" && patch.mode !== undefined && patch.mode !== existing.mode;
  if (access.kind === "owner" && (cancelling || leavingConference)) {
    await dropCalendarEvent(request, existing);
    values.calendar_provider = null;
    values.calendar_event_id = null;
    if (leavingConference && patch.joinUrl === undefined) values.join_url = null;
    if (!patch.createConference) return;
  } else if (access.kind === "owner") {
    const change: Partial<CalendarEventInput> = {};
    if (patch.title !== undefined) change.title = patch.title;
    if (patch.startsAt !== undefined) change.startsAt = patch.startsAt;
    if (patch.endsAt) change.endsAt = patch.endsAt;
    if (patch.agenda !== undefined) change.description = patch.agenda;
    if (Object.keys(change).length > 0) {
      await updateCalendarEvent(access.ownerId, access.provider, access.eventId, change, request.log);
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
