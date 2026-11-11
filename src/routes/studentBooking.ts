/**
 * The signed-in student books time with their own counselor (20261111000001,
 * 20261111000012), under /me/booking. Student only; "me" is the JWT and the
 * counselor is the student's own `profiles.counselor_id` (lib/booking.ts
 * studentBookingContext), never a client id. That counselor must be approved
 * and have booking on; otherwise /types answers calmly why (`reason`: no
 * counselor and an unapproved one read the same, `counselor_unavailable`,
 * with nothing about the account; then `not_set_up`, `paused`, `no_types`)
 * and the other routes 404 `booking_not_available`.
 *
 *   GET    /me/booking/types                         the counselor's active meeting types, or why not
 *                                                     (lib/booking.ts bookingTypesAnswer), and their two change rules
 *   GET    /me/booking/slots?typeId&from&to[&tz]     free start times for one type
 *   POST   /me/booking         { typeId, startsAt }  book one of those starts
 *   PATCH  /me/booking/:id     { startsAt }          move one of my meetings
 *   DELETE /me/booking/:id                           cancel one of my meetings
 *
 * Slots are the counselor's weekly hours (in their zone) minus their scheduled
 * Meridies meetings and their connected calendar's busy time, each widened by
 * the buffer, after the minimum notice and within max days ahead; one request
 * covers at most 14 days. Only free times leave the server, never what makes a
 * time busy. `tz` is the student's zone, accepted for the app's convenience and
 * not used: times are instants, with the counselor's `timeZone` beside them.
 *
 * The writes and their rules are lib/bookingWrite.ts: a booking is accepted
 * only at a start the slots answer offers now; the meeting is reserved with
 * public.book_meeting_slot, put on the counselor's connected calendar with the
 * counselor's token (lib/bookingCalendar.ts, the one deliberate exception to
 * lib/meetingCalendar.ts's rule), invited by Meridies' own email
 * (lib/meetingInvites.ts, to the student and the counselor's copy only) and
 * the counselor is told (bell + email, first name, type and time only). A
 * student moves or cancels a scheduled meeting where they are the primary
 * student, with their own counselor, nobody else on it, outside the cutoff and
 * while the counselor lets students reschedule. A cancel works even while the
 * counselor has booking paused (`enabled` off); a move doesn't. All the service-role reads and
 * writes here are keyed by the caller's id and their own counselor's id.
 *
 * Before 20261111000001 everything answers 503 `booking_unavailable`; before
 * 20261111000012 only PATCH does.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { activeTypes, bookingUnavailable, slotsFor, studentBookingContext, studentBookingTypes, type StudentBookingContext } from "../lib/booking.js";
import {
  counselorCalendarConnected,
  createBookingPlainEvent,
  createBookingProviderEvent,
  moveBookingProviderEvent,
  removeBookingProviderEvent,
} from "../lib/bookingCalendar.js";
import {
  BOOKING_ACTIONS_PER_HOUR,
  BOOKING_NOTICES_PER_DAY,
  bookSlot,
  cancelBooking,
  rescheduleBooking,
  rpcError,
  slotOpen,
  type BookingIo,
} from "../lib/bookingWrite.js";
import { isTimeZone } from "../lib/calendarFeed.js";
import { brandedEmail, brandedText, sendEmail } from "../lib/email.js";
import { env } from "../env.js";
import { fromPostgrest, HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { consumeRateLimit, enforceRateLimit, limit } from "../lib/limits.js";
import {
  INVITES_UNAVAILABLE,
  invitesReady,
  loadAttendeeIds,
  meetingState,
  prepareInviteRound,
  startInviteDelivery,
} from "../lib/meetingInvites.js";
import { serializeErr } from "../lib/requestLog.js";
import { toMeeting } from "../lib/serialize.js";

type Row = Record<string, unknown>;
type Ctx = Extract<StudentBookingContext, { ok: true }>;

const slotsQuery = z
  .object({
    typeId: z.string().uuid(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    tz: z.string().trim().max(64).refine(isTimeZone, "That isn't a time zone").optional(),
  })
  .strict();

const bookBody = z.object({ typeId: z.string().uuid(), startsAt: z.string().datetime({ offset: true }) }).strict();
const moveBody = z.object({ startsAt: z.string().datetime({ offset: true }) }).strict();
const idParam = z.object({ id: z.string().uuid() });

const NOT_AVAILABLE_MESSAGE = {
  no_counselor: "You don't have a counselor to book with yet",
  not_available: "Your counselor isn't taking bookings right now",
} as const;

const RATE_MESSAGE = "Too many booking changes in an hour. Try again later.";

/** The gate every route shares: the student's own counselor, approved, with booking on; else 404. */
async function bookingContext(request: FastifyRequest, opts = { requireEnabled: true }): Promise<Ctx> {
  const ctx = await studentBookingContext(request, opts);
  if (!ctx.ok) throw new HttpError(404, NOT_AVAILABLE_MESSAGE[ctx.reason], "booking_not_available");
  return ctx;
}

