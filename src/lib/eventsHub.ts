/**
 * Events Hub (Demo v8, one feed since v9): serializers, the feed's filters,
 * the three recommendations from the roster, and the calendar entries a save
 * to the Meridies calendar becomes.
 *
 * Listings are `hub_events` rows a counselor entered, a Meridies curator
 * loaded from a CSV, or the discovery job found on a college's own site
 * (lib/eventsDiscovery.ts); updates are `policy_updates`. Nothing here is
 * authored: an empty table is an empty hub.
 *
 * `audience` says who a listing is for. Students see Meridies-wide listings
 * for students or everyone (a college's info session, tour, open house);
 * counselor-only rows (conferences, a practice's own listings) never reach them.
 */

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? "" : String(v));
const nstr = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

export const EVENT_KINDS = [
  "conference",
  "webinar",
  "workshop",
  "college-fair",
  "info-session",
  "campus-tour",
  "virtual-visit",
  "open-house",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  conference: "Conference",
  webinar: "Webinar",
  workshop: "Workshop",
  "college-fair": "College fair",
  "info-session": "Info session",
  "campus-tour": "Campus tour",
  "virtual-visit": "Virtual visit",
  "open-house": "Open house",
};

/** Kinds a student can go to; a conference is the counselor's. */
export const STUDENT_KINDS = EVENT_KINDS.filter((k) => k !== "conference");

/** The kinds a student plans a visit for; the rest they register for. */
export const VISIT_KINDS: ReadonlySet<EventKind> = new Set(["campus-tour", "open-house"]);

export const AUDIENCES = ["counselor", "student", "everyone"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** A listing a student may see: Meridies-wide and meant for students. RLS says the same. */
export function forStudents(r: Row): boolean {
  return r.created_by == null && r.firm_id == null && (r.audience === "student" || r.audience === "everyone");
}

export const EVENT_TOPICS = ["aid", "essays", "uc", "lists", "practice"] as const;
export const PHOTO_KEYS = ["webinar", "webinar-desk", "conference", "college-fair", "workshop", "lecture-hall"] as const;
export const CALENDAR_TARGETS = ["meridies", "google", "outlook", "apple"] as const;
export const REMINDERS = ["none", "15m", "1h", "1d", "1w"] as const;

export type CollegeRef = { id: string; slug: string; name: string; shortName: string };

export const toCollegeRef = (r: Row): CollegeRef => {
  const aka = arr(r.aka);
  return { id: str(r.id), slug: str(r.slug), name: str(r.name), shortName: aka[0] ?? str(r.name) };
};

/** "16:00:00" -> "16:00". */
const hhmm = (v: unknown): string | null => {
  const s = nstr(v);
  return s ? s.slice(0, 5) : null;
};

// ---- Time zones -------------------------------------------------------------

/** Offset of `tz` from UTC at the given instant, in minutes. */
function offsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** A wall-clock date and time in `tz`, as a UTC ISO instant. */
export function zonedToUtc(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let offset = 0;
  try {
    offset = offsetMinutes(new Date(guess), tz);
    // Second pass settles a guess that landed on the other side of a DST shift.
    offset = offsetMinutes(new Date(guess - offset * 60000), tz);
  } catch {
    offset = 0;
  }
  return new Date(guess - offset * 60000).toISOString();
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date()
  );
}

// ---- Serializers ---------------------------------------------------------------

export type SavedState = { targets: string[]; reminder: string; savedAt: string };

export const toSave = (r: Row): SavedState => ({
  targets: arr(r.targets),
  reminder: str(r.reminder),
  savedAt: str(r.saved_at),
});

export function toHubEvent(r: Row, viewerId: string, college: CollegeRef | null, saved: SavedState | null) {
  const tz = str(r.time_zone) || "America/New_York";
  const startDate = str(r.start_date);
  const endDate = nstr(r.end_date);
  const startTime = hhmm(r.start_time);
  const endTime = hhmm(r.end_time);
  const allDay = startTime === null;
  return {
    id: str(r.id),
    name: str(r.name),
    kind: str(r.kind) as EventKind,
    kindLabel: EVENT_KIND_LABEL[str(r.kind) as EventKind] ?? str(r.kind),
    host: str(r.host),
    startDate,
    endDate,
    startTime,
    endTime,
    timeZone: tz,
    allDay,
    /** UTC instants for a timed event; null for an all-day one. */
    startsAt: allDay ? null : zonedToUtc(startDate, startTime, tz),
    endsAt: allDay || !endTime ? null : zonedToUtc(endDate ?? startDate, endTime, tz),
    place: str(r.place),
    url: str(r.url),
    description: nstr(r.description),
    college,
    photoKey: nstr(r.photo_key),
    topics: arr(r.topics),
    scope: (r.created_by == null && r.firm_id == null ? "meridies" : r.firm_id != null ? "firm" : "mine") as
      | "meridies"
      | "firm"
      | "mine",
    mine: r.created_by === viewerId,
    saved,
    /** Who it is for; students see "student" and "everyone". */
    audience: (AUDIENCES as readonly string[]).includes(str(r.audience)) ? (str(r.audience) as Audience) : "counselor",
    /** Where it came from: typed in, loaded from a CSV, or found on the college's own site. */
    source: (str(r.source) || "manual") as "manual" | "csv" | "discovered",
    /** The page a discovered listing was cited from. */
    sourceUrl: nstr(r.source_url),
    /** When its sign-up link last answered. */
    lastVerifiedAt: nstr(r.last_verified_at),
    /** "Plan a visit" for a tour or open house, "Register" otherwise. */
    cta: (VISIT_KINDS.has(str(r.kind) as EventKind) ? "Plan a visit" : "Register") as "Plan a visit" | "Register",
    createdAt: str(r.created_at),
  };
}

