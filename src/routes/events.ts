/**
 * Events Hub (Demo v8; one feed under its search since v9).
 *
 *   GET    /events                 the feed: upcoming listings, then updates
 *   GET    /events/recommended     three listings, ranked against the roster
 *   GET    /events/colleges        Filter by college: schools the feed has items from
 *   GET    /events/saved           the caller's saves
 *   GET    /events/calendar        saves sent to the Meridies calendar, as
 *                                  Calendar items (kind "event") — the
 *                                  Calendar merges these with its own feed
 *   GET    /events/:id
 *   POST   /events                 a counselor's listing, for the firm or self
 *   PATCH  /events/:id             the author's own
 *   DELETE /events/:id
 *   PUT    /events/:id/save        Add to Calendar (targets + reminder)
 *   DELETE /events/:id/save
 *
 * Counselor-only. Listings are real rows; the demo's authored listings are not
 * seeded. Updates are `policy_updates`, the catalog's published changes.
 * Google / Outlook / .ics are built by the client from the listing — nothing
 * here touches a connected calendar.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  CALENDAR_TARGETS,
  EVENT_KINDS,
  EVENT_TOPICS,
  PHOTO_KEYS,
  REMINDERS,
  filterFeed,
  isTimeZone,
  isUpcoming,
  scoreForRoster,
  seniorClassYear,
  toCalendarItem,
  toCollegeRef,
  toHubEvent,
  toHubUpdate,
  toSave,
  type CollegeRef,
  type FeedItem,
  type HubEvent,
  type SavedState,
} from "../lib/eventsHub.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const eventBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(EVENT_KINDS),
    host: z.string().trim().min(1).max(200),
    startDate: isoDate,
    endDate: isoDate.nullable().optional(),
    startTime: clock.nullable().optional(),
    endTime: clock.nullable().optional(),
    timeZone: z.string().trim().min(1).max(64).optional(),
    place: z.string().trim().min(1).max(200).optional(),
    url: z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address"),
    description: z.string().trim().max(1000).nullable().optional(),
    collegeId: z.string().uuid().nullable().optional(),
    photoKey: z.enum(PHOTO_KEYS).nullable().optional(),
    topics: z.array(z.enum(EVENT_TOPICS)).max(5).optional(),
    /** "firm": everyone in the caller's firm sees it; "me": only the caller. */
    share: z.enum(["firm", "me"]).optional(),
  })
  .strict();

const LISTING_COLUMNS = "*";

async function collegesById(request: FastifyRequest, ids: string[]): Promise<Map<string, CollegeRef>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await request.db.from("colleges").select("id, slug, name, aka").in("id", unique);
  if (error) throw fromPostgrest(error);
  return new Map(((data ?? []) as Row[]).map((r) => [String(r.id), toCollegeRef(r)]));
}

async function savesFor(request: FastifyRequest, eventIds: string[]): Promise<Map<string, SavedState>> {
  if (!eventIds.length) return new Map();
  const { data, error } = await request.db
    .from("hub_event_saves")
    .select("*")
    .eq("profile_id", request.auth.userId)
    .in("event_id", eventIds);
  if (error) throw fromPostgrest(error);
  return new Map(((data ?? []) as Row[]).map((r) => [String(r.event_id), toSave(r)]));
}

/** Listings visible to the caller (RLS scopes them), serialized with college and save state. */
async function loadEvents(request: FastifyRequest, rows: Row[]): Promise<HubEvent[]> {
  const [colleges, saves] = await Promise.all([
    collegesById(request, rows.map((r) => String(r.college_id ?? ""))),
    savesFor(request, rows.map((r) => String(r.id))),
  ]);
  return rows.map((r) =>
    toHubEvent(
      r,
      request.auth.userId,
      r.college_id ? (colleges.get(String(r.college_id)) ?? null) : null,
      saves.get(String(r.id)) ?? null
    )
  );
}

