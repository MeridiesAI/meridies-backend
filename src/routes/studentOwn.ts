/**
 * The signed-in student's own additions (QA round 10), under /me. Student-only;
 * "me" is always the caller's JWT, and no route takes a student id.
 *
 *   POST   /me/messages/counselor        email my counselor (Reply-To me); a copy shows on their page
 *   GET    /me/messages/counselor        what I sent, newest first
 *   POST   /me/calendar/events           put an event of my own on my calendar
 *   PATCH  /me/calendar/events/:id       change it
 *   DELETE /me/calendar/events/:id       remove it
 *
 * Calendar events need migration 20261105000017 (`student_calendar_events`);
 * before it these answer 503 `student_events_unavailable`, and the feed leaves
 * them out. Messages are emailed whether or not `inbound_messages`
 * (20261103000002) is in; without it nothing is kept to list.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isMissingTable, toPersonalEvent } from "../lib/calendarFeed.js";
import { HttpError, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { listSentToCounselor, sendStudentMessage, STUDENT_MESSAGE_MAX } from "../lib/studentToCounselor.js";

const idParam = z.object({ id: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").pipe(z.string().date());

const eventBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).nullable().optional(),
    onDate: isoDate,
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const eventPatch = eventBody.partial().strict();

const UNAVAILABLE = new HttpError(503, "Adding your own events isn't switched on yet", "student_events_unavailable");

function checkTimes(startsAt: string | null | undefined, endsAt: string | null | undefined) {
  if (endsAt && !startsAt) throw new HttpError(400, "Give a start time with the end time");
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new HttpError(400, "The end has to be after the start");
  }
}

export default async function studentOwnRoutes(app: FastifyInstance) {
  const student = [app.authenticate, requireRole("student")];

  // ---- Messages to the counselor -------------------------------------------

  app.post(
    "/messages/counselor",
    {
      preHandler: [
        ...student,
        limit("me:message-counselor:hour", 10, 3600, "You've sent a lot of messages this hour. Try again later."),
        limit("me:message-counselor:day", 30, 86400, "You've reached today's message limit. Try again tomorrow."),
      ],
    },
    async (request, reply) => {
      const { body } = z
        .object({ body: z.string().max(STUDENT_MESSAGE_MAX + 200) })
        .strict()
        .parse(request.body);
      return reply.code(201).send(await sendStudentMessage(request, body));
    }
  );

  app.get(
    "/messages/counselor",
    { preHandler: [...student, limit("me:message-counselor:list", 120, 60)] },
    async (request) => listSentToCounselor(request)
  );

  // ---- My own calendar events -----------------------------------------------

  app.post(
    "/calendar/events",
    { preHandler: [...student, limit("me:calendar:create", 60, 60)] },
    async (request, reply) => {
      const b = eventBody.parse(request.body);
      checkTimes(b.startsAt, b.endsAt);
      const { data, error } = await request.db
        .from("student_calendar_events")
        .insert({
          student_id: request.auth.userId,
          title: b.title,
          detail: b.detail || null,
          on_date: b.onDate,
          starts_at: b.startsAt ?? null,
          ends_at: b.endsAt ?? null,
        })
        .select("*")
        .single();
      if (error) {
        if (isMissingTable(error)) throw UNAVAILABLE;
        throw fromPostgrest(error);
      }
      return reply.code(201).send(toPersonalEvent(data as Record<string, unknown>));
    }
  );

  app.patch(
    "/calendar/events/:id",
    { preHandler: [...student, limit("me:calendar:update", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = eventPatch.parse(request.body);
      const update: Record<string, unknown> = {};
      if (b.title !== undefined) update.title = b.title;
      if (b.detail !== undefined) update.detail = b.detail || null;
      if (b.onDate !== undefined) update.on_date = b.onDate;
      if (b.startsAt !== undefined) update.starts_at = b.startsAt;
      if (b.endsAt !== undefined) update.ends_at = b.endsAt;
      if (Object.keys(update).length === 0) throw new HttpError(400, "Nothing to change");
      if (b.startsAt !== undefined || b.endsAt !== undefined) checkTimes(b.startsAt, b.endsAt);
      const { data, error } = await request.db
        .from("student_calendar_events")
        .update(update)
        .eq("id", id)
        .eq("student_id", request.auth.userId)
        .select("*")
        .maybeSingle();
      if (error) {
        if (isMissingTable(error)) throw UNAVAILABLE;
        throw fromPostgrest(error);
      }
      if (!data) throw notFound("That event doesn't exist");
      return toPersonalEvent(data as Record<string, unknown>);
    }
  );

  app.delete(
    "/calendar/events/:id",
    { preHandler: [...student, limit("me:calendar:delete", 120, 60)] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db
        .from("student_calendar_events")
        .delete()
        .eq("id", id)
        .eq("student_id", request.auth.userId)
        .select("id");
      if (error) {
        if (isMissingTable(error)) throw UNAVAILABLE;
        throw fromPostgrest(error);
      }
      if (!data || data.length === 0) throw notFound("That event doesn't exist");
      return reply.code(204).send();
    }
  );
}