export type HubEvent = ReturnType<typeof toHubEvent>;

/** A policy_updates row as a feed card. */
export function toHubUpdate(r: Row, college: CollegeRef | null) {
  return {
    id: str(r.id),
    title: str(r.title),
    source: nstr(r.institution) ?? college?.name ?? null,
    date: str(r.published_at).slice(0, 10),
    description: nstr(r.summary),
    url: nstr(r.source_url),
    category: str(r.category),
    college,
  };
}

export type HubUpdate = ReturnType<typeof toHubUpdate>;

export type FeedItem = { type: "event"; item: HubEvent } | { type: "update"; item: HubUpdate };

/** Upcoming means it has not finished yet, in its own time zone. */
export function isUpcoming(r: Row): boolean {
  const tz = str(r.time_zone) || "America/New_York";
  const last = nstr(r.end_date) ?? str(r.start_date);
  try {
    return last >= todayIn(tz);
  } catch {
    return last >= new Date().toISOString().slice(0, 10);
  }
}

function feedText(f: FeedItem): string {
  if (f.type === "event") {
    const e = f.item;
    return [e.name, e.host, e.kindLabel, e.place, e.description ?? "", e.college?.name ?? "", e.college?.shortName ?? ""].join(" ");
  }
  const u = f.item;
  return [u.title, u.source ?? "", "update", u.description ?? "", u.college?.name ?? "", u.college?.shortName ?? ""].join(" ");
}

/** Upcoming events by date, then updates newest first, filtered by search, kind and colleges. */
export function filterFeed(
  items: FeedItem[],
  f: { query: string; kind: EventKind | "update" | "all"; colleges: string[] }
): FeedItem[] {
  const needle = f.query.trim().toLowerCase();
  return items.filter(
    (x) =>
      (f.kind === "all" || (x.type === "update" ? f.kind === "update" : x.item.kind === f.kind)) &&
      (!f.colleges.length || (x.item.college !== null && f.colleges.includes(x.item.college.id))) &&
      (!needle || feedText(x).toLowerCase().includes(needle))
  );
}

/**
 * Recommended for this practice, from its roster: sessions run by a college
 * on a student's list come first, then what the season asks for (aid with
 * seniors on the roster, UC essays with a UC on a list), then the rest.
 */
export function scoreForRoster(
  e: HubEvent,
  roster: { collegeIds: Set<string>; hasSeniors: boolean; hasUc: boolean }
): number {
  return (
    (e.college && roster.collegeIds.has(e.college.id) ? 4 : 0) +
    (e.topics.includes("aid") && roster.hasSeniors ? 2 : 0) +
    (e.topics.includes("uc") && roster.hasUc ? 2 : 0) +
    (e.topics.includes("essays") ? 1 : 0) +
    (e.topics.includes("lists") ? 1 : 0)
  );
}

/** The senior class this fall: a fall-2026 cycle's seniors are the class of 2027. */
export function seniorClassYear(now = new Date()): number {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

/**
 * A save to the Meridies calendar as the Calendar reads it: the same shape as
 * calendarFeed's items, kind "event", so the client merges it in one list and
 * applies the counselor's type reassignments (eventKind "event", ref = id).
 */
export function toCalendarItem(e: HubEvent) {
  return {
    id: `event:${e.id}`,
    kind: "event" as const,
    ref: e.id,
    type: "event",
    title: e.name,
    date: e.startDate,
    endDate: e.endDate,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    allDay: e.allDay,
    studentId: null,
    attendeeIds: [] as string[],
    detail: `${e.host} · ${e.place}${e.endDate ? ` · through ${e.endDate}` : ""}`,
    done: false,
    meetingStatus: null,
    taskId: null,
    school: e.college?.name ?? null,
    url: e.url,
  };
}
