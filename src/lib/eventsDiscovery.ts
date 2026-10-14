/**
 * Events Hub discovery: a college's upcoming events for prospective students
 * (info sessions, campus tours, virtual visits, open houses, webinars), found
 * on that college's own website and kept only when they check out.
 *
 * Who runs it:
 *   - weekly, POST /internal/events/discover (CRON_SECRET): the colleges most
 *     listed across every roster, under a lease and a system budget;
 *   - on demand, POST /events/discover { collegeId }: one college, from the
 *     Events Hub, on the counselor's own AI quota.
 *
 * What it keeps. Cited research restricted to the college's own site (and
 * the few visit platforms colleges embed) returns candidates as JSON; a
 * candidate stays only if:
 *   - every field validates (a known kind, a real date between today and six
 *     months out, a recognised time zone, an http(s) sign-up link);
 *   - the sign-up link is on the college's site or an allowed platform;
 *   - the run actually searched or fetched that page, the page isn't on the
 *     research blocklist, and the link still answers (keepCandidates);
 * The model never writes to the database; this code does, as service role.
 *
 * It also keeps the college's visit page (where a prospective student signs
 * up for a tour or a session), checked the same way, on colleges.visit_url:
 * many colleges load tour dates with script, so a run can find the page but
 * no dates, and the student's "Plan a visit" still has somewhere to go.
 *
 * Undergraduate admissions only: graduate, professional and certificate
 * programs' sessions are refused in the prompt and again in code.
 *
 * Where it lands. Meridies-wide hub_events rows, source "discovered",
 * audience "everyone" (counselors and students see them), matched on the CSV
 * loader's natural key (name, host, start date). Host is the college's name,
 * so a later run finds the same row. A CSV or hand-entered row with the same
 * key is never overwritten. Nothing is deleted: a past event drops out of the
 * feed on its own.
 *
 * Nothing about any student goes into a prompt: the college's name and site
 * are the whole input.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { env, hasAnthropic } from "../env.js";
import { runSystemResearch, type ResearchResult } from "./anthropic.js";
import { EVENT_KINDS, isTimeZone, todayIn, type EventKind } from "./eventsHub.js";
import { eventKey } from "./ingest/events.js";
import { beat } from "./heartbeat.js";
import { checkLink } from "./links.js";
import { consumeQuota } from "./limits.js";
import { isBlocked, keepCandidates } from "./research/citations.js";
import { collegesOnLists, listRowsFor, rankColleges, type ListRow } from "./rosterColleges.js";
import { serviceClient } from "./supabase.js";

type Row = Record<string, unknown>;
type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/** Kinds a college runs for prospective students. Conferences are found by people, not here. */
export const DISCOVERED_KINDS = EVENT_KINDS.filter((k) => k !== "conference");

/**
 * Visit platforms colleges embed for tours and sessions, besides their own
 * site (bare hostnames, subdomains included). Reviewed: add only a platform
 * that hosts colleges' own official pages.
 */
export const EVENT_PLATFORMS = ["youvisit.com"] as const;

/**
 * Colleges whose undergraduate admissions office runs on its own domain,
 * keyed by the catalog site's host. Reviewed by hand: add one only for the
 * college's official admissions site.
 */
export const ADMISSIONS_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "mit.edu": ["mitadmissions.org"],
};

