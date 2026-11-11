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
import { isPublicSlug, writeSlug } from "../lib/publicBooking.js";
import { publicBookingReady, publicBookingUnavailable } from "../lib/publicBookingStore.js";
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

export default async function bookingRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

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
