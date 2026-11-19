/**
 * Calendar (Demo v7–v9).
 *
 *   GET    /calendar/feed                  every dated item in a window, one list
 *   GET    /calendar/event-types           the counselor's own event types
 *   POST   /calendar/event-types           "+" by Event type: name, description, zone, colour
 *   PATCH  /calendar/event-types/:id
 *   DELETE /calendar/event-types/:id       events moved onto it fall back to their own type
 *   PUT    /calendar/assignments           move one event onto a type (from its type pill)
 *   DELETE /calendar/assignments/:kind/:ref
 *   POST   /calendar/events                a practice event ("Planning milestone")
 *   PATCH  /calendar/events/:id
 *   DELETE /calendar/events/:id
 *   POST   /calendar/events/series         a repeating practice event (one row per occurrence, one series_id)
 *   PATCH  /calendar/events/series/:seriesId   this and following / all upcoming, per row
 *   DELETE /calendar/events/series/:seriesId
 *
 * Meetings keep their own routes (routes/meetings.ts) because booking one can
 * create a Meet / Teams event on a connected calendar; the feed only reads
 * them. Types and practice events are the counselor's own; a student reads
 * the feed for themselves and writes nothing here.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  BUILTIN_TYPES,
  buildCalendarFeed,
  isTimeZone,
  loadEventTypes,
  toAssignment,
  toEventType,
  toPracticeEvent,
} from "../lib/calendarFeed.js";
import { badRequest, conflict, fromPostgrest, notFound } from "../lib/errors.js";
import { fullCaseloadStudentIds, requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { connectedAccountEmail } from "../lib/oauth.js";
import { expandSeriesDates, MAX_SERIES, shiftInstant, wallDelta, zonedInstant } from "../lib/recurrence.js";
import { repeatBody, SERIES_UNAVAILABLE, seriesReady } from "../lib/seriesSchema.js";

type Row = Record<string, unknown>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").pipe(z.string().date());
const hex = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, "Use a #RRGGBB colour");
const timeZone = z
  .string()
  .trim()
  .max(64)
  .refine(isTimeZone, "That isn't a time zone");
const idParam = z.object({ id: z.string().uuid() });

/** A year view plus a little either side, never an unbounded scan. */
const MAX_WINDOW_DAYS = 400;

const feedQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    tz: timeZone.optional(),
    studentId: z.string().uuid().optional(),
    includeDone: z.enum(["true", "false"]).optional(),
    includeCancelled: z.enum(["true", "false"]).optional(),
  })
  .strict();

const eventTypeBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    timeZone: timeZone.optional(),
    color: hex,
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const eventKind = z.enum(BUILTIN_TYPES);

const assignmentBody = z
  .object({
    eventKind,
    /** A source row id; Events Hub refs are the hub's own ids. */
    eventRef: z.string().trim().min(1).max(120),
    /** A built-in key, or the id of one of the caller's event types. */
    type: z.union([eventKind, z.string().uuid()]),
  })
  .strict();

const practiceEventBody = z
  .object({
    title: z.string().trim().min(1).max(300),
    detail: z.string().trim().max(2000).nullable().optional(),
    onDate: isoDate,
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    studentId: z.string().uuid().nullable().optional(),
    typeId: z.string().uuid().nullable().optional(),
    sharedWithStudent: z.boolean().optional(),
  })
  .strict();

/** One practice event's fields plus when it repeats: a local date and wall-clock time (null: all day) in an IANA zone. */
const seriesEventBody = practiceEventBody
  .omit({ onDate: true, startsAt: true, endsAt: true })
  .extend({
    date: isoDate,
    startMinutes: z.number().int().min(0).max(1439).nullable(),
    durationMins: z.number().int().min(15).max(1440).optional(),
    timeZone,
    repeat: repeatBody,
  })
  .strict();
