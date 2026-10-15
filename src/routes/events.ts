/**
 * Events Hub (Demo v8; one feed under its search since v9).
 *
 *   GET    /events                 the feed: upcoming listings, then updates
 *   GET    /events/recommended     three listings, ranked against the roster
 *   GET    /events/colleges        Filter by college: schools the feed has items
 *                                  from, and the roster's most-listed schools
 *   POST   /events/discover        find one college's upcoming events on its
 *                                  own site now (lib/eventsDiscovery.ts)
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
 * Counselor-only (students read theirs at /me/events). Listings are real rows:
 * a counselor's, a curator's CSV, or found on a college's own site by the
 * discovery job; the demo's authored listings are not seeded. Updates are `policy_updates`, the catalog's published changes.
 * Google / Outlook / .ics are built by the client from the listing — nothing
 * here touches a connected calendar.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadCollegePhotos } from "../lib/collegePhotos.js";
import { badRequest, fromPostgrest, notFound, unavailable } from "../lib/errors.js";
import { hasAnthropic } from "../env.js";
import { runWebResearch } from "../lib/anthropic.js";
import { DISCOVERY_MODEL, DISCOVERY_SYSTEM, blockedDomains, discoverForCollege, lookUpSoon, needsLookup } from "../lib/eventsDiscovery.js";
import { collegesOnLists, listRowsFor, rankColleges } from "../lib/rosterColleges.js";
import { serviceClient } from "../lib/supabase.js";
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
  const [{ data, error }, photos] = await Promise.all([
    request.db.from("colleges").select("id, slug, name, aka").in("id", unique),
    loadCollegePhotos(request.db, unique, request.log),
  ]);
  if (error) throw fromPostgrest(error);
  return new Map(((data ?? []) as Row[]).map((r) => [String(r.id), toCollegeRef(r, photos)]));
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

/** The caller's students and the colleges on their lists (lib/rosterColleges.ts). */
async function rosterOf(request: FastifyRequest) {
  const { data: students, error } = await request.db
    .from("profiles")
    .select("id, grad_year")
    .eq("role", "student")
    .eq("counselor_id", request.auth.userId)
    .limit(2000);
  if (error) throw fromPostgrest(error);
  const rows = (students ?? []) as Row[];
  const listRows = await listRowsFor(request.db, rows.map((s) => String(s.id)));
  const byCollege = await collegesOnLists(request.db, listRows);
  const senior = String(seniorClassYear());
  return {
    byCollege,
    collegeIds: new Set(byCollege.keys()),
    hasSeniors: rows.some((s) => String(s.grad_year ?? "") === senior),
    hasUc: listRows.some((r) => /^(uc |university of california)/i.test(String(r.name ?? ""))),
  };
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

    // The caller's own roster and its lists; a typed school name counts too.
    const roster = await rosterOf(request);

    const listings = await loadEvents(request, await upcomingRows(request));
    const ranked = listings
      .map((e, i) => ({ e, i, score: scoreForRoster(e, roster) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, count ?? 3)
      .map((x) => x.e);
    return ranked;
  });

  /**
   * Filter by college: every school the feed has items from, plus the roster's
   * 30 most-listed schools even before they have events, so "Refresh events"
   * can be asked of them. `onRoster` marks the latter.
   */
  app.get("/colleges", { preHandler: [...counselor, limit("events:colleges", 60, 60)] }, async (request) => {
    const [feed, roster] = await Promise.all([buildFeed(request), rosterOf(request)]);
    const top = rankColleges(roster.byCollege, 30);
    const counts = new Map<string, { college: CollegeRef; count: number }>();
    for (const f of feed) {
      const c = f.item.college;
      if (!c) continue;
      const entry = counts.get(c.id) ?? { college: c, count: 0 };
      entry.count += 1;
      counts.set(c.id, entry);
    }
    const missing = top.filter((id) => !counts.has(id));
    for (const [id, college] of await collegesById(request, missing)) counts.set(id, { college, count: 0 });
    const onRoster = new Set(top);

    // The roster's most-listed schools nobody has looked up this week: look
    // three up now, in the background (lib/eventsDiscovery.ts lookUpSoon).
    let lookingUp = new Set<string>();
    if (top.length) {
      const { data: tops, error: e3 } = await request.db
        .from("colleges")
        .select("id, name, website, visit_url_checked_at")
        .in("id", top);
      if (e3) throw fromPostgrest(e3);
      const rank = new Map(top.map((id, i) => [id, i]));
      const stale = ((tops ?? []) as Row[])
        .filter((r) => needsLookup(r.visit_url_checked_at as string | null))
        .sort((a, b) => (rank.get(String(a.id)) ?? 0) - (rank.get(String(b.id)) ?? 0))
        .slice(0, 3)
        .map((r) => ({ id: String(r.id), name: String(r.name), website: (r.website as string | null) ?? null }));
      lookingUp = new Set(lookUpSoon(stale, request.log).map((c) => c.id));
    }
    return [...counts.values()]
      .map(({ college, count }) => ({
        value: college.id,
        label: college.shortName,
        slug: college.slug,
        count,
        onRoster: onRoster.has(college.id),
        /** Being looked up on its site right now. */
        lookingUp: lookingUp.has(college.id),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  /**
   * Refresh events: find one college's upcoming events on its own site now,
   * on the caller's AI quota. Answers what changed; the feed shows the rows.
   */
  app.post("/discover", { preHandler: [...counselor, limit("events:discover", 10, 3600)] }, async (request) => {
    const { collegeId } = z.object({ collegeId: z.string().uuid() }).strict().parse(request.body);
    if (!hasAnthropic) throw unavailable("Event search isn't set up on this server yet.");
    const svc = serviceClient();
    if (!svc) throw unavailable("Event search needs the service role key.");

    const { data: college, error } = await request.db
      .from("colleges")
      .select("id, name, website")
      .eq("id", collegeId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!college) throw notFound("That college isn't in the catalog");
    if (!college.website) throw badRequest(`We don't have ${college.name}'s website on file, so there's nowhere to look.`);

    const outcome = await discoverForCollege(
      svc,
      { id: String(college.id), name: String(college.name), website: String(college.website) },
      {
        research: ({ domains, question }) =>
          runWebResearch({ request, module: "events-discovery", question, domains, system: DISCOVERY_SYSTEM, maxSearches: 4, model: DISCOVERY_MODEL }),
        blocked: await blockedDomains(svc),
        log: request.log,
      }
    );
    if (outcome.error && outcome.kept === 0) throw unavailable(`Couldn't look up ${college.name}'s events: ${outcome.error}.`);
    return { college: { id: String(college.id), name: String(college.name) }, ...outcome };
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
