/**
 * The counselor's timezone, for every date AxIS computes ("today", "this week", what is overdue).
 *
 * Which zone: the counselor's profiles.timezone when it is a real IANA zone; else the browser's zone, which the
 * app sends with each AxIS request in the X-Timezone header (validated, never written to the profile); else
 * America/New_York. Before this, AxIS used UTC, so after 4pm Pacific it thought it was already tomorrow.
 *
 * Deadlines and task due dates are plain dates in the database (no timezone): they are compared as dates against
 * the counselor's "today", never shifted.
 */
import type { FastifyRequest } from "fastify";

export const DEFAULT_ZONE = "America/New_York";
/** The header the app sends: Intl.DateTimeFormat().resolvedOptions().timeZone. */
export const ZONE_HEADER = "x-timezone";

const DAY = 86_400_000;
// IANA names only ("America/Los_Angeles", "UTC", "Etc/GMT+5"): no offsets, nothing long enough to matter in a prompt.
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** The zone, trimmed, when it is a real IANA zone; null for anything else. */
export function validZone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const z = v.trim();
  if (!z || z.length > 64 || !ZONE_SHAPE.test(z)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

type ZoneSource = { profile?: { timezone?: string | null } | null; headers?: Record<string, string | string[] | undefined> };

/** The counselor's zone for this request: their profile, then the browser's (X-Timezone), then America/New_York. */
export function counselorZone(request: ZoneSource | FastifyRequest): string {
  const r = request as ZoneSource;
  const raw = r.headers?.[ZONE_HEADER];
  return validZone(r.profile?.timezone) ?? validZone(Array.isArray(raw) ? raw[0] : raw) ?? DEFAULT_ZONE;
}

function parts(zone: string, d: Date) {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d)) {
    out[p.type] = p.value;
  }
  return out;
}

/** The calendar date at `d` in `zone`, as YYYY-MM-DD. */
export function dayIn(zone: string, d: Date = new Date()): string {
  const p = parts(zone, d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** A YYYY-MM-DD date `n` days later (or earlier): plain date arithmetic, no zone involved. */
export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** The date `n` days after today in `zone`. */
export function daysFromToday(zone: string, n: number, now: Date = new Date()): string {
  return addDays(dayIn(zone, now), n);
}

/** Today in `zone` as a UTC-midnight Date: for code that does calendar math with getUTC* (lib/axis/dates.ts). */
export function todayAsUtcDate(zone: string, now: Date = new Date()): Date {
  return new Date(`${dayIn(zone, now)}T00:00:00Z`);
}

/** The weekday at `d` in `zone`, e.g. "Thursday". */
export function weekdayIn(zone: string, d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(d);
}

/** The clock time at `d` in `zone`, e.g. "4:35 PM". */
export function timeIn(zone: string, d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(d);
}

/** How far `zone`'s wall clock is ahead of UTC at instant `t`, in ms. */
function offsetMs(zone: string, t: number): number {
  const p = parts(zone, new Date(t));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(t / 1000) * 1000;
}

/** The instant the date `iso` starts in `zone` (local midnight), right across daylight-saving changes. */
export function startOfDayIn(zone: string, iso: string): Date {
  const wall = Date.parse(`${iso}T00:00:00Z`);
  let t = wall - offsetMs(zone, wall);
  t = wall - offsetMs(zone, t);
  return new Date(t);
}
