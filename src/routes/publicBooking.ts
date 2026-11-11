/**
 * A counselor's public booking link (20261121000001; lib/publicBooking.ts). Public: nobody is signed in, the slug
 * in the path names the counselor. Absolute paths, like /pay/:token.
 *
 *   GET  /public/book/:slug                          { counselor: { name, practiceName, logoUrl, timezone }, types }
 *   GET  /public/book/:slug/slots?typeId&from&to     the free starts for one type: GET /me/booking/slots' shape
 *   POST /public/book/:slug  { typeId, startsAt, name, email, phone?, note?, website? }
 *                                                     201 { booking: { id, startsAt, endsAt, mode, joinUrl, typeName } }
 *
 * An unknown slug, a link switched off, booking paused or never set up, and an unapproved counselor are all the
 * same 404 `booking_link_not_found`. Before the migration (or without the service role key) every route answers
 * 503 `public_booking_unavailable`. Limits: in process per address (60 reads, 10 books a minute), and DB-backed per
 * address (600 reads, 10 books an hour), per booker address (5 books a day, across counselors) and per counselor
 * (40 books a day). A filled-in honeypot gets a 201 that looks like a booking and stores nothing.
 *
 * Service role: every read and write is keyed by the counselor the slug resolved to (approved, booking and the link
 * on), never a client id; a booking's id is only used on the row this request just reserved.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { activeTypes, slotsFor } from "../lib/booking.js";
import { counselorCalendarConnected, createPublicBookingEvent, removePublicBookingEvent } from "../lib/bookingCalendar.js";
import { slotOpen } from "../lib/bookingWrite.js";
import { isTimeZone } from "../lib/calendarFeed.js";
import { brandedEmail, brandedText, sendEmail } from "../lib/email.js";
import { fromPostgrest, HttpError } from "../lib/errors.js";
import { enforceRateLimit } from "../lib/limits.js";
import { fromAddress, validEmail } from "../lib/meetingInvites.js";
import {
  activityText,
  bookerEmail,
  bookPublic,
  counselorNotice,
  emailKey,
  isHoneypot,
  publicBookBody,
  publicBookingIcs,
  publicCounselor,
  publicPageAnswer,
  publicRpcError,
  resolvePublicLink,
  typeNotFound,
  type PublicBookingIo,
  type PublicCounselor,
  type PublicLinkContext,
} from "../lib/publicBooking.js";
import { publicBookingUnavailable } from "../lib/publicBookingStore.js";
import { serializeErr } from "../lib/requestLog.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

const slugParam = z.object({ slug: z.string().max(100) });
const slotsQuery = z
  .object({
    typeId: z.string().uuid(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    tz: z.string().trim().max(64).refine(isTimeZone, "That isn't a time zone").optional(),
  })
  .strict();

export const PUBLIC_READS_PER_HOUR = 600;
export const PUBLIC_BOOKS_PER_HOUR = 10;
export const PUBLIC_BOOKS_PER_EMAIL_PER_DAY = 5;
export const PUBLIC_BOOKS_PER_COUNSELOR_PER_DAY = 40;

const TOO_MANY = "Too many bookings from here. Try again later.";

function svcOrUnavailable() {
  const svc = serviceClient();
  if (!svc) throw publicBookingUnavailable();
  return svc;
}

const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex");

/** The bell notice, the two emails and the pipeline card, after the answer. Each step on its own; nothing throws. */
function followUps(request: FastifyRequest, ctx: PublicLinkContext, counselor: PublicCounselor, booking: Row): void {
  const svc = ctx.svc;
  const log = request.log;
  const tz = ctx.settings.timeZone;
  const id = String(booking.id);
  void (async () => {
    try {
      const { error } = await svc.rpc("public_booking_to_pipeline", {
        p_booking: id,
        p_activity: activityText(String(booking.type_name), String(booking.starts_at), tz),
      });
      if (error) log.warn({ err: serializeErr(error), bookingId: id }, "public booking: pipeline contact not recorded");
    } catch (err) {
      log.warn({ err: serializeErr(err), bookingId: id }, "public booking: pipeline contact not recorded");
    }

    const notice = counselorNotice(booking, tz);
    const href = "/dashboard/counselor/calendar";
    try {
      const { error } = await svc.from("notifications").insert({
        recipient_id: ctx.counselorId,
        student_id: null,
        kind: "system",
        urgency: "normal",
        title: notice.title,
        body: notice.body,
        href,
        action_items: [],
        created_by: null,
      });
      if (error) log.error({ err: serializeErr(error), bookingId: id }, "public booking: counselor notification not saved");
    } catch (err) {
      log.error({ err: serializeErr(err), bookingId: id }, "public booking: counselor notification not saved");
    }

    const organizerEmail = validEmail(counselor.email);
    const bookerAddress = validEmail(booking.email);
    const sentBy = fromAddress();
    if (organizerEmail && bookerAddress) {
      try {
        const ics = publicBookingIcs(booking, { name: counselor.name, email: organizerEmail }, { name: String(booking.name), email: bookerAddress }, "REQUEST", sentBy);
        await sendEmail({
          to: bookerAddress,
          ...bookerEmail(booking, counselor.name, tz),
          template: "public-booking-confirmation",
          attachments: [{ filename: "invite.ics", content: Buffer.from(ics, "utf8").toString("base64"), contentType: "text/calendar; charset=utf-8; method=REQUEST" }],
          replyTo: organizerEmail,
          fromName: counselor.name,
          retryOn429: true,
          logger: log,
        });
      } catch (err) {
        log.warn({ err: serializeErr(err), bookingId: id }, "public booking: confirmation not sent");
      }
    }
    if (organizerEmail) {
      try {
        const ics = publicBookingIcs(booking, { name: counselor.name, email: organizerEmail }, null, "PUBLISH", sentBy);
        const template = {
          heading: notice.title,
          paragraphs: notice.body.split("\n"),
          cta: { label: "Open your calendar", url: `${env.APP_URL.replace(/\/+$/, "")}${href}` },
          footnote: "A copy for your own calendar is attached.",
        };
        await sendEmail({
          to: organizerEmail,
          subject: notice.title.slice(0, 150),
          html: brandedEmail(template),
          text: brandedText(template),
          template: "public-booking-counselor",
          attachments: [{ filename: "invite.ics", content: Buffer.from(ics, "utf8").toString("base64"), contentType: "text/calendar; charset=utf-8; method=PUBLISH" }],
          ...(bookerAddress ? { replyTo: bookerAddress } : {}),
          recipient_kind: "counselor",
          recipient_id: ctx.counselorId,
          logger: log,
        });
      } catch (err) {
        log.warn({ err: serializeErr(err), bookingId: id }, "public booking: counselor email not sent");
      }
    }
  })();
}

