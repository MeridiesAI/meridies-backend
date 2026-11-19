/**
 * Scheduled meetings.
 *
 * `meeting_notes` records what was said; this records that a session was going
 * to happen at all, which is what the calendar and the "next meetings" card
 * read. Modes are Google Meet, Microsoft Teams, Zoom, in person and phone (Zoom was
 * dropped in the v5 brief and brought back on purpose, 11/18).
 *
 * `createConference: true` books the session on the counselor's own Google or
 * Outlook calendar with a real Meet / Teams link, or creates a Zoom meeting on their
 * connected Zoom account (lib/suiteApi.ts), and the
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
 * These routes are the counselor's: a student reads their own meetings here
 * and never writes through them. Since student booking part 2 a student moves
 * or cancels a meeting only through /me/booking (routes/studentBooking.ts,
 * lib/bookingWrite.ts): one where they are the primary student, with their own
 * counselor and nobody else on it, outside the counselor's cancel cutoff and
 * while the counselor lets students reschedule. An invited (non-primary)
 * student still can't move anything.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { expandSeriesDates, MAX_SERIES, MAX_SERIES_WITH_LINKS, shiftInstant, wallDelta, zonedInstant } from "../lib/recurrence.js";
import { seriesReady } from "../lib/seriesSchema.js";
import { prepareSeriesInviteRound, startSeriesDelivery } from "../lib/seriesInvites.js";
import { badRequest, forbidden, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
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
  type MeetingState,
} from "../lib/meetingInvites.js";
import {
  calendarAccess,
  NOT_OWNER_CONFERENCE,
  NOT_OWNER_SKIP,
  ownsMeeting,
} from "../lib/meetingCalendar.js";
import { connectedAccountEmail, type ConnectProvider } from "../lib/oauth.js";
import { meetingHtmlLink, needsGoogleAddress } from "../lib/calendarLink.js";
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
    mode: z.enum(["google-meet", "teams", "zoom", "in-person", "phone"]).optional(),
    location: z.string().trim().max(300).nullable().optional(),
    // The Join link a student opens: http(s) only, as the AxIS catalog already requires.
    joinUrl: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) link").nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable().optional(),
    agenda: z.string().trim().max(4000).nullable().optional(),
    guardiansInvited: z.boolean().optional(),
    deadlineId: z.string().uuid().nullable().optional(),
    /** Create the event with a Meet/Teams link on the connected calendar, or the Zoom meeting on the connected Zoom account. */
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

