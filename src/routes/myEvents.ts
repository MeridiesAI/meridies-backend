/**
 * The student's Events tab: what colleges run for prospective students.
 *
 *   GET    /me/events               { forYourColleges, more, visitPages }: upcoming
 *                                   listings meant for students, the colleges on
 *                                   the student's own list first, and each listed
 *                                   college's visit page ("Plan a visit")
 *   GET    /me/events/calendar      saves sent to the Meridies calendar, as
 *                                   Calendar items (the student Calendar merges them)
 *   PUT    /me/events/:id/save      Add to Calendar (targets + reminder)
 *   DELETE /me/events/:id/save
 *
 * "Me" is the caller's JWT. A student reads only Meridies-wide listings whose
 * audience is student or everyone; RLS (hub_events_select_student) says the
 * same, so a counselor-only row never reaches this code. The card's button
 * opens the college's own sign-up page (`url`); nothing here signs anyone up.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  CALENDAR_TARGETS,
  EVENT_KIND_LABEL,
  REMINDERS,
  STUDENT_KINDS,
  forStudents,
  isUpcoming,
  toCalendarItem,
  toCollegeRef,
  toHubEvent,
  toSave,
  type CollegeRef,
  type HubEvent,
  type SavedState,
} from "../lib/eventsHub.js";
import { collegesOnLists, listRowsFor } from "../lib/rosterColleges.js";
import { cleanSchedule, lookUpSoon, needsLookup } from "../lib/eventsDiscovery.js";
import { similarColleges } from "../lib/similarColleges.js";

type Row = Record<string, unknown>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

async function hydrate(request: FastifyRequest, rows: Row[]): Promise<HubEvent[]> {
  const collegeIds = [...new Set(rows.map((r) => String(r.college_id ?? "")).filter(Boolean))];
  const eventIds = rows.map((r) => String(r.id));
  const [colleges, saves] = await Promise.all([
    collegeIds.length
      ? request.db.from("colleges").select("id, slug, name, aka").in("id", collegeIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? request.db.from("hub_event_saves").select("*").eq("profile_id", request.auth.userId).in("event_id", eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (colleges.error) throw fromPostgrest(colleges.error);
  if (saves.error) throw fromPostgrest(saves.error);
  const byCollege = new Map<string, CollegeRef>(((colleges.data ?? []) as Row[]).map((r) => [String(r.id), toCollegeRef(r)]));
  const bySave = new Map<string, SavedState>(((saves.data ?? []) as Row[]).map((r) => [String(r.event_id), toSave(r)]));
  return rows.map((r) =>
    toHubEvent(r, request.auth.userId, r.college_id ? (byCollege.get(String(r.college_id)) ?? null) : null, bySave.get(String(r.id)) ?? null)
  );
}

/** Upcoming listings this student may see, earliest first. */
async function studentRows(request: FastifyRequest): Promise<Row[]> {
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await request.db
    .from("hub_events")
    .select("*")
    .is("created_by", null)
    .is("firm_id", null)
    .in("audience", ["student", "everyone"])
    .or(`start_date.gte.${since},end_date.gte.${since}`)
    .order("start_date", { ascending: true })
    .order("start_time", { ascending: true, nullsFirst: true })
    .limit(500);
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as Row[]).filter((r) => forStudents(r) && isUpcoming(r));
}

/** A college_visit_offerings row as a card: dates on the college's own site. */
function toOffering(r: Row, college: CollegeRef | null) {
  const kind = String(r.kind);
  return {
    id: String(r.id),
    collegeId: String(r.college_id),
    college,
    kind,
    kindLabel: (EVENT_KIND_LABEL as Record<string, string>)[kind] ?? kind,
    title: String(r.title),
    schedule: cleanSchedule(r.schedule as string | null),
    url: String(r.url),
    checkedAt: String(r.checked_at),
    cta: kind === "campus-tour" || kind === "open-house" ? "Plan a visit" : "Register",
  };
}

function offeringMatches(o: ReturnType<typeof toOffering>, q: string): boolean {
  if (!q) return true;
  return [o.title, o.kindLabel, o.schedule ?? "", o.college?.name ?? "", o.college?.shortName ?? ""].join(" ").toLowerCase().includes(q);
}