/** The real side effects of lib/publicBooking.ts bookPublic, keyed by the counselor the slug resolved to. */
function publicIo(request: FastifyRequest, ctx: PublicLinkContext, counselor: PublicCounselor): PublicBookingIo {
  const svc = ctx.svc;
  const counselorId = ctx.counselorId;
  const now = new Date();
  const log = request.log;
  return {
    now: () => now,
    slotOpen: (type, startsAt) => slotOpen(request, ctx, type, startsAt, now),
    async countUpcomingForEmail(email) {
      const { count, error } = await svc
        .from("public_bookings")
        .select("id", { count: "exact", head: true })
        .eq("counselor_id", counselorId)
        .eq("email", email)
        .eq("status", "scheduled")
        .gt("starts_at", now.toISOString());
      if (error) throw fromPostgrest(error);
      return count ?? 0;
    },
    async reserve(a) {
      const { data, error } = await svc.rpc("book_public_slot", {
        p_counselor: counselorId,
        p_type: a.typeId,
        p_starts_at: a.startsAt,
        p_ends_at: a.endsAt,
        p_name: a.name,
        p_email: a.email,
        p_phone: a.phone,
        p_note: a.note,
      });
      if (error) throw publicRpcError(error) ?? fromPostgrest(error);
      return data as Row;
    },
    async release(id) {
      const { error } = await svc.from("public_bookings").delete().eq("id", id).eq("counselor_id", counselorId);
      if (error) log.error({ err: serializeErr(error), bookingId: id }, "public booking: a failed reservation couldn't be released");
    },
    async save(id, values) {
      const { data, error } = await svc.from("public_bookings").update(values).eq("id", id).eq("counselor_id", counselorId).select("*").single();
      if (error) throw fromPostgrest(error);
      return data as Row;
    },
    calendar: {
      connected: (provider) => counselorCalendarConnected(svc, counselorId, provider),
      async create(booking, provider, input, conference) {
        try {
          return await createPublicBookingEvent(booking, counselorId, provider, input, conference, log);
        } catch (err) {
          log.warn({ provider, status: err instanceof HttpError ? err.statusCode : null, code: err instanceof HttpError ? err.code : null }, "public booking: calendar event not created");
          throw err;
        }
      },
      async remove(booking, event) {
        try {
          await removePublicBookingEvent(booking, counselorId, event, log);
        } catch (err) {
          log.warn({ bookingId: String(booking.id), provider: event.provider, eventId: event.eventId }, "public booking: calendar event left after a failed save");
          throw err;
        }
      },
    },
    afterBooking: (booking) => followUps(request, ctx, counselor, booking),
  };
}