const seriesParam = z.object({ seriesId: z.string().uuid() });
const seriesScopeName = z.enum(["following", "all"]);
/** Times are strings only: clearing a time (making the series all day) isn't a series edit. */
const seriesEventPatchBody = z
  .object({
    anchorId: z.string().uuid(),
    scope: seriesScopeName,
    timeZone,
    patch: practiceEventBody
      .extend({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) })
      .partial()
      .strict(),
  })
  .strict();
const seriesEventDeleteQuery = z.object({ anchorId: z.string().uuid(), scope: seriesScopeName, timeZone: timeZone.optional() }).strict();
type SeriesFailure = { id: string; date: string; message: string };

const shiftDate = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The caller's rows of a repeating practice event that a scoped change acts on: from the anchor's date
 * (`following`) or from today in `tz` (`all`). The anchor must be the caller's and in the series, else 404.
 */
async function eventSeriesScope(request: FastifyRequest, seriesId: string, anchorId: string, scope: "following" | "all", tz: string) {
  const owner = request.auth.userId;
  const { data: anchor, error: aErr } = await request.db
    .from("calendar_events")
    .select("*")
    .eq("id", anchorId)
    .eq("owner_id", owner)
    .maybeSingle();
  if (aErr) throw fromPostgrest(aErr);
  if (!anchor || anchor.series_id !== seriesId) throw notFound("That event isn't part of this repeating series");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const { data, error } = await request.db
    .from("calendar_events")
    .select("*")
    .eq("series_id", seriesId)
    .eq("owner_id", owner)
    .gte("on_date", scope === "following" ? String(anchor.on_date) : today)
    .order("on_date", { ascending: true })
    // A series is at most MAX_SERIES (52) rows, so this bound is never reached; it only keeps the read finite.
    .limit(500);
  if (error) throw fromPostgrest(error);
  return { anchor: anchor as Row, rows: (data ?? []) as Row[] };
}

