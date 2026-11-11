/**
 * A counselor's student-booking setup (20261111000001), under /booking.
 * Counselor only (and, through `authenticate`, approved only); every query
 * runs on the caller's own client and the tables are owner-only, so a
 * counselor reads and writes their own rows and nobody else's.
 *
 *   GET    /booking/settings        hours, zone, notice, buffer, cutoff, switches (defaults when never saved)
 *   PUT    /booking/settings        save any of them (weekly hours checked in full, zone must be IANA), and the
 *                                    Google Calendar booking page link (`bookingPageUrl`, `bookingPageMode`:
 *                                    lib/bookingPage.ts; 503 `booking_page_unavailable` before its migration)
 *                                    Both also carry the public booking link (20261121000001, once applied):
 *                                    `publicSlug` (made on the first read of a row without one) and
 *                                    `publicBookingEnabled`, which PUT accepts (503 `public_booking_unavailable`
 *                                    before the migration; GET then leaves both fields out)
 *   POST   /booking/public-link/rotate  a new link (new suffix): { publicSlug }; the old one stops working
 *   GET    /booking/types           the counselor's meeting types, active or not
 *   POST   /booking/types           add one (name, 15-180 minutes, google-meet | teams | in-person | phone)
 *   PATCH  /booking/types/:id
 *   DELETE /booking/types/:id
 *   GET    /booking/public/:id      one of the caller's public-link bookings (lib/publicBookingCancel.ts)
 *   POST   /booking/public/:id/cancel  cancel it: status, the calendar event, the booker's CANCEL email, the
 *                                    pipeline timeline; 404 `booking_not_found`, 409 `already_cancelled`,
 *                                    503 `public_booking_unavailable` before 20261121000001
 *
 * Before the migration every route answers 503 `booking_unavailable`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  BOOKING_MODES,
  requireBookingReady,
  settingsColumns,
  toMeetingType,
  toSettings,
  TYPE_COLUMNS,
} from "../lib/booking.js";
import { parseWeeklyHours } from "../lib/bookingSlots.js";
import { BOOKING_PAGE_MODES, bookingPageReady, bookingPageUnavailable, parseBookingPageUrl } from "../lib/bookingPage.js";
import { isTimeZone } from "../lib/calendarFeed.js";
import { badRequest, conflict, fromPostgrest, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { sendEmail } from "../lib/email.js";
import { fromAddress, validEmail } from "../lib/meetingInvites.js";
import { isPublicSlug, publicCounselor, writeSlug } from "../lib/publicBooking.js";
import {
  bookerCancelEmail,
  bookingNotFound,
  cancelActivityText,
  cancelPublicBooking,
  publicBookingCancelIcs,
  toPublicBooking,
  type PublicCancelIo,
} from "../lib/publicBookingCancel.js";
import { PUBLIC_BOOKING_COLUMNS, publicBookingReady, publicBookingUnavailable } from "../lib/publicBookingStore.js";
import { serializeErr } from "../lib/requestLog.js";
import { deleteCalendarEvent } from "../lib/suiteApi.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });

const settingsBody = z
  .object({
    enabled: z.boolean(),
    timeZone: z.string().trim().min(1).max(64).refine(isTimeZone, "Use an IANA time zone, e.g. America/New_York"),
    weeklyHours: z.unknown(),
    minNoticeHours: z.number().int().min(0).max(720),
    maxDaysAhead: z.number().int().min(1).max(365),
    bufferMinutes: z.number().int().min(0).max(240),
    cancelCutoffHours: z.number().int().min(0).max(720),
    studentsCanReschedule: z.boolean(),
    /** The counselor's Google Calendar booking page (lib/bookingPage.ts); null or "" removes it. */
    bookingPageUrl: z.string().max(2000).nullable(),
    bookingPageMode: z.enum(BOOKING_PAGE_MODES),
    /** The public booking link (lib/publicBooking.ts); 503 `public_booking_unavailable` before its migration. */
    publicBookingEnabled: z.boolean(),
  })
  .partial()
  .strict();

const typeBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    durationMinutes: z.number().int().min(15).max(180),
    mode: z.enum(BOOKING_MODES),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const DUPLICATE_TYPE = "You already have a meeting type with that name";