/** Upcoming listings, earliest first. A day of slack covers every time zone. */
async function upcomingRows(request: FastifyRequest, max = 400): Promise<Row[]> {
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await request.db
    .from("hub_events")
    .select(LISTING_COLUMNS)
    .or(`start_date.gte.${since},end_date.gte.${since}`)
    .order("start_date", { ascending: true })
    .limit(max);
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[]).filter(isUpcoming);
}

async function updateRows(request: FastifyRequest, max = 60): Promise<Row[]> {
  const { data, error } = await request.db
    .from("policy_updates")
    .select("id, college_id, institution, title, summary, category, published_at, source_url")
    .order("published_at", { ascending: false })
    .limit(max);
  if (error) throw fromPostgrest(error);
  return (data ?? []) as Row[];
}

async function buildFeed(request: FastifyRequest): Promise<FeedItem[]> {
  const [events, updates] = await Promise.all([upcomingRows(request), updateRows(request)]);
  const [listings, colleges] = await Promise.all([
    loadEvents(request, events),
    collegesById(request, updates.map((u) => String(u.college_id ?? ""))),
  ]);
  return [
    ...listings.map((item) => ({ type: "event" as const, item })),
    ...updates.map((u) => ({
      type: "update" as const,
      item: toHubUpdate(u, u.college_id ? (colleges.get(String(u.college_id)) ?? null) : null),
    })),
  ];
}

function eventRow(b: Partial<z.infer<typeof eventBody>>): Row {
  const row: Row = {};
  if (b.name !== undefined) row.name = b.name;
  if (b.kind !== undefined) row.kind = b.kind;
  if (b.host !== undefined) row.host = b.host;
  if (b.startDate !== undefined) row.start_date = b.startDate;
  if (b.endDate !== undefined) row.end_date = b.endDate;
  if (b.startTime !== undefined) row.start_time = b.startTime;
  if (b.endTime !== undefined) row.end_time = b.endTime;
  if (b.timeZone !== undefined) row.time_zone = b.timeZone;
  if (b.place !== undefined) row.place = b.place;
  if (b.url !== undefined) row.url = b.url;
  if (b.description !== undefined) row.description = b.description;
  if (b.collegeId !== undefined) row.college_id = b.collegeId;
  if (b.photoKey !== undefined) row.photo_key = b.photoKey;
  if (b.topics !== undefined) row.topics = b.topics;
  return row;
}

function checkTimes(b: Partial<z.infer<typeof eventBody>>) {
  if (b.timeZone !== undefined && !isTimeZone(b.timeZone)) throw badRequest("That time zone isn't recognised");
  if (b.endDate && b.startDate && b.endDate < b.startDate) throw badRequest("An event can't end before it starts");
  if (b.endTime && !b.startTime) throw badRequest("Give a start time with the end time");
  if (b.startTime && b.endTime && !b.endDate && b.endTime <= b.startTime) {
    throw badRequest("The end time has to be after the start time");
  }
}