/** Which connected account hosts a conference mode. */
function conferenceProvider(mode: string): ConnectProvider {
  if (mode === "google-meet") return "google";
  if (mode === "teams") return "microsoft";
  if (mode === "zoom") return "zoom";
  throw badRequest("Only Google Meet, Teams and Zoom meetings get a link made for them");
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
export const repeatBody = z
  .object({
    preset: z.enum(["daily", "weekdays", "weekly", "biweekly", "monthly"]),
    count: z.number().int().min(2).max(52).optional(),
    until: isoDate.optional(),
  })
  .strict()
  .refine((r) => (r.count === undefined) !== (r.until === undefined), "Give a count or an end date");
const realTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** One meeting's fields plus when it repeats: a local date and wall-clock time in an IANA zone. */
const seriesMeetingBody = meetingBody
  .omit({ startsAt: true, endsAt: true })
  .extend({
    date: isoDate,
    startMinutes: z.number().int().min(0).max(1439),
    durationMins: z.number().int().min(15).max(1440),
    timeZone: z.string().min(1).max(64).refine(realTimeZone, "That isn't a time zone we know"),
    repeat: repeatBody,
  })
  .strict();
export const SERIES_UNAVAILABLE = () => new HttpError(503, "Repeating events aren't switched on yet.", "series_unavailable");
/** The scoped series routes reach the round through this, so a test can see each call (the `__busy` pattern). */
export const __seriesInvites = { prepare: prepareSeriesInviteRound, start: startSeriesDelivery };

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

const seriesParam = z.object({ seriesId: z.string().uuid() });
const seriesTimeZone = z.string().min(1).max(64).refine(realTimeZone, "That isn't a time zone we know");
const seriesScopeName = z.enum(["following", "all"]);
/** A scoped series patch: no status, mode, link, attendees or invite switch (each is a per-meeting change). */
const seriesPatchBody = z
  .object({
    anchorId: z.string().uuid(),
    scope: seriesScopeName,
    timeZone: seriesTimeZone,
    notifyAttendees: z.boolean().optional(),
    patch: meetingBody.pick({ title: true, agenda: true, location: true, guardiansInvited: true, startsAt: true, endsAt: true }).partial().strict(),
  })
  .strict();
const seriesDeleteQuery = z.object({ anchorId: z.string().uuid(), scope: seriesScopeName, timeZone: seriesTimeZone.optional() }).strict();

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

      let calendar: { provider: ConnectProvider; eventId: string; joinUrl: string } | null = null;
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

  /**
   * A repeating series: every occurrence at the same local wall-clock time in `timeZone` (across a DST change),
   * one shared `series_id`, ONE insert. All or nothing: provider events are made first, one at a time, and any
   * failure after one exists deletes every event and row already made. One invite round for the whole series, only
   * once everything is saved.
   */
  app.post(
    "/series",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:series", 20, 60)] },
    async (request, reply) => {
      if (!(await seriesReady(request.db))) throw SERIES_UNAVAILABLE();
      const body = seriesMeetingBody.parse(request.body);
      const student = await resolveStudentId(request, body.studentId, "edit");
      const mode = body.mode ?? "google-meet";
      const provider = body.createConference ? conferenceProvider(mode) : null;
      const { preset, count, until } = body.repeat;
      let dates: string[];
      try {
        const end = count !== undefined ? { count } : { until: until! };
        dates = expandSeriesDates(body.date, { preset, end }, provider ? MAX_SERIES_WITH_LINKS : MAX_SERIES);
      } catch (err) {
        if (err instanceof RangeError) throw badRequest(err.message);
        throw err;
      }
      // The end is start + duration (not a second wall-clock read), so a meeting over a DST change keeps its length.
      const times = dates.map((d) => {
        const startsAt = zonedInstant(d, body.startMinutes, body.timeZone);
        return { startsAt, endsAt: new Date(Date.parse(startsAt) + body.durationMins * 60_000).toISOString() };
      });
      const invitees = await checkAttendees(request, student, body.attendeeIds);
      const ready = await invitesReady(request.db);
      const endError = inviteEndError(ready, body.sendInvites === true, times[0]!.endsAt);
      if (endError) throw badRequest(endError);

      const seriesId = randomUUID();
      const created: { provider: ConnectProvider; eventId: string; joinUrl: string }[] = [];
      let inserted = false;
      let saved: Row[];
      try {
        if (provider) {
          for (const t of times) {
            const event = await createConferenceEvent(
              request.auth.userId,
              provider,
              { title: body.title, startsAt: t.startsAt, endsAt: t.endsAt, description: body.agenda ?? null },
              request.log
            );
            created.push({ provider, ...event });
          }
        }
        const { data, error } = await request.db
          .from("meetings")
          .insert(
            times.map((t, i) => ({
              student_id: student,
              counselor_id: request.auth.userId,
              title: body.title,
              mode,
              location: body.location ?? null,
              join_url: created[i]?.joinUrl ?? body.joinUrl ?? null,
              calendar_provider: created[i]?.provider ?? null,
              calendar_event_id: created[i]?.eventId ?? null,
              starts_at: t.startsAt,
              ends_at: t.endsAt,
              agenda: body.agenda ?? null,
              guardians_invited: body.guardiansInvited ?? false,
              deadline_id: body.deadlineId ?? null,
              created_by: request.auth.userId,
              series_id: seriesId,
              ...inviteColumns(ready, body.sendInvites),
            }))
          )
          .select("*");
        if (error) throw fromPostgrest(error);
        inserted = true;
        saved = (data ?? []) as Row[];
        if (invitees.length > 0) {
          const { error: aErr } = await request.db.from("meeting_attendees").upsert(
            saved.flatMap((m) => invitees.map((id) => ({ meeting_id: m.id, student_id: id }))),
            { onConflict: "meeting_id,student_id", ignoreDuplicates: true }
          );
          if (aErr) throw fromPostgrest(aErr);
        }
      } catch (err) {
        // Best effort, as the single path: the original error is what the counselor hears.
        for (const c of created) {
          await deleteCalendarEvent(request.auth.userId, c.provider, c.eventId, request.log).catch(() => undefined);
        }
        if (inserted) {
          const { error } = await request.db.from("meetings").delete().eq("series_id", seriesId);
          if (error) request.log.error({ seriesId, code: error.code }, "series rollback: rows not deleted");
        }
        throw err;
      }

      let invites: InviteRoundSummary = { status: "none" };
      if (body.sendInvites && !ready) invites = INVITES_UNAVAILABLE;
      else if (body.sendInvites) {
        const prepared = await prepareSeriesInviteRound(request, {
          kind: "create",
          before: [],
          after: saved.map(meetingState),
          attendeeIds: [student, ...invitees],
          notify: true,
        });
        invites = prepared.summary;
        startSeriesDelivery(prepared.round, request.log);
      }
      return reply.code(201).send({ seriesId, meetings: await withAttendees(request, saved), invites });
    }
  );

  /**
   * A change to part of a repeating series: the anchor and every later occurrence (`following`) or every upcoming one
   * (`all`). See `seriesScope` for which rows. Per row and not atomic: each row is its own applyMeetingPatch
   * ("defer"), a row that fails (a provider refusal, a write error) is left as it was and listed in `failed`, and the
   * answer is still 200. A move shifts each row by the anchor's wall-clock change in `timeZone` (an occurrence moved
   * by hand keeps its own offset); an end sets every row to the same length; other fields are copied. ONE invite
   * round for the rows that changed, one charge.
   */
  app.patch(
    "/series/:seriesId",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:series-update", 60, 60)] },
    async (request) => {
      if (!(await seriesReady(request.db))) throw SERIES_UNAVAILABLE();
      const { seriesId } = seriesParam.parse(request.params);
      const body = seriesPatchBody.parse(request.body);
      const { anchor, affected, skipped } = await seriesScope(request, seriesId, body.anchorId, body.scope);
      const { startsAt, endsAt, ...copied } = body.patch;
      const tz = body.timeZone;
      const delta = startsAt !== undefined ? wallDelta(String(anchor.starts_at), startsAt, tz) : null;
      // undefined: each row keeps its own length; null: no end on any row.
      let duration: number | null | undefined;
      if (endsAt === null) duration = null;
      else if (endsAt !== undefined) {
        duration = Date.parse(endsAt) - Date.parse(startsAt ?? String(anchor.starts_at));
        if (!(duration > 0)) throw badRequest("The end has to be after the start");
      }

      const notify = body.notifyAttendees !== false;
      const ready = await invitesReady(request.db);
      // Who holds the invite, read once before anything moves: a scoped patch can't change attendees, so it is the
      // same for every row of the series.
      const attendees =
        notify && ready && affected.some((r) => r.send_invites === true)
          ? await attendeeIds(request, meetingState(affected[0]!)).catch(() => null)
          : [];

      const before: MeetingState[] = [];
      const after: MeetingState[] = [];
      const failed: SeriesFailure[] = [];
      for (const row of affected) {
        const rowPatch: MeetingPatch = { ...copied, notifyAttendees: false };
        if (delta) rowPatch.startsAt = shiftInstant(String(row.starts_at), delta, tz);
        const start = Date.parse(rowPatch.startsAt ?? String(row.starts_at));
        if (duration === null) rowPatch.endsAt = null;
        else if (duration !== undefined) rowPatch.endsAt = new Date(start + duration).toISOString();
        else if (delta && row.ends_at) {
          rowPatch.endsAt = new Date(start + Date.parse(String(row.ends_at)) - Date.parse(String(row.starts_at))).toISOString();
        }
        try {
          await resolveStudentId(request, String(row.student_id), "edit");
          // Known hazard (as PATCH /meetings/:id): if the provider move succeeds and the row update then fails, the
          // provider event stays moved while the row keeps its old time; the row is reported failed.
          const done = await applyMeetingPatch(request, row, rowPatch, { invites: "defer" });
          before.push(done.before);
          after.push(done.after);
        } catch (err) {
          failed.push(seriesFailure(row, err, tz, "Couldn't change this meeting. Try again."));
        }
      }

      const invites = notify && ready ? await seriesRound(request, "update", before, after, attendees) : NO_INVITES;
      return { updated: after.length, skipped, failed, invites };
    }
  );

  /** Delete part of a repeating series (the same rows as the PATCH), per row; ONE cancel round, never charged. */
  app.delete(
    "/series/:seriesId",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:series-delete", 60, 60)] },
    async (request) => {
      if (!(await seriesReady(request.db))) throw SERIES_UNAVAILABLE();
      const { seriesId } = seriesParam.parse(request.params);
      const q = seriesDeleteQuery.parse(request.query);
      const { affected, skipped } = await seriesScope(request, seriesId, q.anchorId, q.scope);
      const ready = await invitesReady(request.db);
      // Read while the meetings and their attendees still exist.
      const attendees =
        ready && affected.some((r) => r.send_invites === true)
          ? await attendeeIds(request, meetingState(affected[0]!)).catch(() => null)
          : [];

      const gone: MeetingState[] = [];
      const failed: SeriesFailure[] = [];
      for (const row of affected) {
        try {
          await resolveStudentId(request, String(row.student_id), "edit");
          const state = meetingState(row);
          // As DELETE /meetings/:id: the event goes first, best effort. If the row delete then fails the event is
          // already gone and the row stays; it is reported failed.
          await dropCalendarEvent(request, row);
          const { error } = await request.db.from("meetings").delete().eq("id", String(row.id));
          if (error) throw fromPostgrest(error);
          gone.push(state);
        } catch (err) {
          failed.push(seriesFailure(row, err, q.timeZone ?? "UTC", "Couldn't delete this meeting. Try again."));
        }
      }

      const invites = ready ? await seriesRound(request, "cancel", gone, [], attendees) : NO_INVITES;
      return { deleted: gone.length, skipped, failed, invites };
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

      const { saved, invites } = await applyMeetingPatch(request, existing, patch, { invites: "inline" });
      return { ...(await withAttendees(request, [saved]))[0], invites };
    }
  );

  /**
   * "Notes sent": a record-only mark that the counselor sent the meeting's notes
   * (Meridies sends nothing). It is what counts the meeting in Time saved; clearing
   * it undoes that until the month's report is finalized. Owner only, held meetings.
   */
  const notesSent = (sent: boolean) => async (request: FastifyRequest) => {
    const { id } = idParam.parse(request.params);
    const existing = await loadMeeting(request, id);
    if (existing.counselor_id !== request.auth.userId) throw forbidden("Only the meeting's owner can mark its notes sent");
    if (sent && existing.status !== "held") throw new HttpError(409, "Mark the meeting held first", "meeting_not_held");
    const { data, error } = await request.db
      .from("meetings")
      .update({ notes_sent_at: sent ? new Date().toISOString() : null })
      .eq("id", id)
      .select("id, notes_sent_at")
      .single();
    if (error) {
      // Before the Time saved migration there is no column to mark.
      if (["42703", "PGRST204"].includes(error.code ?? "")) throw new HttpError(503, "Time saved isn't switched on yet", "kpi_unavailable");
      throw fromPostgrest(error);
    }
    return { id: String(data.id), notesSentAt: (data.notes_sent_at as string | null) ?? null };
  };
  const notesSentPre = { preHandler: [app.authenticate, requireRole("counselor"), limit("meetings:notes-sent", 60, 60)] };
  app.post("/:id/notes-sent", notesSentPre, notesSent(true));
  app.delete("/:id/notes-sent", notesSentPre, notesSent(false));

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

/**
 * The rows a scoped series change acts on. The anchor must be in the series (else 404) and its student editable
 * (else 403). The window is the series' rows of the anchor's student starting at or after the anchor (`following`)
 * or after now (`all`). Of those, scheduled rows that haven't started are `affected`; every other row in the window
 * (held, no-show, cancelled, or a `following` row already past) is counted in `skipped` and never touched. Past rows
 * before the window aren't counted.
 */
async function seriesScope(request: FastifyRequest, seriesId: string, anchorId: string, scope: "following" | "all") {
  const anchor = await loadMeeting(request, anchorId);
  if (anchor.series_id !== seriesId) throw notFound("That meeting isn't part of this repeating series");
  await resolveStudentId(request, String(anchor.student_id), "edit");
  const now = Date.now();
  const base = request.db.from("meetings").select("*").eq("series_id", seriesId).eq("student_id", String(anchor.student_id));
  const { data, error } = await (scope === "following"
    ? base.gte("starts_at", String(anchor.starts_at))
    : base.gt("starts_at", new Date(now).toISOString())
  )
    .order("starts_at", { ascending: true })
    .limit(500);
  if (error) throw fromPostgrest(error);
  const window = (data ?? []) as Row[];
  const affected = window.filter((r) => r.status === "scheduled" && Date.parse(String(r.starts_at)) > now);
  return { anchor, affected, skipped: window.length - affected.length };
}

type SeriesFailure = { id: string; date: string; message: string };

/** A row the scoped change couldn't make: its local date and the reason in words (a bare database error isn't). */
function seriesFailure(row: Row, err: unknown, timeZone: string, fallback: string): SeriesFailure {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(String(row.starts_at))
  );
  const message = err instanceof HttpError && err.statusCode !== 500 ? err.message : fallback;
  return { id: String(row.id), date, message };
}