/** Sessions for a graduate, professional or certificate program, not a first-year applicant. */
const NOT_UNDERGRADUATE =
  /\b(graduate|grad school|master'?s?|m\.?s\.?\b|mba|ph\.?d|doctoral|doctorate|certificate|executive|law school|medical school|j\.?d\b|m\.?d\b|postdoc|alumni|admitted students?|transfer)\b/i;

/** How far ahead a listing may be. */
const HORIZON_DAYS = 183;
/** Per college per run. */
const MAX_PER_COLLEGE = 12;
/** The system budget: research calls per month, across every college (weekly job and background lookups). */
const SYSTEM_MONTHLY_CALLS = 2000;

/**
 * Finding a college's events on its own site doesn't need the research
 * model: Sonnet at a fraction of the cost, so every college students list
 * (and the ones like them) can be covered.
 */
export const DISCOVERY_MODEL = "claude-sonnet-5-5";
/** The quota subject for runs nobody started (consume_quota keys on a uuid). */
const SYSTEM_SUBJECT = "00000000-0000-0000-0000-00000000e7e1";

export type DiscoveryCollege = { id: string; name: string; website: string | null };

/** The college's own host, bare (no www.), or null when the catalog has no usable site. */
export function collegeHost(website: string | null): string | null {
  if (!website) return null;
  try {
    const h = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, "");
    return h.includes(".") && /^[a-z0-9.-]+$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** The college's own hosts: its site, and a separate admissions site when it has one. */
export function collegeHosts(host: string): string[] {
  return [host, ...(ADMISSIONS_HOSTS[host] ?? [])];
}

/** Where research may look for this college: its sites and the allowed platforms. */
export function discoveryDomains(host: string): string[] {
  return [...collegeHosts(host), ...EVENT_PLATFORMS];
}

/** A link on the college's sites (any subdomain) or an allowed platform. */
export function onCollegeSite(url: string, host: string): boolean {
  let h: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    h = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return discoveryDomains(host).some((d) => h === d || h.endsWith(`.${d}`));
}

// ---- The prompt -------------------------------------------------------------------

export const DISCOVERY_SYSTEM = [
  "You find upcoming events a college's UNDERGRADUATE admissions office runs for high-school students applying as first-years, and their families.",
  "Use web search and web fetch on the allowed sites only. Report only what you find on a page you retrieved.",
  "Start from the undergraduate admissions office's 'Visit' page.",
  "Wanted: information sessions, campus tours, virtual visits or virtual information sessions, open houses, admissions webinars and workshops, and college fairs the admissions office hosts.",
  "Not wanted: anything for graduate, professional, MBA, PhD, certificate or executive programs; transfer, admitted or enrolled students only; athletics, concerts, lectures, alumni or donor events; anything without a date.",
  "A tour or session offered on many dates: list each date you can see as its own event, at most 12 in all, soonest first.",
  "Never invent a date, time or link. If the dates load only after choosing on a calendar and you can't see them, list no events, but still give the visit page and the offerings.",
  "Offerings: the kinds of visits the office offers whatever the date (a campus tour, an information session, a virtual information session, an open house), as its pages describe them, with the page to sign up on. Only what a page you retrieved says is offered; at most 6.",
  "Answer with one JSON object and nothing after it:",
  '{"visitPage": the URL where a prospective student signs up for a tour or information session, or null, "offerings": [{"kind": "campus-tour"|"info-session"|"virtual-visit"|"open-house"|"webinar"|"workshop", "title": string, "schedule": how often or when, as the page says it, or null, "signUpUrl": the page to sign up on}], "events": [{"title": string, "kind": "info-session"|"campus-tour"|"virtual-visit"|"open-house"|"webinar"|"workshop"|"college-fair", "startDate": "YYYY-MM-DD", "startTime": "HH:MM" or null (24-hour, local to the event), "endTime": "HH:MM" or null, "timeZone": IANA name such as "America/New_York", "place": "Online" or "City, ST", "signUpUrl": the page to register or sign up, "description": one plain sentence under 200 characters}]}',
  'If you find nothing, answer {"visitPage": null, "offerings": [], "events": []}.',
].join("\n");

export function discoveryQuestion(college: DiscoveryCollege, today: string): string {
  return [
    `College: ${college.name}`,
    `Its website: ${college.website ?? "unknown"}`,
    `Today is ${today}. List its upcoming events for prospective students between today and six months from now.`,
  ].join("\n");
}

// ---- Parsing and checking candidates ----------------------------------------------------

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  });

const candidateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  kind: z.enum(DISCOVERED_KINDS as unknown as [EventKind, ...EventKind[]]),
  startDate: isoDate,
  startTime: clock.nullable().optional(),
  endTime: clock.nullable().optional(),
  timeZone: z.string().trim().max(64).refine(isTimeZone),
  place: z.string().trim().min(1).max(200),
  signUpUrl: z.string().trim().url().max(2000),
  description: z.string().trim().max(400).nullable().optional(),
});

export type EventCandidate = z.infer<typeof candidateSchema>;

/** The answer's visit page and events. Malformed or absent: nothing. */
export function parseAnswer(text: string): { visitPage: string | null; offerings: unknown[]; events: unknown[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start && (body.indexOf("[") === -1 || start < body.indexOf("["))) {
    try {
      const parsed: unknown = JSON.parse(body.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const o = parsed as { visitPage?: unknown; events?: unknown };
        return {
          visitPage: typeof o.visitPage === "string" && o.visitPage.trim() ? o.visitPage.trim() : null,
          offerings: Array.isArray((o as { offerings?: unknown }).offerings) ? ((o as { offerings: unknown[] }).offerings) : [],
          events: Array.isArray(o.events) ? o.events : [],
        };
      }
    } catch {
      // fall through to a bare array
    }
  }
  return { visitPage: null, offerings: [], events: parseCandidates(text) };
}