function matches(e: HubEvent, q: string): boolean {
  if (!q) return true;
  return [e.name, e.host, e.kindLabel, e.place, e.description ?? "", e.college?.name ?? "", e.college?.shortName ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

export default async function myEventRoutes(app: FastifyInstance) {
  const student = [app.authenticate, requireRole("student")];

  app.get("/", { preHandler: [...student, limit("me:events", 120, 60)] }, async (request) => {
    const q = z
      .object({
        q: z.string().trim().max(120).optional(),
        kind: z.enum(["all", ...STUDENT_KINDS] as [string, ...string[]]).optional(),
      })
      .parse(request.query);

    const [rows, myList] = await Promise.all([
      studentRows(request),
      listRowsFor(request.db, [request.auth.userId]),
    ]);
    const mine = new Set((await collegesOnLists(request.db, myList)).keys());
    const needle = (q.q ?? "").toLowerCase();
    const events = (await hydrate(request, rows)).filter(
      (e) => (!q.kind || q.kind === "all" || e.kind === q.kind) && matches(e, needle)
    );
    // The colleges the student lists, and up to six like them.
    const similarIds = await similarColleges(request.db, [...mine]);
    const allIds = [...mine, ...similarIds.map((x) => x.id)];

    let visitPages: { college: CollegeRef; url: string; checkedAt: string | null }[] = [];
    let lookingUp: CollegeRef[] = [];
    let offerings: ReturnType<typeof toOffering>[] = [];
    let similar: {
      college: CollegeRef;
      similarTo: CollegeRef | null;
      visitUrl: string | null;
      events: HubEvent[];
      offerings: ReturnType<typeof toOffering>[];
    }[] = [];
    if (allIds.length) {
      const [colleges, offered] = await Promise.all([
        request.db.from("colleges").select("id, slug, name, aka, website, visit_url, visit_url_checked_at").in("id", allIds),
        request.db.from("college_visit_offerings").select("*").in("college_id", allIds).order("kind"),
      ]);
      if (colleges.error) throw fromPostgrest(colleges.error);
      if (offered.error) throw fromPostgrest(offered.error);
      const byId = new Map(((colleges.data ?? []) as Row[]).map((r) => [String(r.id), r]));
      const refOf = (id: string) => (byId.get(id) ? toCollegeRef(byId.get(id)!) : null);
      const allOfferings = ((offered.data ?? []) as Row[])
        .map((r) => toOffering(r, refOf(String(r.college_id))))
        .filter((o) => (!q.kind || q.kind === "all" || o.kind === q.kind) && offeringMatches(o, needle));

      // Each listed college's visit page: somewhere to sign up even when its
      // dates aren't listed.
      visitPages = [...mine]
        .map((id) => byId.get(id))
        .filter((r): r is Row => Boolean(r?.visit_url))
        .map((r) => ({ college: toCollegeRef(r), url: String(r.visit_url), checkedAt: (r.visit_url_checked_at as string | null) ?? null }))
        .sort((a, b) => a.college.shortName.localeCompare(b.college.shortName));
      offerings = allOfferings.filter((o) => mine.has(o.collegeId));

      similar = similarIds
        .map(({ id, similarTo }) => {
          const r = byId.get(id);
          if (!r) return null;
          return {
            college: toCollegeRef(r),
            similarTo: refOf(similarTo),
            visitUrl: (r.visit_url as string | null) ?? null,
            events: events.filter((e) => e.college?.id === id),
            offerings: allOfferings.filter((o) => o.collegeId === id),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Look up, in the background, what nobody has looked up this week: the
      // student's own colleges first (up to four a load), then two similar ones.
      const stale = (ids: string[], n: number) =>
        ids
          .map((id) => byId.get(id))
          .filter((r): r is Row => Boolean(r) && needsLookup(r!.visit_url_checked_at as string | null))
          .slice(0, n)
          .map((r) => ({ id: String(r.id), name: String(r.name), website: (r.website as string | null) ?? null }));
      const started = lookUpSoon([...stale([...mine], 4), ...stale(similarIds.map((x) => x.id), 2)], request.log);
      lookingUp = started.map((c) => refOf(c.id)).filter((x): x is CollegeRef => x !== null);
    }

    const similarSet = new Set(similarIds.map((x) => x.id));
    return {
      forYourColleges: events.filter((e) => e.college && mine.has(e.college.id)),
      /** What the student's colleges offer whose dates aren't listed: a card each, "dates on the college's site". */
      offerings,
      visitPages,
      /** Colleges like the student's, each with its events, offerings and visit page. */
      similar,
      more: events.filter((e) => !e.college || (!mine.has(e.college.id) && !similarSet.has(e.college.id))),
      /** Colleges being looked up right now; their events land in a minute or so. */
      lookingUp,
      /** How many colleges the student has listed, so the page can say "add colleges" when it's none. */
      listedColleges: mine.size,
    };
  });

  app.get("/calendar", { preHandler: [...student, limit("me:events-calendar", 240, 60)] }, async (request) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(request.query);
    const { data, error } = await request.db
      .from("hub_event_saves")
      .select("event_id")
      .eq("profile_id", request.auth.userId)
      .contains("targets", ["meridies"])
      .limit(1000);
    if (error) throw fromPostgrest(error);
    const ids = ((data ?? []) as Row[]).map((r) => String(r.event_id));
    if (!ids.length) return [];
    let builder = request.db.from("hub_events").select("*").in("id", ids);
    if (q.to) builder = builder.lte("start_date", q.to);
    const { data: rows, error: e2 } = await builder.order("start_date", { ascending: true });
    if (e2) throw fromPostgrest(e2);
    const inRange = ((rows ?? []) as Row[]).filter((r) => !q.from || String(r.end_date ?? r.start_date) >= q.from);
    return (await hydrate(request, inRange)).map(toCalendarItem);
  });

  app.put("/:id/save", { preHandler: [...student, limit("me:events-save", 120, 60)] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const b = z
      .object({ targets: z.array(z.enum(CALENDAR_TARGETS)).min(1).max(4), reminder: z.enum(REMINDERS).optional() })
      .strict()
      .parse(request.body);
    const { data: listing, error: e1 } = await request.db.from("hub_events").select("id").eq("id", id).maybeSingle();
    if (e1) throw fromPostgrest(e1);
    if (!listing) throw notFound("That event isn't available");
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

  app.delete("/:id/save", { preHandler: [...student, limit("me:events-unsave", 120, 60)] }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { error } = await request.db.from("hub_event_saves").delete().eq("profile_id", request.auth.userId).eq("event_id", id);
    if (error) throw fromPostgrest(error);
    return { deleted: true };
  });
}
