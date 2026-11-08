/**
 * Student booking: which start times a counselor offers. PURE: no database,
 * no network, no clock (the caller passes `now`).
 *
 * The counselor's weekly hours are wall-clock ranges in their own IANA zone
 * ("Monday 09:00-12:00 in America/New_York"). Each local day in the window is
 * turned into real instants with Intl only (no date library), so a range that
 * spans a DST change is as long as it really is: 01:00-04:00 on a
 * spring-forward night is two hours, on a fall-back night four. Slots step by
 * the meeting type's duration from the start of each range, in real minutes.
 *
 * A wall time inside the spring-forward gap is read with the offset in force
 * before the change, so it moves forward by the gap's length (02:30 on a
 * US spring-forward night, which never happens, becomes 03:30 local); an
 * ambiguous one (01:30 on a fall-back night) means its first occurrence. "24:00" is allowed as the end of a range
 * (midnight at the end of that day); no slot ever runs past its range, so
 * nothing straddles midnight into the next day's hours.
 *
 * Busy intervals (UTC: the counselor's scheduled Meridies meetings and their
 * connected calendar's busy time) are each widened by the buffer on both
 * sides; a slot overlapping one is dropped. Touching is not overlapping.
 */

export type HoursRange = { start: string; end: string };
/** Weekday (0 = Sunday ... 6 = Saturday, as Date#getUTCDay) -> ranges. */
export type WeeklyHours = Partial<Record<string | number, HoursRange[]>>;
export type BusyInterval = { start: string; end: string };

export type SlotInput = {
  timeZone: string;
  weeklyHours: WeeklyHours;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  /** Only slots starting in [from, to) are returned. ISO instants. */
  from: string;
  to: string;
  busy: BusyInterval[];
  now: string | Date;
};

const MINUTE = 60_000;
const DAY = 86_400_000;
/** At most this many ranges per weekday. */
export const MAX_RANGES_PER_DAY = 12;

const HHMM = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):(00))$/;

function minutesOf(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  if (!m) return null;
  return m[3] ? 24 * 60 : Number(m[1]) * 60 + Number(m[2]);
}

/** One formatter per zone: building an Intl.DateTimeFormat is the expensive part of an offset read. */
const OFFSET_FORMATS = new Map<string, Intl.DateTimeFormat>();
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();
const FORMAT_CACHE_MAX = 200;

function cached(map: Map<string, Intl.DateTimeFormat>, tz: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = map.get(tz);
  if (!f) {
    if (map.size >= FORMAT_CACHE_MAX) map.clear();
    f = make();
    map.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at an instant, in minutes (east positive). */
function offsetMinutes(instantMs: number, tz: string): number {
  const format = cached(
    OFFSET_FORMATS,
    tz,
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
  );
  const parts = format.formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / MINUTE);
}

/**
 * A wall-clock date ("YYYY-MM-DD") and time ("HH:MM", or "24:00") in `tz`, as
 * epoch milliseconds. A gap time moves forward by the gap's length (02:30 in
 * a one-hour spring-forward gap is 03:30 local); an ambiguous time takes its
 * first occurrence.
 */
export function wallTimeToInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const mins = minutesOf(time);
  if (mins == null) throw new Error(`bad wall time ${time}`);
  const naive = Date.UTC(y, mo - 1, d) + mins * MINUTE;
  // Every offset in force within a day either side; a real wall time matches one of them.
  const offsets = new Set([offsetMinutes(naive - DAY, tz), offsetMinutes(naive, tz), offsetMinutes(naive + DAY, tz)]);
  const matches: number[] = [];
  for (const o of offsets) {
    const candidate = naive - o * MINUTE;
    if (offsetMinutes(candidate, tz) === o) matches.push(candidate);
  }
  if (matches.length) return Math.min(...matches);
  // In the gap: read the wall time with the offset before the change, which moves it forward by the gap's length.
  return naive - offsetMinutes(naive - DAY, tz) * MINUTE;
}

/** The calendar date (YYYY-MM-DD) an instant falls on in `tz`. */
function localDate(instantMs: number, tz: string): string {
  return cached(DATE_FORMATS, tz, () => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })).format(
    new Date(instantMs)
  );
}