/** A bare JSON array in the answer: the last [...] in the text. Malformed or absent: nothing. */
export function parseCandidates(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The candidates that validate, are on the college's site, and fall between
 * today (in the event's own time zone) and the horizon. De-duplicated on the
 * natural key. Pure: the link checks come after.
 */
export function validCandidates(raw: unknown[], host: string, now = new Date()): EventCandidate[] {
  const out: EventCandidate[] = [];
  const keys = new Set<string>();
  for (const item of raw) {
    const p = candidateSchema.safeParse(item);
    if (!p.success) continue;
    const c = p.data;
    const today = (() => {
      try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: c.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      } catch {
        return now.toISOString().slice(0, 10);
      }
    })();
    if (c.startDate < today || c.startDate > addDays(today, HORIZON_DAYS)) continue;
    if (!onCollegeSite(c.signUpUrl, host)) continue;
    if (NOT_UNDERGRADUATE.test(c.title) || NOT_UNDERGRADUATE.test(c.description ?? "")) continue;
    if (c.endTime && !c.startTime) continue;
    if (c.startTime && c.endTime && c.endTime <= c.startTime) continue;
    const key = `${c.title.trim().toLowerCase()}|${c.startDate}|${c.startTime ?? ""}`;
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(c);
    if (out.length >= MAX_PER_COLLEGE) break;
  }
  return out;
}

const OFFERING_KINDS = ["campus-tour", "info-session", "virtual-visit", "open-house", "webinar", "workshop"] as const;

const offeringSchema = z.object({
  kind: z.enum(OFFERING_KINDS),
  title: z.string().trim().min(3).max(200),
  schedule: z.string().trim().max(200).nullable().optional(),
  signUpUrl: z.string().trim().url().max(2000),
});

export type OfferingCandidate = z.infer<typeof offeringSchema>;

/** Offerings that validate, are on the college's site and are for first-year applicants; one per kind and title, at most 6. */
export function validOfferings(raw: unknown[], host: string): OfferingCandidate[] {
  const out: OfferingCandidate[] = [];
  const keys = new Set<string>();
  for (const item of raw) {
    const p = offeringSchema.safeParse(item);
    if (!p.success) continue;
    const o = p.data;
    if (!onCollegeSite(o.signUpUrl, host)) continue;
    if (NOT_UNDERGRADUATE.test(o.title) || NOT_UNDERGRADUATE.test(o.schedule ?? "")) continue;
    const key = `${o.kind}|${o.title.trim().toLowerCase()}`;
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(o);
    if (out.length >= 6) break;
  }
  return out;
}

/** The text of the answer, every part in order. */
export function answerText(result: Pick<ResearchResult, "parts">): string {
  return result.parts.map((p) => p.text).join("\n");
}

/** A tour offered on several dates shares one name; the date and time make each row its own. */
export function listingName(c: EventCandidate): string {
  return c.title.trim().replace(/\s+/g, " ").slice(0, 200);
}

// ---- One college ----------------------------------------------------------------------

export type ResearchFn = (args: { college: DiscoveryCollege; domains: string[]; question: string }) => Promise<ResearchResult>;

export type CollegeOutcome = {
  collegeId: string;
  /** The visit page kept on the college, when one checked out. */
  visitUrl: string | null;
  /** Offerings kept on the college (dates not listed). */
  offerings: number;
  found: number;
  kept: number;
  inserted: number;
  updated: number;
  skipped: number;
  error: string | null;
};

/**
 * Find, check and store one college's events. Never throws: a college that
 * fails is an outcome with an error, and the run goes on to the next.
 */
export async function discoverForCollege(
  svc: SupabaseClient,
  college: DiscoveryCollege,
  deps: { research: ResearchFn; check?: typeof checkLink; blocked: string[]; now?: Date; log: Log }
): Promise<CollegeOutcome> {
  const outcome: CollegeOutcome = { collegeId: college.id, visitUrl: null, offerings: 0, found: 0, kept: 0, inserted: 0, updated: 0, skipped: 0, error: null };
  const host = collegeHost(college.website);
  if (!host) return { ...outcome, error: "no website on file" };
  if (isBlocked(`https://${host}/`, deps.blocked)) return { ...outcome, error: "site is on the research blocklist" };

  try {
    const now = deps.now ?? new Date();
    const result = await deps.research({
      college,
      domains: discoveryDomains(host),
      question: discoveryQuestion(college, todayIn("America/New_York")),
    });
    if (result.refused) return { ...outcome, error: "research refused" };

    // Looked up: visit_url_checked_at doubles as "last looked up", so the
    // automatic lookup (lookUpSoon) leaves this college alone for a week
    // whether or not anything turned up.
    {
      const { error: e } = await svc.from("colleges").update({ visit_url_checked_at: new Date().toISOString() }).eq("id", college.id);
      if (e) throw new Error(`colleges update: ${e.message}`);
    }

    const answer = parseAnswer(answerText(result));
    const raw = answer.events;
    outcome.found = raw.length;

    // The visit page: on the college's site, seen in this run, not blocked, and answering.
    if (answer.visitPage && onCollegeSite(answer.visitPage, host)) {
      const [page] = await keepCandidates(
        [{ title: "visit", summary: "", sources: [{ url: answer.visitPage, title: null }] }],
        { seenUrls: result.seenUrls },
        deps.blocked,
        deps.check ?? checkLink
      );
      if (page) {
        const { error: e } = await svc
          .from("colleges")
          .update({ visit_url: page.sources[0].url, visit_url_checked_at: page.checkedAt })
          .eq("id", college.id);
        if (e) throw new Error(`colleges update: ${e.message}`);
        outcome.visitUrl = page.sources[0].url;
      }
    }

    // Offerings: checked like everything else, then they replace the college's
    // previous ones (what its site offers now).
    const offerings = await keepCandidates(
      validOfferings(answer.offerings, host).map((o) => ({ ...o, summary: "", sources: [{ url: o.signUpUrl, title: null }] })),
      { seenUrls: result.seenUrls },
      deps.blocked,
      deps.check ?? checkLink
    );
    {
      const { error: delError } = await svc.from("college_visit_offerings").delete().eq("college_id", college.id);
      if (delError) throw new Error(`offerings delete: ${delError.message}`);
      if (offerings.length) {
        const { error: insError } = await svc.from("college_visit_offerings").insert(
          offerings.map((o) => ({
            college_id: college.id,
            kind: o.kind,
            title: o.title.replace(/\s+/g, " ").slice(0, 200),
            schedule: o.schedule ?? null,
            url: o.signUpUrl,
            source_url: o.sources[0]?.url ?? o.signUpUrl,
            checked_at: o.checkedAt,
          }))
        );
        if (insError) throw new Error(`offerings insert: ${insError.message}`);
      }
      outcome.offerings = offerings.length;
    }

    const valid = validCandidates(raw, host, now);
    const kept = await keepCandidates(
      valid.map((c) => ({ ...c, summary: c.description ?? "", sources: [{ url: c.signUpUrl, title: null }] })),
      { seenUrls: result.seenUrls },
      deps.blocked,
      deps.check ?? checkLink
    );
    outcome.kept = kept.length;
    if (!kept.length) return outcome;

    // This college's Meridies-wide rows, keyed as the CSV loader keys them.
    const { data: existing, error } = await svc
      .from("hub_events")
      .select("id, name, host, start_date, source")
      .is("created_by", null)
      .is("firm_id", null)
      .eq("college_id", college.id)
      .limit(1000);
    if (error) throw new Error(`hub_events read: ${error.message}`);
    const byKey = new Map(((existing ?? []) as Row[]).map((r) => [eventKey(String(r.name), String(r.host), String(r.start_date)), r]));

    for (const c of kept) {
      const name = listingName(c);
      const row = {
        name,
        kind: c.kind,
        host: college.name,
        start_date: c.startDate,
        end_date: null,
        start_time: c.startTime ?? null,
        end_time: c.startTime ? (c.endTime ?? null) : null,
        time_zone: c.timeZone,
        place: c.place,
        url: c.signUpUrl,
        description: c.description ?? null,
        college_id: college.id,
        audience: "everyone",
        source: "discovered",
        source_url: c.sources[0]?.url ?? c.signUpUrl,
        last_verified_at: c.checkedAt,
      };
      const match = byKey.get(eventKey(name, college.name, c.startDate));
      if (match && match.source !== "discovered") {
        // A curator's or a counselor's row wins; only note that the link still answers.
        outcome.skipped += 1;
        continue;
      }
      if (match) {
        const { error: e } = await svc.from("hub_events").update(row).eq("id", String(match.id));
        if (e) throw new Error(`hub_events update: ${e.message}`);
        outcome.updated += 1;
      } else {
        const { error: e } = await svc.from("hub_events").insert(row);
        // A unique-key race with another run is the same event; count it as skipped.
        if (e && e.code !== "23505") throw new Error(`hub_events insert: ${e.message}`);
        if (e) outcome.skipped += 1;
        else outcome.inserted += 1;
      }
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    deps.log.error({ collegeId: college.id, err: message }, "events discovery: college failed");
    return { ...outcome, error: message.slice(0, 300) };
  }
}

// ---- Looking a college up when someone lists it ------------------------------------------

/** A college looked up within this long isn't looked up again on its own. */
export const LOOKUP_FRESH_DAYS = 7;
/** Per instance: a college asked about recently isn't asked again, whatever happened. */
const RETRY_AFTER_MS = 6 * 3600 * 1000;
/** At most this many lookups at a time per instance. */
const MAX_IN_FLIGHT = 3;

const attempted = new Map<string, number>();
let inFlight = 0;
const queue: DiscoveryCollege[] = [];

/** Never looked up, or not in the last week. */
export function needsLookup(checkedAt: string | null | undefined, now = Date.now()): boolean {
  if (!checkedAt) return true;
  return now - Date.parse(checkedAt) > LOOKUP_FRESH_DAYS * 86_400_000;
}

/**
 * Look these colleges up in the background: a student just listed one, or a
 * counselor's roster has one nobody has looked up this week. Returns the ones
 * that are being looked up now (queued or running), so the page can say so.
 * Runs on the weekly job's system budget; never blocks the request.
 */
export function lookUpSoon(colleges: DiscoveryCollege[], log: Log): DiscoveryCollege[] {
  const svc = serviceClient();
  if (!svc || !hasAnthropic) return [];
  const now = Date.now();
  const started: DiscoveryCollege[] = [];
  for (const c of colleges) {
    if (!collegeHost(c.website)) continue;
    const last = attempted.get(c.id);
    if (last !== undefined && now - last < RETRY_AFTER_MS) {
      // Already asked for: say so while it's still queued or running.
      if (queue.some((q) => q.id === c.id) || last > now - 5 * 60_000) started.push(c);
      continue;
    }
    attempted.set(c.id, now);
    queue.push(c);
    started.push(c);
  }
  drain(svc, log);
  return started;
}

function drain(svc: SupabaseClient, log: Log) {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const college = queue.shift()!;
    inFlight += 1;
    void (async () => {
      try {
        const blocked = await blockedDomains(svc);
        const o = await discoverForCollege(svc, college, { research: systemResearch(log), blocked, log });
        log.info({ ...o }, "events discovery: looked a college up");
      } catch (err) {
        log.error({ collegeId: college.id, err: err instanceof Error ? err.message : "unknown" }, "events discovery: lookup failed");
      } finally {
        inFlight -= 1;
        drain(svc, log);
      }
    })();
  }
}

// ---- The weekly run ----------------------------------------------------------------------

/** The colleges most listed across every roster: students who have a counselor. */
export async function topRosterColleges(svc: SupabaseClient, max: number): Promise<DiscoveryCollege[]> {
  const studentIds: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from("profiles")
      .select("id")
      .eq("role", "student")
      .not("counselor_id", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`profiles: ${error.message}`);
    studentIds.push(...((data ?? []) as Row[]).map((r) => String(r.id)));
    if (!data || data.length < 1000 || studentIds.length >= 20_000) break;
  }
  const rows: ListRow[] = await listRowsFor(svc, studentIds);
  const ids = rankColleges(await collegesOnLists(svc, rows), max);
  if (!ids.length) return [];
  const { data, error } = await svc.from("colleges").select("id, name, website").in("id", ids);
  if (error) throw new Error(`colleges: ${error.message}`);
  const byId = new Map(((data ?? []) as Row[]).map((r) => [String(r.id), r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is Row => Boolean(r))
    .map((r) => ({ id: String(r.id), name: String(r.name), website: (r.website as string | null) ?? null }));
}

export async function blockedDomains(svc: SupabaseClient): Promise<string[]> {
  const { data, error } = await svc.from("research_blocked_domains").select("domain");
  if (error) throw new Error(`research_blocked_domains: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => String(r.domain));
}

/** The weekly job's research: no user, the system budget, the discovery prompt. */
export function systemResearch(log: Log): ResearchFn {
  return async ({ domains, question }) => {
    const allowed = await consumeQuota(SYSTEM_SUBJECT, "ai_calls", "month", SYSTEM_MONTHLY_CALLS);
    if (!allowed) throw new Error("the monthly discovery budget is spent");
    return runSystemResearch(
      { module: "events-discovery", question, domains, system: DISCOVERY_SYSTEM, maxSearches: 4, model: DISCOVERY_MODEL },
      log
    );
  };
}

export type DiscoveryRun = {
  status: "succeeded" | "partial" | "failed";
  colleges: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export async function runEventsDiscovery(
  svc: SupabaseClient,
  log: Log,
  opts: { trigger: "manual" | "cron" | "script"; max?: number; research?: ResearchFn; check?: typeof checkLink }
): Promise<DiscoveryRun> {
  const startedAt = Date.now();
  const { data: run } = await svc
    .from("ingest_runs")
    .insert({ source: "events-discovery", trigger: opts.trigger, status: "running" })
    .select("id")
    .single();
  const runId = (run?.id as string | undefined) ?? null;

  const result: DiscoveryRun = { status: "succeeded", colleges: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
  try {
    const [colleges, blocked] = await Promise.all([
      topRosterColleges(svc, opts.max ?? env.EVENTS_DISCOVERY_COLLEGES ?? 30),
      blockedDomains(svc),
    ]);
    const research = opts.research ?? systemResearch(log);
    for (const college of colleges) {
      const o = await discoverForCollege(svc, college, { research, check: opts.check, blocked, log });
      result.colleges += 1;
      result.inserted += o.inserted;
      result.updated += o.updated;
      result.skipped += o.skipped;
      if (o.error) result.errors.push(`${college.name}: ${o.error}`);
      // A spent budget stops the run; the rest wait for next week.
      if (o.error?.includes("budget")) break;
    }
    if (result.errors.length) result.status = result.errors.length >= result.colleges && result.colleges > 0 ? "failed" : "partial";
  } catch (err) {
    result.status = "failed";
    result.errors.push(err instanceof Error ? err.message : "unknown error");
  }

  if (runId) {
    await svc
      .from("ingest_runs")
      .update({
        status: result.status,
        rows_upserted: result.inserted + result.updated,
        rows_skipped: result.skipped,
        errors: result.errors.slice(0, 50),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      })
      .eq("id", runId);
  }
  return result;
}

// ---- Starting it outside a request (lib/ingest/run.ts's pattern) ----------------------------

const LEASE = "events-discovery";
/** Thirty colleges at a minute or two each, with room to spare. */
const LEASE_TTL_SECONDS = 2 * 60 * 60;

export type StartResult =
  | { started: true; done: Promise<DiscoveryRun | null> }
  | { started: false; reason: "no-key" | "no-service-role" | "locked" | "lease-error" };

export async function startEventsDiscovery(log: Log, trigger: "manual" | "cron" | "script"): Promise<StartResult> {
  if (!hasAnthropic) return { started: false, reason: "no-key" };
  const svc = serviceClient();
  if (!svc) return { started: false, reason: "no-service-role" };

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error } = await svc.rpc("acquire_job_lease", { p_name: LEASE, p_holder: holder, p_ttl_seconds: LEASE_TTL_SECONDS });
  if (error) {
    log.error({ code: error.code }, "events discovery: lease unavailable");
    return { started: false, reason: "lease-error" };
  }
  if (!acquired) return { started: false, reason: "locked" };

  const done = runEventsDiscovery(svc, log, { trigger })
    .then(async (r) => {
      log.info({ ...r, errors: r.errors.length }, "events discovery: finished");
      await beat("events-discovery", r.status !== "failed", r.errors[0], log);
      return r;
    })
    .catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : "unknown" }, "events discovery: crashed");
      return null;
    })
    .finally(async () => {
      await svc.rpc("release_job_lease", { p_name: LEASE, p_holder: holder });
    });
  return { started: true, done };
}