export default async function publicBookingRoutes(app: FastifyInstance) {
  const reads = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const writes = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.get("/public/book/:slug", reads, async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const svc = svcOrUnavailable();
    await enforceRateLimit(`public-book:read:${request.ip}`, PUBLIC_READS_PER_HOUR, 3600);
    const ctx = await resolvePublicLink(svc, slug);
    const [counselor, types] = await Promise.all([publicCounselor(svc, ctx.counselorId), activeTypes(svc, ctx.counselorId)]);
    noStore(reply);
    return publicPageAnswer(counselor, ctx.settings, types);
  });

  app.get("/public/book/:slug/slots", reads, async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const q = slotsQuery.parse(request.query);
    if (Date.parse(q.to) <= Date.parse(q.from)) throw new HttpError(400, "The end has to be after the start");
    const svc = svcOrUnavailable();
    await enforceRateLimit(`public-book:read:${request.ip}`, PUBLIC_READS_PER_HOUR, 3600);
    const ctx = await resolvePublicLink(svc, slug);
    const type = (await activeTypes(svc, ctx.counselorId)).find((t) => t.id === q.typeId);
    if (!type) throw typeNotFound();
    noStore(reply);
    return slotsFor(request, ctx, type, { from: q.from, to: q.to });
  });

  app.post("/public/book/:slug", writes, async (request, reply) => {
    const { slug } = slugParam.parse(request.params);
    const body = publicBookBody.parse(request.body);
    const svc = svcOrUnavailable();
    await enforceRateLimit(`public-book:write:${request.ip}`, PUBLIC_BOOKS_PER_HOUR, 3600, TOO_MANY);
    const ctx = await resolvePublicLink(svc, slug);
    const type = (await activeTypes(svc, ctx.counselorId)).find((t) => t.id === body.typeId);
    if (!type) throw typeNotFound();
    noStore(reply);
    if (!isHoneypot(body)) {
      await enforceRateLimit(`public-book:email:${emailKey(body.email)}`, PUBLIC_BOOKS_PER_EMAIL_PER_DAY, 86_400, TOO_MANY);
      await enforceRateLimit(`public-book:counselor:${ctx.counselorId}`, PUBLIC_BOOKS_PER_COUNSELOR_PER_DAY, 86_400, "This counselor can't take more bookings today. Try again tomorrow.");
    }
    const counselor = isHoneypot(body) ? null : await publicCounselor(svc, ctx.counselorId);
    const out = await bookPublic(counselor ? publicIo(request, ctx, counselor) : HONEYPOT_IO, { type, body });
    return reply.code(201).send(out);
  });
}

/** Never reached: bookPublic answers a honeypot before touching its I/O. Every call fails loudly if it ever is. */
const never = (): never => {
  throw new Error("public booking: a honeypot request reached the database");
};
const HONEYPOT_IO: PublicBookingIo = {
  now: () => new Date(),
  slotOpen: never,
  countUpcomingForEmail: never,
  reserve: never,
  release: never,
  save: never,
  calendar: { connected: never, create: never, remove: never },
  afterBooking: never,
};