/** The caller's saved zone, if it is one this runtime knows. */
function profileZone(tz: string | null | undefined): string | null {
  return tz && isTimeZone(tz) ? tz : null;
}

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export default async function calendarRoutes(app: FastifyInstance) {
  // ---- The feed -------------------------------------------------------------

  app.get(
    "/feed",
    { preHandler: [app.authenticate, limit("calendar:feed", 240, 60)] },
    async (request) => {
      const q = feedQuery.parse(request.query);
      const span = days(q.from, q.to);
      if (span < 0) throw badRequest("`to` is before `from`");
      if (span > MAX_WINDOW_DAYS) throw badRequest(`Ask for at most ${MAX_WINDOW_DAYS} days at a time`);

      let studentId: string | undefined;
      if (q.studentId || request.profile.role === "student") {
        studentId = await resolveStudentId(request, q.studentId, "view");
      }

      // A counselor's whole calendar names every student they may view (never unscoped).
      const role = request.profile.role;
      const whole = role === "counselor" && !studentId;
      const caseload = whole ? await fullCaseloadStudentIds(request.db, request.auth.userId) : undefined;
      const googleAccountEmail = () => connectedAccountEmail(request.auth.userId, "google");
      return buildCalendarFeed({ db: request.db, ownerId: request.auth.userId, role, caseload, googleAccountEmail }, {
        from: q.from,
        to: q.to,
        tz: q.tz ?? profileZone(request.profile.timezone) ?? "UTC",
        studentId: request.profile.role === "student" ? undefined : studentId,
        includeDone: q.includeDone !== "false",
        includeCancelled: q.includeCancelled === "true",
      });
    }
  );

  // ---- Event types ----------------------------------------------------------

  app.get(
    "/event-types",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request) => loadEventTypes(request)
  );

  app.post(
    "/event-types",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:types:create", 60, 60)] },
    async (request, reply) => {
      const b = eventTypeBody.parse(request.body);
      const { data, error } = await request.db
        .from("calendar_event_types")
        .insert({
          owner_id: request.auth.userId,
          name: b.name,
          description: b.description ?? null,
          time_zone: b.timeZone ?? profileZone(request.profile.timezone) ?? "America/New_York",
          color: b.color.toLowerCase(),
          sort_order: b.sortOrder ?? 0,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") throw conflict("You already have an event type with that name");
        throw fromPostgrest(error);
      }
      return reply.code(201).send(toEventType(data as Row));
    }
  );

  app.patch(
    "/event-types/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:types:update", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = eventTypeBody.partial().strict().parse(request.body);
      const update: Row = {};
      if (b.name !== undefined) update.name = b.name;
      if (b.description !== undefined) update.description = b.description;
      if (b.timeZone !== undefined) update.time_zone = b.timeZone;
      if (b.color !== undefined) update.color = b.color.toLowerCase();
      if (b.sortOrder !== undefined) update.sort_order = b.sortOrder;
      if (Object.keys(update).length === 0) throw badRequest("Nothing to change");

      const { data, error } = await request.db
        .from("calendar_event_types")
        .update(update)
        .eq("id", id)
        .eq("owner_id", request.auth.userId)
        .select("*")
        .maybeSingle();
      if (error) {
        if (error.code === "23505") throw conflict("You already have an event type with that name");
        throw fromPostgrest(error);
      }
      if (!data) throw notFound("That event type isn't yours");
      return toEventType(data as Row);
    }
  );

  /**
   * Deleting a type never deletes an event. Reassignments onto it cascade
   * away, so those events show as their own type again, and practice events
   * made on it keep their date and title with no type.
   */
  app.delete(
    "/event-types/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:types:delete", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db
        .from("calendar_event_types")
        .delete()
        .eq("id", id)
        .eq("owner_id", request.auth.userId)
        .select("id");
      if (error) throw fromPostgrest(error);
      if (!data || data.length === 0) throw notFound("That event type isn't yours");
      return { deleted: true };
    }
  );

  // ---- Moving an event onto a type -----------------------------------------

  app.put(
    "/assignments",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:assign", 240, 60)] },
    async (request) => {
      const b = assignmentBody.parse(request.body);
      if (b.eventKind !== "event" && !z.string().uuid().safeParse(b.eventRef).success) {
        throw badRequest("That event reference isn't valid");
      }
      const builtin = (BUILTIN_TYPES as readonly string[]).includes(b.type);

      // Moving an event back onto its own kind is the same as clearing it.
      if (builtin && b.type === b.eventKind) {
        const { error } = await request.db
          .from("calendar_event_type_assignments")
          .delete()
          .eq("owner_id", request.auth.userId)
          .eq("event_kind", b.eventKind)
          .eq("event_ref", b.eventRef);
        if (error) throw fromPostgrest(error);
        return { eventKind: b.eventKind, eventRef: b.eventRef, type: b.eventKind };
      }

      if (!builtin) {
        const { data: own, error: tErr } = await request.db
          .from("calendar_event_types")
          .select("id")
          .eq("id", b.type)
          .eq("owner_id", request.auth.userId)
          .maybeSingle();
        if (tErr) throw fromPostgrest(tErr);
        if (!own) throw notFound("That event type isn't yours");
      }

      const { data, error } = await request.db
        .from("calendar_event_type_assignments")
        .upsert(
          {
            owner_id: request.auth.userId,
            event_kind: b.eventKind,
            event_ref: b.eventRef,
            builtin_type: builtin ? b.type : null,
            type_id: builtin ? null : b.type,
          },
          { onConflict: "owner_id,event_kind,event_ref" }
        )
        .select("event_kind, event_ref, builtin_type, type_id")
        .single();
      if (error) throw fromPostgrest(error);
      return toAssignment(data as Row);
    }
  );

  app.delete(
    "/assignments/:kind/:ref",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:assign", 240, 60)] },
    async (request) => {
      const p = z
        .object({ kind: eventKind, ref: z.string().trim().min(1).max(120) })
        .parse(request.params);
      const { error } = await request.db
        .from("calendar_event_type_assignments")
        .delete()
        .eq("owner_id", request.auth.userId)
        .eq("event_kind", p.kind)
        .eq("event_ref", p.ref);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  // ---- Practice events ------------------------------------------------------

  async function checkPracticeRefs(
    request: Parameters<typeof resolveStudentId>[0],
    b: { studentId?: string | null; typeId?: string | null }
  ) {
    if (b.studentId) await resolveStudentId(request, b.studentId, "edit");
    if (b.typeId) {
      const { data, error } = await request.db
        .from("calendar_event_types")
        .select("id")
        .eq("id", b.typeId)
        .eq("owner_id", request.auth.userId)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That event type isn't yours");
    }
  }

  app.post(
    "/events",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:events:create", 120, 60)] },
    async (request, reply) => {
      const b = practiceEventBody.parse(request.body);
      if (b.endsAt && !b.startsAt) throw badRequest("An end time needs a start time");
      if (b.sharedWithStudent && !b.studentId) throw badRequest("Only an event about a student can be shared");
      await checkPracticeRefs(request, b);

      const { data, error } = await request.db
        .from("calendar_events")
        .insert({
          owner_id: request.auth.userId,
          student_id: b.studentId ?? null,
          title: b.title,
          detail: b.detail ?? null,
          on_date: b.onDate,
          starts_at: b.startsAt ?? null,
          ends_at: b.endsAt ?? null,
          type_id: b.typeId ?? null,
          shared_with_student: b.sharedWithStudent ?? false,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return reply.code(201).send(toPracticeEvent(data as Row));
    }
  );

  // ---- Repeating practice events (registered before /events/:id) -----------

  /**
   * A repeating practice event: one row per occurrence, all sharing a fresh `series_id`, ONE insert (so all or
   * nothing). Timed rows start at `startMinutes` on each date's wall clock in `timeZone` and end `durationMins`
   * later (start + minutes, so a DST change keeps the length); `startMinutes: null` makes all-day rows.
   */
  app.post(
    "/events/series",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:events:series", 20, 60)] },
    async (request, reply) => {
      if (!(await seriesReady(request.db))) throw SERIES_UNAVAILABLE();
      const b = seriesEventBody.parse(request.body);
      if (b.startMinutes !== null && b.durationMins === undefined) throw badRequest("Give the event a length");
      if (b.sharedWithStudent && !b.studentId) throw badRequest("Only an event about a student can be shared");
      await checkPracticeRefs(request, b);
      let dates: string[];
      try {
        const { preset, count, until } = b.repeat;
        dates = expandSeriesDates(b.date, { preset, end: count !== undefined ? { count } : { until: until! } }, MAX_SERIES);
      } catch (err) {
        if (err instanceof RangeError) throw badRequest(err.message);
        throw err;
      }
      const seriesId = randomUUID();
      const { data, error } = await request.db
        .from("calendar_events")
        .insert(
          dates.map((d) => {
            const startsAt = b.startMinutes === null ? null : zonedInstant(d, b.startMinutes, b.timeZone);
            return {
              owner_id: request.auth.userId,
              student_id: b.studentId ?? null,
              title: b.title,
              detail: b.detail ?? null,
              on_date: d,
              starts_at: startsAt,
              ends_at: startsAt ? new Date(Date.parse(startsAt) + b.durationMins! * 60_000).toISOString() : null,
              type_id: b.typeId ?? null,
              shared_with_student: b.sharedWithStudent ?? false,
              series_id: seriesId,
            };
          })
        )
        .select("*");
      if (error) throw fromPostgrest(error);
      return reply.code(201).send({ seriesId, events: ((data ?? []) as Row[]).map(toPracticeEvent) });
    }
  );

  /**
   * A change to part of a repeating practice event: the caller's rows of the series from the anchor on
   * (`following`) or from today in `timeZone` (`all`). Per row, not atomic: a row that fails is left as it was and
   * listed in `failed`, the answer is still 200. A move shifts every row by the anchor's change (`onDate` gives the
   * days, else `startsAt`'s wall-clock days; `startsAt` gives the minutes), so a row moved by hand keeps its offset;
   * an `endsAt` sets every timed row to the anchor's new length, else a row keeps its own. ALL-DAY rows only get
   * their date shifted: time keys are ignored for them. Times can't be cleared here (null is a 400). `skipped` is
   * always 0: practice events have no status, and rows before the window are not counted.
   */
  app.patch(
    "/events/series/:seriesId",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:events:series-update", 60, 60)] },
    async (request) => {
      if (!(await seriesReady(request.db))) throw SERIES_UNAVAILABLE();
      const { seriesId } = seriesParam.parse(request.params);
      const body = seriesEventPatchBody.parse(request.body);
      const p = body.patch;
      if (Object.keys(p).length === 0) throw badRequest("Nothing to change");
      await checkPracticeRefs(request, p);
      const tz = body.timeZone;
      const { anchor, rows } = await eventSeriesScope(request, seriesId, body.anchorId, body.scope, tz);
      const anchorStart = anchor.starts_at ? String(anchor.starts_at) : null;
      const wall = p.startsAt && anchorStart ? wallDelta(anchorStart, p.startsAt, tz) : null;
      const shift = { days: p.onDate ? days(String(anchor.on_date), p.onDate) : (wall?.days ?? 0), minutes: wall?.minutes ?? 0 };
      let duration: number | undefined;
      if (p.endsAt) {
        const from = p.startsAt ?? anchorStart;
        if (!from) throw badRequest("An end time needs a start time");
        duration = Date.parse(p.endsAt) - Date.parse(from);
        if (!(duration > 0)) throw badRequest("The end has to be after the start");
      }
      const moved = shift.days !== 0 || shift.minutes !== 0;

      let updated = 0;
      const failed: SeriesFailure[] = [];
      for (const row of rows) {
        const update: Row = {};
        if (p.title !== undefined) update.title = p.title;
        if (p.detail !== undefined) update.detail = p.detail;
        if (p.studentId !== undefined) update.student_id = p.studentId;
        if (p.typeId !== undefined) update.type_id = p.typeId;
        if (p.sharedWithStudent !== undefined) update.shared_with_student = p.sharedWithStudent;
        // Un-assigning the student un-shares the event, as the single PATCH does.
        if (p.studentId === null) update.shared_with_student = false;
        if (shift.days !== 0) update.on_date = shiftDate(String(row.on_date), shift.days);
        if (row.starts_at) {
          const start = String(row.starts_at);
          const newStart = moved ? shiftInstant(start, shift, tz) : start;
          if (moved) update.starts_at = newStart;
          if (duration !== undefined) update.ends_at = new Date(Date.parse(newStart) + duration).toISOString();
          else if (moved && row.ends_at) {
            update.ends_at = new Date(Date.parse(newStart) + Date.parse(String(row.ends_at)) - Date.parse(start)).toISOString();
          }
        }
        // An all-day row sent only time keys: nothing of it changes, and it counts as done.
        if (Object.keys(update).length === 0) {
          updated += 1;
          continue;
        }
        const { data, error } = await request.db
          .from("calendar_events")
          .update(update)
          .eq("id", String(row.id))
          .eq("owner_id", request.auth.userId)
          .select("*")
          .maybeSingle();
        if (error || !data) {
          const message = !error
            ? "That event isn't on your calendar"
            : error.code === "23514"
              ? "Those times or that sharing choice don't fit this event (sharing needs a student)"
              : "Couldn't change this event. Try again.";
          request.log.warn({ seriesId, id: row.id, code: error?.code, err: error }, "series event update failed");
          failed.push({ id: String(row.id), date: String(row.on_date), message });
          continue;
        }
        updated += 1;
      }
      return { updated, skipped: 0, failed };
    }
  );

  /**
   * Delete part of a repeating practice event (the PATCH's rows), per row, with each row's type reassignment.
   * `timeZone` decides "today" for `all` (UTC when left out; the app always sends it). `skipped` is always 0.
   */
  app.delete(
    "/events/series/:seriesId",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:events:series-delete", 60, 60)] },
    async (request) => {
      if (!(await seriesReady(request.db))) throw SERIES_UNAVAILABLE();
      const { seriesId } = seriesParam.parse(request.params);
      const q = seriesEventDeleteQuery.parse(request.query);
      const { rows } = await eventSeriesScope(request, seriesId, q.anchorId, q.scope, q.timeZone ?? "UTC");
      let deleted = 0;
      const failed: SeriesFailure[] = [];
      for (const row of rows) {
        const id = String(row.id);
        const { data, error } = await request.db
          .from("calendar_events")
          .delete()
          .eq("id", id)
          .eq("owner_id", request.auth.userId)
          .select("id");
        if (error || !data || data.length === 0) {
          request.log.warn({ seriesId, id, code: error?.code, err: error }, "series event delete failed");
          failed.push({
            id,
            date: String(row.on_date),
            message: error ? "Couldn't delete this event. Try again." : "That event isn't on your calendar",
          });
          continue;
        }
        deleted += 1;
        // Best effort, as DELETE /events/:id.
        await request.db
          .from("calendar_event_type_assignments")
          .delete()
          .eq("owner_id", request.auth.userId)
          .eq("event_kind", "milestone")
          .eq("event_ref", id);
      }
      return { deleted, skipped: 0, failed };
    }
  );

  app.patch(
    "/events/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:events:update", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = practiceEventBody.partial().strict().parse(request.body);
      await checkPracticeRefs(request, b);

      const update: Row = {};
      if (b.title !== undefined) update.title = b.title;
      if (b.detail !== undefined) update.detail = b.detail;
      if (b.onDate !== undefined) update.on_date = b.onDate;
      if (b.startsAt !== undefined) update.starts_at = b.startsAt;
      if (b.endsAt !== undefined) update.ends_at = b.endsAt;
      if (b.studentId !== undefined) update.student_id = b.studentId;
      if (b.typeId !== undefined) update.type_id = b.typeId;
      if (b.sharedWithStudent !== undefined) update.shared_with_student = b.sharedWithStudent;
      // Un-assigning the student un-shares the event, rather than failing the check.
      if (b.studentId === null) update.shared_with_student = false;
      if (Object.keys(update).length === 0) throw badRequest("Nothing to change");

      const { data, error } = await request.db
        .from("calendar_events")
        .update(update)
        .eq("id", id)
        .eq("owner_id", request.auth.userId)
        .select("*")
        .maybeSingle();
      if (error) {
        if (error.code === "23514") throw badRequest("Those times or that sharing choice don't fit together");
        throw fromPostgrest(error);
      }
      if (!data) throw notFound("That event isn't on your calendar");
      return toPracticeEvent(data as Row);
    }
  );

  app.delete(
    "/events/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("calendar:events:delete", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { data, error } = await request.db
        .from("calendar_events")
        .delete()
        .eq("id", id)
        .eq("owner_id", request.auth.userId)
        .select("id");
      if (error) throw fromPostgrest(error);
      if (!data || data.length === 0) throw notFound("That event isn't on your calendar");
      // The event's own reassignment, if any, goes with it.
      await request.db
        .from("calendar_event_type_assignments")
        .delete()
        .eq("owner_id", request.auth.userId)
        .eq("event_kind", "milestone")
        .eq("event_ref", id);
      return { deleted: true };
    }
  );
}