function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** The available slot starts, ascending, as ISO instants. */
export function computeSlots(input: SlotInput): string[] {
  const duration = Math.round(input.durationMinutes);
  if (!(duration > 0)) return [];
  const buffer = Math.max(0, Math.round(input.bufferMinutes)) * MINUTE;
  const now = new Date(input.now).getTime();
  const from = new Date(input.from).getTime();
  const to = new Date(input.to).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(now) || to <= from) return [];

  const earliest = Math.max(from, now + Math.max(0, input.minNoticeHours) * 3_600_000);
  const latest = Math.min(to, now + Math.max(0, input.maxDaysAhead) * DAY);
  if (latest <= earliest) return [];

  const busy = input.busy
    .map((b) => ({ start: new Date(b.start).getTime() - buffer, end: new Date(b.end).getTime() + buffer }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

  const out = new Set<number>();
  const lastDay = localDate(latest, input.timeZone);
  for (let day = addDays(localDate(earliest, input.timeZone), -1); day <= lastDay; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const ranges = input.weeklyHours[weekday] ?? input.weeklyHours[String(weekday)] ?? [];
    for (const r of ranges) {
      if (minutesOf(r.start) == null || minutesOf(r.end) == null) continue;
      const rangeStart = wallTimeToInstant(day, r.start, input.timeZone);
      const rangeEnd = wallTimeToInstant(day, r.end, input.timeZone);
      for (let s = rangeStart; s + duration * MINUTE <= rangeEnd; s += duration * MINUTE) {
        if (s < earliest || s >= latest) continue;
        const e = s + duration * MINUTE;
        if (busy.some((b) => s < b.end && e > b.start)) continue;
        out.add(s);
      }
    }
  }
  return [...out].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

/**
 * Validate weekly hours from a client or the database: an object keyed by
 * weekday 0-6, each an array of {start, end} "HH:MM" ranges with start < end
 * ("24:00" allowed as an end), at most MAX_RANGES_PER_DAY, not overlapping.
 * Returns the ranges sorted, keyed by the weekday as a string.
 */
export function parseWeeklyHours(
  raw: unknown
): { ok: true; value: Record<string, HoursRange[]> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "Weekly hours must be an object of weekdays" };
  const value: Record<string, HoursRange[]> = {};
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(key)) return { ok: false, message: "Weekdays are 0 (Sunday) to 6 (Saturday)" };
    if (!Array.isArray(list)) return { ok: false, message: "Each weekday needs a list of times" };
    if (list.length > MAX_RANGES_PER_DAY) return { ok: false, message: `At most ${MAX_RANGES_PER_DAY} time ranges a day` };
    const ranges: { start: string; end: string; s: number; e: number }[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") return { ok: false, message: "Each time range needs a start and an end" };
      const { start, end } = item as Record<string, unknown>;
      if (typeof start !== "string" || typeof end !== "string") return { ok: false, message: "Times are written HH:MM" };
      const s = minutesOf(start);
      const e = minutesOf(end);
      if (s == null || e == null || s >= 24 * 60) return { ok: false, message: "Times are written HH:MM, 00:00 to 24:00" };
      if (s >= e) return { ok: false, message: "Each range must start before it ends" };
      ranges.push({ start, end, s, e });
    }
    ranges.sort((a, b) => a.s - b.s);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].s < ranges[i - 1].e) return { ok: false, message: "Time ranges on one day can't overlap" };
    }
    value[key] = ranges.map(({ start, end }) => ({ start, end }));
  }
  return { ok: true, value };
}

/** The longest window one slots request may ask about. */
export const MAX_SLOT_WINDOW_DAYS = 14;

/**
 * The window a student's slot request is answered for: from no earlier than
 * now, to no later than `maxDaysAhead` from now and at most
 * MAX_SLOT_WINDOW_DAYS after its start. Null when nothing is left.
 */
export function clampWindow(input: { from: string; to: string; now: string | Date; maxDaysAhead: number }): { from: string; to: string } | null {
  const now = new Date(input.now).getTime();
  const from = Math.max(new Date(input.from).getTime(), now);
  const to = Math.min(new Date(input.to).getTime(), from + MAX_SLOT_WINDOW_DAYS * DAY, now + Math.max(0, input.maxDaysAhead) * DAY);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * The window to ask a calendar about for slots in [from, to): widened by the
 * buffer, then out to whole local days in `tz` (from the start of the first
 * day to the next local midnight after the last), DST-safe. Requests a few
 * seconds apart then ask the same question, so listBusy's 60 s cache answers
 * them and the per-counselor limit is charged once; computeSlots still filters
 * by the exact window and `now`, so the slots don't change.
 */
export function busyWindow(from: string, to: string, bufferMinutes: number, tz: string): { from: string; to: string } {
  const pad = Math.max(0, bufferMinutes) * MINUTE;
  const lo = new Date(from).getTime() - pad;
  const hi = new Date(to).getTime() + pad;
  const start = wallTimeToInstant(localDate(lo, tz), "00:00", tz);
  const end = wallTimeToInstant(addDays(localDate(hi - 1, tz), 1), "00:00", tz);
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}
