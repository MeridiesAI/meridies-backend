/**
 * The signed-in student books time with their own counselor (20261111000001),
 * under /me/booking. Student only; "me" is the JWT and the counselor is the
 * student's own `profiles.counselor_id` (lib/booking.ts studentBookingContext),
 * never a client id. That counselor must be approved and have booking on;
 * otherwise the answer is calm and empty, the same for both, so it says
 * nothing about the counselor's account.
 *
 *   GET /me/booking/types                         the counselor's active meeting types
 *   GET /me/booking/slots?typeId&from&to[&tz]     free start times for one type
 *
 * Slots are the counselor's weekly hours (in their zone) minus their scheduled
 * Meridies meetings and their connected calendar's busy time, each widened by
 * the buffer, after the minimum notice and within max days ahead; one request
 * covers at most 14 days. Only free times leave the server, never what makes a
 * time busy. `tz` is the student's zone, accepted for the app's convenience and
 * not used: times are instants, with the counselor's `timeZone` beside them.
 *
 * Booking, rescheduling and cancelling come in part 2 (public.book_meeting_slot).
 * Before the migration these answer 503 `booking_unavailable`.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activeTypes, slotsFor, studentBookingContext } from "../lib/booking.js";
import { isTimeZone } from "../lib/calendarFeed.js";
import { HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

const slotsQuery = z
  .object({
    typeId: z.string().uuid(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    tz: z.string().trim().max(64).refine(isTimeZone, "That isn't a time zone").optional(),
  })
  .strict();

const NOT_AVAILABLE_MESSAGE = {
  no_counselor: "You don't have a counselor to book with yet",
  not_available: "Your counselor isn't taking bookings right now",
} as const;

export default async function studentBookingRoutes(app: FastifyInstance) {
  const student = [app.authenticate, requireRole("student")];

  app.get(
    "/types",
    { preHandler: [...student, limit("me:booking:types", 60, 60)] },
    async (request) => {
      const ctx = await studentBookingContext(request);
      if (!ctx.ok) return { available: false, reason: ctx.reason, timeZone: null, types: [] };
      return { available: true, reason: null, timeZone: ctx.settings.timeZone, types: await activeTypes(ctx.svc, ctx.counselorId) };
    }
  );

  app.get(
    "/slots",
    { preHandler: [...student, limit("me:booking:slots", 60, 60)] },
    async (request) => {
      const q = slotsQuery.parse(request.query);
      if (Date.parse(q.to) <= Date.parse(q.from)) throw new HttpError(400, "The end has to be after the start");
      const ctx = await studentBookingContext(request);
      if (!ctx.ok) throw new HttpError(404, NOT_AVAILABLE_MESSAGE[ctx.reason], "booking_not_available");
      const type = (await activeTypes(ctx.svc, ctx.counselorId)).find((t) => t.id === q.typeId);
      if (!type) throw new HttpError(404, "That meeting type isn't available", "type_not_found");
      return slotsFor(request, ctx, type, { from: q.from, to: q.to });
    }
  );
}