/** The counselor's booking zone, for the dates in the email and the timeline (UTC when never saved). */
async function bookingZone(request: FastifyRequest): Promise<string> {
  const { data } = await request.db.from("booking_settings").select("time_zone").eq("counselor_id", request.auth.userId).maybeSingle();
  const tz = (data as Row | null)?.time_zone;
  return typeof tz === "string" && isTimeZone(tz) ? tz : "UTC";
}

/**
 * After a public booking is cancelled (never fails the answer): the booker's email with an .ics CANCEL for their
 * invite, and the pipeline timeline entry when the booking has a contact (the caller's own session: the
 * activity insert grant and the guard pin the workspace and actor).
 */
function afterPublicCancel(request: FastifyRequest, booking: Row): void {
  const log = request.log;
  const id = String(booking.id);
  const counselorId = request.auth.userId;
  void (async () => {
    const tz = await bookingZone(request).catch(() => "UTC");
    if (typeof booking.contact_id === "string" && booking.contact_id) {
      try {
        const { error } = await request.db.from("pipeline_activities").insert({
          contact_id: booking.contact_id,
          kind: "meeting",
          body: cancelActivityText(String(booking.type_name), String(booking.starts_at), tz),
        });
        if (error) log.warn({ err: serializeErr(error), bookingId: id }, "public booking cancel: timeline entry not recorded");
      } catch (err) {
        log.warn({ err: serializeErr(err), bookingId: id }, "public booking cancel: timeline entry not recorded");
      }
    }

    const svc = serviceClient();
    const me = svc
      ? await publicCounselor(svc, counselorId).catch(() => null)
      : { name: request.profile.full_name ?? "Your counselor", email: (request.profile.email as string | null | undefined) ?? null };
    const organizerEmail = validEmail(me?.email ?? request.profile.email);
    const bookerAddress = validEmail(booking.email);
    if (!organizerEmail || !bookerAddress) {
      log.warn({ bookingId: id }, "public booking cancel: no address to email the booker from or to");
      return;
    }
    const name = me?.name || request.profile.full_name || "Your counselor";
    try {
      const ics = publicBookingCancelIcs(booking, { name, email: organizerEmail }, { name: String(booking.name), email: bookerAddress }, fromAddress());
      await sendEmail({
        to: bookerAddress,
        ...bookerCancelEmail(booking, name, tz),
        template: "public-booking-cancellation",
        attachments: [{ filename: "cancel.ics", content: Buffer.from(ics, "utf8").toString("base64"), contentType: "text/calendar; charset=utf-8; method=CANCEL" }],
        replyTo: organizerEmail,
        fromName: name,
        retryOn429: true,
        logger: log,
      });
    } catch (err) {
      log.warn({ err: serializeErr(err), bookingId: id }, "public booking cancel: booker email not sent");
    }
  })();
}