const NO_INVITES: InviteRoundSummary = { status: "none" };

/** ONE round for a scoped series change, when any row held invites. `attendees` null: they couldn't be read. */
async function seriesRound(
  request: FastifyRequest,
  kind: "update" | "cancel",
  before: MeetingState[],
  after: MeetingState[],
  attendees: string[] | null
): Promise<InviteRoundSummary> {
  if (!before.some((b) => b.sendInvites)) return NO_INVITES;
  if (!attendees) return { status: "skipped", reason: "Couldn't read who is invited" };
  const prepared = await __seriesInvites.prepare(request, { kind, before, after, attendeeIds: attendees, notify: true });
  __seriesInvites.start(prepared.round, request.log);
  return prepared.summary;
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

/** Meetings with `attendeeIds` (the primary first, then everyone else invited) and `htmlLink`. */
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
  // The Google event's own page, for the meeting's owner only (lib/calendarLink.ts). A read that can't find the
  // connected address just leaves the link out: the app then opens that day instead.
  const viewer = request.auth.userId;
  const googleAddress = needsGoogleAddress(rows, viewer)
    ? await connectedAccountEmail(viewer, "google").catch(() => null)
    : null;
  return rows.map((r) => {
    const primary = String(r.student_id);
    const others = (byMeeting.get(String(r.id)) ?? []).filter((id) => id !== primary);
    return { ...toMeeting(r), attendeeIds: [primary, ...others], htmlLink: meetingHtmlLink(r, viewer, googleAddress) };
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
 * One change to one stored meeting: the attendee and note checks, the calendar event, the row, the attendees and the
 * invite round. PATCH /meetings/:id calls it with "inline"; the series route calls it once per row with "defer".
 *
 * The caller has parsed `patch`, loaded `existing` (loadMeeting) and shown the caller may edit its student
 * (`resolveStudentId(request, primary, "edit")`): this does not repeat that, and a caller must not skip it. Every other
 * check and write is here, in the order the route always ran them.
 *
 * invites "inline": the round is prepared and handed to delivery, and `invites` says who is being emailed (what the
 * route answers). "defer": nothing is read for, prepared or sent as a round and `invites` is none; the caller sends one
 * round for the whole batch from `before` and `after`. "defer" is for a patch without `attendeeIds`: a failed attendee
 * write throws after the row is saved, so the caller would get no `before`/`after` for it.
 */
async function applyMeetingPatch(
  request: FastifyRequest,
  existing: Row,
  patch: MeetingPatch,
  opts: { invites: "inline" | "defer" }
): Promise<{ saved: Row; before: MeetingState; after: MeetingState; invites: InviteRoundSummary }> {
  const id = String(existing.id);
  const primary = String(existing.student_id);
  const invitees =
    patch.attendeeIds === undefined
      ? null
      : await checkAttendees(request, primary, patch.attendeeIds);

  // A meeting links only a note written about the same student (RLS already
  // hides other counselors' notes, so a foreign id reads as missing).
  if (patch.meetingNoteId) {
    const { data: note, error: noteError } = await request.db
      .from("meeting_notes")
      .select("student_id")
      .eq("id", patch.meetingNoteId)
      .maybeSingle();
    if (noteError) throw fromPostgrest(noteError);
    if (!note || String((note as Row).student_id) !== primary) {
      throw badRequest("That note isn't about this student");
    }
  }

  const ready = await invitesReady(request.db);
  const before = meetingState(existing);
  const endError = inviteEndError(
    ready,
    patch.sendInvites ?? before.sendInvites,
    patch.endsAt !== undefined ? patch.endsAt : before.endsAt
  );
  if (endError) throw badRequest(endError);
  // Who held the invite before this change, read before anything moves. A deferred round is the caller's: none here.
  const inline = opts.invites === "inline";
  const tracking = inline && ready && (before.sendInvites || patch.sendInvites === true);
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

  const after = meetingState(saved);
  let invites: InviteRoundSummary = { status: "none" };
  if (inline && patch.sendInvites && !ready) invites = INVITES_UNAVAILABLE;
  if (tracking) {
    const attendeesAfter = !invitees
      ? attendeesBefore
      : attendeeError
        ? await attendeeIds(request, before).catch(() => null)
        : [primary, ...invitees];
    if (attendeesAfter) {
      const prepared = await prepareInviteRound(request, {
        before,
        after,
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
  return { saved, before, after, invites };
}

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
    if (access.provider === "zoom" && (change.startsAt || change.endsAt)) {
      // Zoom takes a start and a length, never one alone: an end alone keeps the stored start, a start alone keeps the
      // stored length (not the stored end, which would be before the new start).
      const oldStart = existing.starts_at as string;
      const oldEnd = (existing.ends_at as string | null) ?? null;
      change.startsAt ??= oldStart;
      change.endsAt ??= oldEnd ? new Date(Date.parse(change.startsAt) + (Date.parse(oldEnd) - Date.parse(oldStart))).toISOString() : undefined;
    }
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