/** One booking action of the caller's 20 an hour (DB-backed: it holds across replicas). */
const chargeAction = (request: FastifyRequest) =>
  enforceRateLimit(`booking-actions:${request.auth.userId}`, BOOKING_ACTIONS_PER_HOUR, 3600, RATE_MESSAGE);

const isMissingFunction = (e: { code?: string; message?: string }) =>
  e.code === "PGRST202" || e.code === "42883" || /Could not find the function/i.test(e.message ?? "");

/**
 * The real side effects of lib/bookingWrite.ts. Every service-role statement is
 * keyed by the caller's own id and their own counselor's id (`ctx`), never a
 * client id; a meeting id from the URL is only used after the meeting was read
 * and found to be the caller's.
 */
function bookingIo(request: FastifyRequest, ctx: Ctx): BookingIo {
  const svc = ctx.svc;
  const studentId = request.auth.userId;
  const parties = { counselorId: ctx.counselorId, studentId };
  const now = new Date();
  const log = request.log;

  return {
    now: () => now,
    slotOpen: (type, startsAt, ignore) => slotOpen(request, ctx, type, startsAt, now, ignore),
    async countFutureBookings() {
      const { count, error } = await svc
        .from("meetings")
        .select("id", { count: "exact", head: true })
        .eq("student_id", studentId)
        .eq("booked_by_student", true)
        .eq("status", "scheduled")
        .gt("starts_at", now.toISOString());
      if (error) throw fromPostgrest(error);
      return count ?? 0;
    },
    async reserve(a) {
      const { data, error } = await svc.rpc("book_meeting_slot", {
        p_student: studentId,
        p_counselor: ctx.counselorId,
        p_starts_at: a.startsAt,
        p_ends_at: a.endsAt,
        p_mode: a.mode,
        p_title: a.title,
        p_agenda: null,
      });
      if (error) throw rpcError(error) ?? fromPostgrest(error);
      return data as Row;
    },
    async move(a) {
      const { data, error } = await svc.rpc("reschedule_meeting_slot", {
        p_meeting: a.meetingId,
        p_student: studentId,
        p_counselor: ctx.counselorId,
        p_starts_at: a.startsAt,
        p_ends_at: a.endsAt,
      });
      if (error) {
        if (isMissingFunction(error)) throw bookingUnavailable();
        throw rpcError(error) ?? fromPostgrest(error);
      }
      return data as Row;
    },
    async release(meetingId) {
      const { error } = await svc
        .from("meetings")
        .delete()
        .eq("id", meetingId)
        .eq("student_id", studentId)
        .eq("counselor_id", ctx.counselorId)
        .eq("booked_by_student", true);
      if (error) log.error({ err: serializeErr(error), meetingId }, "booking: a failed reservation couldn't be released");
    },
    async restoreTimes(meetingId, startsAt, endsAt) {
      const { error } = await svc
        .from("meetings")
        .update({ starts_at: startsAt, ends_at: endsAt })
        .eq("id", meetingId)
        .eq("student_id", studentId)
        .eq("counselor_id", ctx.counselorId);
      if (error) log.error({ err: serializeErr(error), meetingId }, "booking: a failed move couldn't be put back");
    },
    async update(meetingId, values) {
      const { data, error } = await svc
        .from("meetings")
        .update(values)
        .eq("id", meetingId)
        .eq("student_id", studentId)
        .eq("counselor_id", ctx.counselorId)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return data as Row;
    },
    async claimCancel(meetingId) {
      // Conditional on still scheduled: of two cancels at once, one claims it and the other is already_cancelled.
      const { data, error } = await svc
        .from("meetings")
        .update({ status: "cancelled", calendar_provider: null, calendar_event_id: null })
        .eq("id", meetingId)
        .eq("student_id", studentId)
        .eq("counselor_id", ctx.counselorId)
        .eq("status", "scheduled")
        .select("*")
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      return (data as Row | null) ?? null;
    },
    calendar: {
      connected: (provider) => counselorCalendarConnected(svc, ctx.counselorId, provider),
      async create(meeting, provider, input) {
        try {
          return await createBookingProviderEvent(meeting, parties, provider, input, log);
        } catch (err) {
          log.warn({ provider, status: err instanceof HttpError ? err.statusCode : null, code: err instanceof HttpError ? err.code : null }, "booking: calendar event not created");
          throw err;
        }
      },
      async createPlain(meeting, provider, input) {
        try {
          return await createBookingPlainEvent(meeting, parties, provider, input, log);
        } catch (err) {
          log.warn({ provider, status: err instanceof HttpError ? err.statusCode : null, code: err instanceof HttpError ? err.code : null }, "booking: calendar event not created");
          throw err;
        }
      },
      async move(meeting, change) {
        try {
          await moveBookingProviderEvent(meeting, parties, change, log);
        } catch (err) {
          log.warn({ status: err instanceof HttpError ? err.statusCode : null, code: err instanceof HttpError ? err.code : null }, "booking: calendar event not moved");
          throw err;
        }
      },
      // removeBookingProviderEvent logs a failure itself (meeting, provider and event ids).
      remove: (meeting) => removeBookingProviderEvent(meeting, parties, log),
    },
    invitesReady: () => invitesReady(svc),
    async invites(kind, before, after) {
      if (!(await invitesReady(svc))) return kind === "booked" ? INVITES_UNAVAILABLE : { status: "none" };
      // Only the booked student and the counselor's own copy: the change routes refuse a meeting with anyone else on it.
      const prepared = await prepareInviteRound(
        { db: svc, log },
        {
          before: before ? meetingState(before) : null,
          after: meetingState(after),
          attendeesBefore: before ? [studentId] : [],
          attendeesAfter: [studentId],
          notify: true,
        },
        // A student's rounds spend their own bucket, never the counselor's own invite allowance.
        { consume: consumeRateLimit, now: new Date(), bucket: "booking" }
      );
      startInviteDelivery(prepared.round, log);
      return prepared.summary;
    },
    async notify(n) {
      try {
        if (!(await consumeRateLimit(`booking-notice:${studentId}`, BOOKING_NOTICES_PER_DAY, 86_400, log))) {
          log.info({ action: n.action }, "booking: counselor notice throttled");
          return;
        }
        const href = `/dashboard/counselor/students/${studentId}`;
        const { error } = await svc.from("notifications").insert({
          recipient_id: ctx.counselorId,
          student_id: studentId,
          kind: "system",
          urgency: "normal",
          title: n.title,
          body: n.body,
          href,
          action_items: [],
          created_by: studentId,
        });
        if (error) log.error({ err: serializeErr(error) }, "booking: counselor notification not saved");
        const { data: counselor } = await svc.from("profiles").select("email").eq("id", ctx.counselorId).maybeSingle();
        const to = ((counselor as Row | null)?.email as string | null) ?? null;
        if (!to) return;
        const template = { heading: n.title, paragraphs: [n.body], cta: { label: "Open the student's page", url: `${env.APP_URL.replace(/\/+$/, "")}${href}` } };
        await sendEmail({
          to,
          subject: n.title.slice(0, 150),
          html: brandedEmail(template),
          text: brandedText(template),
          template: "student-booking-counselor",
          student_id: studentId,
          recipient_id: ctx.counselorId,
          recipient_kind: "counselor",
          logger: log,
        });
      } catch (err) {
        log.error({ err: serializeErr(err) }, "booking: counselor notice failed");
      }
    },
  };
}