export default async function eventRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  // ---- The feed ----------------------------------------------------------------

  app.get("/", { preHandler: [...counselor, limit("events:feed", 120, 60)] }, async (request) => {
    const q = z
      .object({
        q: z.string().trim().max(120).optional(),
        kind: z.enum([...EVENT_KINDS, "update", "all"]).optional(),
        colleges: z.string().trim().max(2000).optional(),
      })
      .parse(request.query);
    const colleges = (q.colleges ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (colleges.some((c) => !z.string().uuid().safeParse(c).success)) throw badRequest("colleges takes college ids");

    const items = filterFeed(await buildFeed(request), {
      query: q.q ?? "",
      kind: q.kind ?? "all",
      colleges,
    });
    return { items };
  });

  app.get("/recommended", { preHandler: [...counselor, limit("events:recommended", 60, 60)] }, async (request) => {
    const { count } = z.object({ count: z.coerce.number().int().min(1).max(12).optional() }).parse(request.query);

    // The roster as RLS shows it: the caller's students and their lists.
    const [students, lists] = await Promise.all([
      request.db.from("profiles").select("id, grad_year").eq("role", "student").eq("counselor_id", request.auth.userId).limit(2000),
      request.db.from("student_colleges").select("college_id, name").limit(5000),
    ]);
    if (students.error) throw fromPostgrest(students.error);
    if (lists.error) throw fromPostgrest(lists.error);

    const senior = String(seniorClassYear());
    const listRows = (lists.data ?? []) as Row[];
    const roster = {
      collegeIds: new Set(listRows.map((r) => String(r.college_id ?? "")).filter(Boolean)),
      hasSeniors: ((students.data ?? []) as Row[]).some((s) => String(s.grad_year ?? "") === senior),
      hasUc: listRows.some((r) => /^(uc |university of california)/i.test(String(r.name ?? ""))),
    };

    const listings = await loadEvents(request, await upcomingRows(request));
    const ranked = listings
      .map((e, i) => ({ e, i, score: scoreForRoster(e, roster) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, count ?? 3)
      .map((x) => x.e);
    return ranked;
  });

  app.get("/colleges", { preHandler: [...counselor, limit("events:colleges", 60, 60)] }, async (request) => {
    const feed = await buildFeed(request);
    const counts = new Map<string, { college: CollegeRef; count: number }>();
    for (const f of feed) {
      const c = f.item.college;
      if (!c) continue;
      const entry = counts.get(c.id) ?? { college: c, count: 0 };
      entry.count += 1;
      counts.set(c.id, entry);
    }
    return [...counts.values()]
      .map(({ college, count }) => ({ value: college.id, label: college.shortName, slug: college.slug, count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  // ---- Saves ---------------------------------------------------------------------

  app.get("/saved", { preHandler: [...counselor, limit("events:saved", 120, 60)] }, async (request) => {
    const { data, error } = await request.db
      .from("hub_event_saves")
      .select("event_id")
      .eq("profile_id", request.auth.userId)
      .limit(1000);
    if (error) throw fromPostgrest(error);
    const ids = ((data ?? []) as Row[]).map((r) => String(r.event_id));
    if (!ids.length) return [];
    const { data: rows, error: e2 } = await request.db
      .from("hub_events")
      .select(LISTING_COLUMNS)
      .in("id", ids)
      .order("start_date", { ascending: true });
    if (e2) throw fromPostgrest(e2);
    return loadEvents(request, (rows ?? []) as Row[]);
  });

  /**
   * Saved listings sent to the Meridies calendar, overlapping [from, to], as
   * Calendar items. The Calendar (calendar-files-axis) merges these with
   * GET /calendar/feed and applies type reassignments keyed (event, id).
   */
  app.get("/calendar", { preHandler: [...counselor, limit("events:calendar", 240, 60)] }, async (request) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(request.query);
    const { data, error } = await request.db
      .from("hub_event_saves")
      .select("event_id, targets")
      .eq("profile_id", request.auth.userId)
      .contains("targets", ["meridies"])
      .limit(1000);
    if (error) throw fromPostgrest(error);
    const ids = ((data ?? []) as Row[]).map((r) => String(r.event_id));
    if (!ids.length) return [];

    let builder = request.db.from("hub_events").select(LISTING_COLUMNS).in("id", ids);
    if (q.to) builder = builder.lte("start_date", q.to);
    const { data: rows, error: e2 } = await builder.order("start_date", { ascending: true });
    if (e2) throw fromPostgrest(e2);
    const inRange = ((rows ?? []) as Row[]).filter(
      (r) => !q.from || String(r.end_date ?? r.start_date) >= q.from
    );
    return (await loadEvents(request, inRange)).map(toCalendarItem);
  });

  app.put("/:id/save", { preHandler: [...counselor, limit("events:save", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({
        targets: z.array(z.enum(CALENDAR_TARGETS)).min(1).max(4),
        reminder: z.enum(REMINDERS).optional(),
      })
      .strict()
      .parse(request.body);

    const { data: listing, error: e1 } = await request.db.from("hub_events").select("id").eq("id", id).maybeSingle();
    if (e1) throw fromPostgrest(e1);
    if (!listing) throw notFound("That event isn't in the hub");

    const { data, error } = await request.db
      .from("hub_event_saves")
      .upsert(
        {
          profile_id: request.auth.userId,
          event_id: id,
          targets: [...new Set(b.targets)],
          reminder: b.reminder ?? "none",
          saved_at: new Date().toISOString(),
        },
        { onConflict: "profile_id,event_id" }
      )
      .select("*")
      .single();
    if (error) throw fromPostgrest(error);
    return toSave(data as Row);
  });

  app.delete("/:id/save", { preHandler: [...counselor, limit("events:unsave", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { error } = await request.db
      .from("hub_event_saves")
      .delete()
      .eq("profile_id", request.auth.userId)
      .eq("event_id", id);
    if (error) throw fromPostgrest(error);
    return { deleted: true };
  });

  // ---- Listings --------------------------------------------------------------------

  app.get("/:id", { preHandler: counselor }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db.from("hub_events").select(LISTING_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That event isn't in the hub");
    return (await loadEvents(request, [data as Row]))[0];
  });

  app.post("/", { preHandler: [...counselor, limit("events:create", 60, 60)] }, async (request, reply) => {
    const b = eventBody.parse(request.body);
    checkTimes(b);
    const share = b.share ?? (request.profile.firm_id ? "firm" : "me");
    if (share === "firm" && !request.profile.firm_id) throw badRequest("You aren't in a firm, so share it with yourself");

    const { data, error } = await request.db
      .from("hub_events")
      .insert({
        ...eventRow(b),
        created_by: request.auth.userId,
        firm_id: share === "firm" ? request.profile.firm_id : null,
      })
      .select(LISTING_COLUMNS)
      .single();
    if (error) throw fromPostgrest(error);
    return reply.code(201).send((await loadEvents(request, [data as Row]))[0]);
  });

  app.patch("/:id", { preHandler: [...counselor, limit("events:update", 120, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = eventBody.partial().parse(request.body);

    const { data: existing, error: e1 } = await request.db.from("hub_events").select("*").eq("id", id).maybeSingle();
    if (e1) throw fromPostgrest(e1);
    if (!existing || existing.created_by !== request.auth.userId) throw notFound("That event isn't yours to edit");

    checkTimes({
      startDate: b.startDate ?? String(existing.start_date),
      endDate: b.endDate !== undefined ? b.endDate : (existing.end_date as string | null),
      startTime: b.startTime !== undefined ? b.startTime : ((existing.start_time as string | null)?.slice(0, 5) ?? null),
      endTime: b.endTime !== undefined ? b.endTime : ((existing.end_time as string | null)?.slice(0, 5) ?? null),
      timeZone: b.timeZone,
    });

    const update = eventRow(b);
    if (b.share !== undefined) {
      if (b.share === "firm" && !request.profile.firm_id) throw badRequest("You aren't in a firm");
      update.firm_id = b.share === "firm" ? request.profile.firm_id : null;
    }

    const { data, error } = await request.db
      .from("hub_events")
      .update(update)
      .eq("id", id)
      .select(LISTING_COLUMNS)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound();
    return (await loadEvents(request, [data as Row]))[0];
  });

  app.delete("/:id", { preHandler: [...counselor, limit("events:delete", 60, 60)] }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("hub_events")
      .delete()
      .eq("id", id)
      .eq("created_by", request.auth.userId)
      .select("id");
    if (error) throw fromPostgrest(error);
    if (!data || data.length === 0) throw notFound("That event isn't yours to delete");
    return { deleted: true };
  });
}