export default async function bookingRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  /** The public-link routes need 20261121000001: 503 `public_booking_unavailable` before it. */
  async function requirePublicReady(request: FastifyRequest): Promise<void> {
    if (!(await publicBookingReady(request.db))) throw publicBookingUnavailable();
  }

  async function loadPublicBooking(request: FastifyRequest, id: string): Promise<Row | null> {
    const { data, error } = await request.db
      .from("public_bookings")
      .select(PUBLIC_BOOKING_COLUMNS)
      .eq("id", id)
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    return (data as unknown as Row | null) ?? null;
  }

  app.get(
    "/public/:id",
    { preHandler: [...counselor, limit("booking:public:read", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await requirePublicReady(request);
      const row = await loadPublicBooking(request, id);
      if (!row) throw bookingNotFound();
      return { booking: toPublicBooking(row) };
    }
  );

  app.post(
    "/public/:id/cancel",
    { preHandler: [...counselor, limit("booking:public:cancel", 60, 3600)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await requirePublicReady(request);
      const owner = request.auth.userId;
      const io: PublicCancelIo = {
        load: (bookingId) => loadPublicBooking(request, bookingId),
        async cancel(bookingId) {
          const { data, error } = await request.db
            .from("public_bookings")
            .update({ status: "cancelled" })
            .eq("id", bookingId)
            .eq("counselor_id", owner)
            .eq("status", "scheduled")
            .select(PUBLIC_BOOKING_COLUMNS);
          if (error) throw fromPostgrest(error);
          const rows = (data ?? []) as unknown as Row[];
          return rows[0] ?? null;
        },
        // The caller owns the calendar: their own token, their own event.
        removeEvent: (provider, eventId) => deleteCalendarEvent(owner, provider, eventId, request.log),
        eventLeft: (provider, eventId) =>
          request.log.warn({ bookingId: id, provider, eventId }, "public booking cancel: calendar event not deleted"),
        afterCancel: (booking) => afterPublicCancel(request, booking),
      };
      return cancelPublicBooking(io, { id, counselorId: owner });
    }
  );

  /**
   * A settings row that has no public link slug yet gets one (lib/publicBooking.ts writeSlug, service role: a
   * user session can't write the column). Without the service key the slug stays null until a later read.
   */
  async function withSlug(request: FastifyRequest, row: Row | null, publicReady: boolean): Promise<Row | null> {
    if (!row || !publicReady || isPublicSlug(row.public_slug)) return row;
    const svc = serviceClient();
    if (!svc) return row;
    const slug = await writeSlug(svc, request.auth.userId, request.profile.full_name ?? null, { onlyIfMissing: true });
    return { ...row, public_slug: slug };
  }

  app.get("/settings", { preHandler: counselor }, async (request) => {
    await requireBookingReady(request.db);
    const [pageReady, publicReady] = await Promise.all([bookingPageReady(request.db), publicBookingReady(request.db)]);
    const { data, error } = await request.db
      .from("booking_settings")
      .select(settingsColumns(pageReady, publicReady))
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    const row = await withSlug(request, (data as unknown as Row | null) ?? null, publicReady);
    return toSettings(row, pageReady, publicReady);
  });

  /**
   * POST /booking/public-link/rotate: a new suffix for the counselor's public booking link; the old link stops
   * working at once. 409 `booking_not_set_up` before the first settings save (there is no link to rotate yet).
   */
  app.post(
    "/public-link/rotate",
    { preHandler: [...counselor, limit("booking:public-link:rotate", 10, 3600)] },
    async (request) => {
      await requireBookingReady(request.db);
      const svc = serviceClient();
      if (!svc || !(await publicBookingReady(request.db))) throw publicBookingUnavailable();
      const publicSlug = await writeSlug(svc, request.auth.userId, request.profile.full_name ?? null, { onlyIfMissing: false });
      if (!publicSlug) throw new HttpError(409, "Save your booking settings first", "booking_not_set_up");
      return { publicSlug };
    }
  );

  app.put(
    "/settings",
    { preHandler: [...counselor, limit("booking:settings", 60, 60)] },
    async (request) => {
      const b = settingsBody.parse(request.body ?? {});
      if (Object.keys(b).length === 0) throw badRequest("Nothing to change");
      await requireBookingReady(request.db);
      const [pageReady, publicReady] = await Promise.all([bookingPageReady(request.db), publicBookingReady(request.db)]);
      const namesPage = b.bookingPageUrl !== undefined || b.bookingPageMode !== undefined;
      if (namesPage && !pageReady) throw bookingPageUnavailable();
      if (b.publicBookingEnabled !== undefined && !publicReady) throw publicBookingUnavailable();

      const row: Row = { counselor_id: request.auth.userId };
      if (b.publicBookingEnabled !== undefined) row.public_booking_enabled = b.publicBookingEnabled;
      if (b.bookingPageUrl !== undefined) {
        const raw = b.bookingPageUrl?.trim() ?? "";
        if (raw === "") row.booking_page_url = null;
        else {
          const page = parseBookingPageUrl(raw);
          if (!page.ok) throw badRequest(page.message);
          row.booking_page_url = page.value;
        }
      }
      if (b.bookingPageMode !== undefined) row.booking_page_mode = b.bookingPageMode;
      if (b.weeklyHours !== undefined) {
        const hours = parseWeeklyHours(b.weeklyHours);
        if (!hours.ok) throw badRequest(hours.message);
        row.weekly_hours = hours.value;
      }
      if (b.enabled !== undefined) row.enabled = b.enabled;
      if (b.timeZone !== undefined) row.time_zone = b.timeZone;
      if (b.minNoticeHours !== undefined) row.min_notice_hours = b.minNoticeHours;
      if (b.maxDaysAhead !== undefined) row.max_days_ahead = b.maxDaysAhead;
      if (b.bufferMinutes !== undefined) row.buffer_minutes = b.bufferMinutes;
      if (b.cancelCutoffHours !== undefined) row.cancel_cutoff_hours = b.cancelCutoffHours;
      if (b.studentsCanReschedule !== undefined) row.students_can_reschedule = b.studentsCanReschedule;

      // A first save without a zone takes the counselor's own, when it is a real one.
      if (b.timeZone === undefined) {
        const { data: existing, error: readError } = await request.db
          .from("booking_settings")
          .select("counselor_id")
          .eq("counselor_id", request.auth.userId)
          .maybeSingle();
        if (readError) throw fromPostgrest(readError);
        const own = request.profile.timezone;
        if (!existing && typeof own === "string" && isTimeZone(own)) row.time_zone = own;
      }

      const { data, error } = await request.db
        .from("booking_settings")
        .upsert(row, { onConflict: "counselor_id" })
        .select(settingsColumns(pageReady, publicReady))
        .single();
      if (error) throw fromPostgrest(error);
      return toSettings(await withSlug(request, data as unknown as Row, publicReady), pageReady, publicReady);
    }
  );

  app.get("/types", { preHandler: counselor }, async (request) => {
    await requireBookingReady(request.db);
    const { data, error } = await request.db
      .from("booking_meeting_types")
      .select(TYPE_COLUMNS)
      .eq("counselor_id", request.auth.userId)
      .order("sort_order")
      .order("created_at")
      .limit(100);
    if (error) throw fromPostgrest(error);
    return { types: ((data ?? []) as Row[]).map(toMeetingType) };
  });

  app.post(
    "/types",
    { preHandler: [...counselor, limit("booking:types:create", 30, 60)] },
    async (request, reply) => {
      const b = typeBody.parse(request.body);
      await requireBookingReady(request.db);
      const { data, error } = await request.db
        .from("booking_meeting_types")
        .insert({
          counselor_id: request.auth.userId,
          name: b.name,
          duration_minutes: b.durationMinutes,
          mode: b.mode,
          active: b.active ?? true,
          sort_order: b.sortOrder ?? 0,
        })
        .select(TYPE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "23505") throw conflict(DUPLICATE_TYPE);
        throw fromPostgrest(error);
      }
      return reply.code(201).send(toMeetingType(data as Row));
    }
  );

  app.patch(
    "/types/:id",
    { preHandler: [...counselor, limit("booking:types:update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = typeBody.partial().strict().parse(request.body ?? {});
      const update: Row = {};
      if (b.name !== undefined) update.name = b.name;
      if (b.durationMinutes !== undefined) update.duration_minutes = b.durationMinutes;
      if (b.mode !== undefined) update.mode = b.mode;
      if (b.active !== undefined) update.active = b.active;
      if (b.sortOrder !== undefined) update.sort_order = b.sortOrder;
      if (Object.keys(update).length === 0) throw badRequest("Nothing to change");
      await requireBookingReady(request.db);

      const { data, error } = await request.db
        .from("booking_meeting_types")
        .update(update)
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .select(TYPE_COLUMNS)
        .maybeSingle();
      if (error) {
        if (error.code === "23505") throw conflict(DUPLICATE_TYPE);
        throw fromPostgrest(error);
      }
      if (!data) throw notFound("That meeting type isn't yours");
      return toMeetingType(data as Row);
    }
  );

  app.delete(
    "/types/:id",
    { preHandler: [...counselor, limit("booking:types:delete", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await requireBookingReady(request.db);
      const { data, error } = await request.db
        .from("booking_meeting_types")
        .delete()
        .eq("id", id)
        .eq("counselor_id", request.auth.userId)
        .select("id");
      if (error) throw fromPostgrest(error);
      if (!data || data.length === 0) throw notFound("That meeting type isn't yours");
      return { deleted: true };
    }
  );
}