/** The caller's meeting by id, with who is on it; 404 when it isn't theirs as the primary student. */
async function myMeeting(ctx: Ctx, studentId: string, id: string): Promise<{ meeting: Row; attendees: string[] }> {
  const { data, error } = await ctx.svc.from("meetings").select("*").eq("id", id).maybeSingle();
  if (error) throw fromPostgrest(error);
  const meeting = data as Row | null;
  if (!meeting || meeting.student_id !== studentId) throw new HttpError(404, "That meeting doesn't exist", "meeting_not_found");
  try {
    return { meeting, attendees: await loadAttendeeIds(ctx.svc, { id, primaryStudentId: studentId }) };
  } catch (err) {
    throw fromPostgrest(err as { code?: string; message?: string });
  }
}

const dto = (meeting: Row, studentId: string) => ({ ...toMeeting(meeting), attendeeIds: [studentId] });

export default async function studentBookingRoutes(app: FastifyInstance) {
  const student = [app.authenticate, requireRole("student")];

  app.get(
    "/types",
    { preHandler: [...student, limit("me:booking:types", 60, 60)] },
    async (request) => studentBookingTypes(request)
  );

  app.get(
    "/slots",
    { preHandler: [...student, limit("me:booking:slots", 60, 60)] },
    async (request) => {
      const q = slotsQuery.parse(request.query);
      if (Date.parse(q.to) <= Date.parse(q.from)) throw new HttpError(400, "The end has to be after the start");
      const ctx = await bookingContext(request);
      const type = (await activeTypes(ctx.svc, ctx.counselorId)).find((t) => t.id === q.typeId);
      if (!type) throw new HttpError(404, "That meeting type isn't available", "type_not_found");
      return slotsFor(request, ctx, type, { from: q.from, to: q.to });
    }
  );

  app.post(
    "/",
    { preHandler: [...student, limit("me:booking:write", 60, 60)] },
    async (request, reply) => {
      const body = bookBody.parse(request.body);
      await chargeAction(request);
      const ctx = await bookingContext(request);
      const type = (await activeTypes(ctx.svc, ctx.counselorId)).find((t) => t.id === body.typeId);
      if (!type) throw new HttpError(404, "That meeting type isn't available", "type_not_found");
      const out = await bookSlot(bookingIo(request, ctx), {
        studentId: request.auth.userId,
        studentName: request.profile.full_name ?? null,
        counselorId: ctx.counselorId,
        settings: ctx.settings,
        type,
        startsAt: body.startsAt,
      });
      const m = dto(out.meeting, request.auth.userId);
      return reply.code(201).send({
        ...m,
        joinUrl: out.joinUrl,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        mode: m.mode,
        typeName: type.name,
        conference: out.conference,
        calendar: out.calendar,
        invites: out.invites,
      });
    }
  );

  app.patch(
    "/:id",
    { preHandler: [...student, limit("me:booking:write", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = moveBody.parse(request.body);
      await chargeAction(request);
      const ctx = await bookingContext(request);
      const { meeting, attendees } = await myMeeting(ctx, request.auth.userId, id);
      const out = await rescheduleBooking(bookingIo(request, ctx), {
        studentId: request.auth.userId,
        studentName: request.profile.full_name ?? null,
        counselorId: ctx.counselorId,
        settings: ctx.settings,
        meeting,
        attendees,
        startsAt: body.startsAt,
      });
      return { ...dto(out.meeting, request.auth.userId), calendarUpdated: out.calendarUpdated, invites: out.invites };
    }
  );

  app.delete(
    "/:id",
    { preHandler: [...student, limit("me:booking:write", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await chargeAction(request);
      // A cancel works while booking is paused (enabled off): only approval and set-up are required.
      const ctx = await bookingContext(request, { requireEnabled: false });
      const { meeting, attendees } = await myMeeting(ctx, request.auth.userId, id);
      const out = await cancelBooking(bookingIo(request, ctx), {
        studentId: request.auth.userId,
        studentName: request.profile.full_name ?? null,
        counselorId: ctx.counselorId,
        settings: ctx.settings,
        meeting,
        attendees,
      });
      return { ...dto(out.meeting, request.auth.userId), calendarRemoved: out.calendarRemoved, invites: out.invites };
    }
  );
}
