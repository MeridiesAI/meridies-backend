/**
 * A counselor's student-booking setup (20261111000001), under /booking.
 * Counselor only (and, through `authenticate`, approved only); every query
 * runs on the caller's own client and the tables are owner-only, so a
 * counselor reads and writes their own rows and nobody else's.
 *
 *   GET    /booking/settings        hours, zone, notice, buffer, cutoff, switches (defaults when never saved)
 *   PUT    /booking/settings        save any of them (weekly hours checked in full, zone must be IANA)
 *   GET    /booking/types           the counselor's meeting types, active or not
 *   POST   /booking/types           add one (name, 15-180 minutes, google-meet | teams | in-person | phone)
 *   PATCH  /booking/types/:id
 *   DELETE /booking/types/:id
 *
 * Before the migration every route answers 503 `booking_unavailable`.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BOOKING_MODES,
  requireBookingReady,
  SETTINGS_COLUMNS,
  toMeetingType,
  toSettings,
  TYPE_COLUMNS,
} from "../lib/booking.js";
import { parseWeeklyHours } from "../lib/bookingSlots.js";
import { isTimeZone } from "../lib/calendarFeed.js";
import { badRequest, conflict, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

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

  app.get("/settings", { preHandler: counselor }, async (request) => {
    await requireBookingReady(request.db);
    const { data, error } = await request.db
      .from("booking_settings")
      .select(SETTINGS_COLUMNS)
      .eq("counselor_id", request.auth.userId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    return toSettings((data as Row | null) ?? null);
  });

  app.put(
    "/settings",
    { preHandler: [...counselor, limit("booking:settings", 60, 60)] },
    async (request) => {
      const b = settingsBody.parse(request.body ?? {});
      if (Object.keys(b).length === 0) throw badRequest("Nothing to change");
      await requireBookingReady(request.db);

      const row: Row = { counselor_id: request.auth.userId };
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
        .select(SETTINGS_COLUMNS)
        .single();
      if (error) throw fromPostgrest(error);
      return toSettings(data as Row);
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
