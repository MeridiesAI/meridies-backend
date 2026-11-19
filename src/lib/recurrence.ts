/**
 * Repeating meetings and events: the date maths. PURE: no database, no network, no clock, and NO IMPORTS,
 * because this file is copied verbatim into meridies-app and meridies-demo (keep the three identical).
 *
 * `expandSeriesDates` turns a repeat rule into ISO dates (YYYY-MM-DD). The limits are hard: a series needs 2 to
 * `max` meetings (default 52) and may run 366 days from its start, and any breach is a RangeError whose message is
 * shown to the user as written. Nothing is ever cut short silently. Monthly keeps the start's day-of-month,
 * clamped to a short month (Jan 31 -> Feb 28 -> Mar 31), always counted from the ORIGINAL start. Weekdays skips
 * Saturday and Sunday, the start date included (a weekend start begins the next Monday).
 *
 * `zonedInstant` / `shiftInstant` / `wallDelta` do wall-clock maths in an IANA zone with Intl only, so a 9:00 AM
 * series stays 9:00 AM across a daylight-saving change. A wall time that does not exist (the spring-forward gap)
 * is read with the offset in force before the change, so it moves forward by the gap's length (02:30 becomes
 * 03:30); an ambiguous one (01:30 on a fall-back night) means its first occurrence. Instants come out at whole
 * seconds. shortcut: shifting the SECOND 01:30 of a fall-back night reads it back as the first (wall clock alone
 * can't tell them apart); upgrade by carrying the offset if a series ever needs to start in that hour.
 */

export type RepeatPreset = "daily" | "weekdays" | "weekly" | "biweekly" | "monthly";
export type RepeatSpec = { preset: RepeatPreset; end: { count: number } | { until: string } };

export const MAX_SERIES = 52;
export const MAX_SERIES_WITH_LINKS = 12;
export const MAX_SPAN_DAYS = 366;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const STEP_DAYS: Partial<Record<RepeatPreset, number>> = { daily: 1, weekly: 7, biweekly: 14 };

/** UTC midnight (ms) of a real YYYY-MM-DD date, else a RangeError naming `what`. */
function parseDate(date: string, what: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d) return ms;
  }
  throw new RangeError(`The ${what} date must be a real date (YYYY-MM-DD).`);
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Every date the preset visits from the start, in order, without end. */
function* candidates(startMs: number, preset: RepeatPreset): Generator<number> {
  if (preset === "monthly") {
    const s = new Date(startMs);
    const [y, m, d] = [s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()];
    for (let i = 0; ; i++) {
      const daysInMonth = new Date(Date.UTC(y, m + i + 1, 0)).getUTCDate();
      yield Date.UTC(y, m + i, Math.min(d, daysInMonth));
    }
  } else if (preset === "weekdays") {
    for (let t = startMs; ; t += DAY_MS) {
      const day = new Date(t).getUTCDay();
      if (day !== 0 && day !== 6) yield t;
    }
  } else {
    const step = STEP_DAYS[preset];
    if (!step) throw new RangeError("Choose how often the series repeats.");
    for (let t = startMs; ; t += step * DAY_MS) yield t;
  }
}

export function expandSeriesDates(start: string, spec: RepeatSpec, max = MAX_SERIES): string[] {
  const startMs = parseDate(start, "start");
  const end = spec.end;

  let count = Infinity;
  let untilMs = Infinity;
  if ("count" in end) {
    if (!Number.isInteger(end.count)) throw new RangeError("The number of meetings must be a whole number.");
    if (end.count < 2) throw new RangeError("A repeating series needs at least 2 meetings.");
    if (end.count > max) throw new RangeError(`A series can have at most ${max} meetings.`);
    count = end.count;
  } else {
    untilMs = parseDate(end.until, "end");
    if (untilMs < startMs) throw new RangeError("The end date can't be before the start date.");
    if ((untilMs - startMs) / DAY_MS > MAX_SPAN_DAYS) {
      throw new RangeError(`A series can run for at most ${MAX_SPAN_DAYS} days.`);
    }
  }

  const dates: number[] = [];
  for (const t of candidates(startMs, spec.preset)) {
    if (dates.length >= count || t > untilMs) break;
    dates.push(t);
  }

  if (untilMs !== Infinity) {
    if (dates.length < 2) throw new RangeError("That end date leaves fewer than 2 meetings in the series.");
    if (dates.length > max) {
      throw new RangeError(`That end date makes ${dates.length} meetings; a series can have at most ${max}.`);
    }
  } else if ((dates[dates.length - 1]! - startMs) / DAY_MS > MAX_SPAN_DAYS) {
    throw new RangeError(`${count} meetings that often would run past ${MAX_SPAN_DAYS} days; choose fewer.`);
  }
  return dates.map(isoDate);
}

// --- Wall-clock maths in an IANA zone ---

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's wall clock at instant `t`, as the UTC ms of the same digits. An unknown zone is a RangeError. */
function wallMs(t: number, timeZone: string): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(t)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
}

/** The zone's offset from UTC (ms, east positive) at instant `t`. */
const offsetAt = (t: number, timeZone: string): number => wallMs(t, timeZone) - Math.floor(t / 1000) * 1000;

/** The UTC instant of `minutes` after midnight of `date` on the zone's wall clock; `minutes` may leave 0..1439. */
export function zonedInstant(date: string, minutes: number, timeZone: string): string {
  const naive = parseDate(date, "start") + minutes * MINUTE_MS;
  // A transition near this wall time sits between these two samples, so these are the offsets on either side of it.
  const before = offsetAt(naive - DAY_MS, timeZone);
  const after = offsetAt(naive + DAY_MS, timeZone);
  const real = [before, after].map((o) => naive - o).filter((t) => offsetAt(t, timeZone) === naive - t);
  // No candidate holds: the wall time is in the gap, so read it with the offset before the change (moves forward).
  const t = real.length ? Math.min(...real) : naive - before;
  return new Date(t).toISOString();
}

/** An instant's wall date (UTC ms of its midnight) and minutes after midnight in the zone. */
function wallParts(iso: string, timeZone: string): { dayMs: number; minutes: number } {
  const w = wallMs(Date.parse(iso), timeZone);
  const dayMs = Math.floor(w / DAY_MS) * DAY_MS;
  return { dayMs, minutes: (w - dayMs) / MINUTE_MS };
}

/** Moves an instant by whole wall-clock days plus minutes, so the clock time survives a DST change. */
export function shiftInstant(iso: string, delta: { days: number; minutes: number }, timeZone: string): string {
  const { dayMs, minutes } = wallParts(iso, timeZone);
  return zonedInstant(isoDate(dayMs + delta.days * DAY_MS), minutes + delta.minutes, timeZone);
}

/** How far the wall clock moved from one instant to another: whole days, plus the minutes-of-day difference. */
export function wallDelta(fromIso: string, toIso: string, timeZone: string): { days: number; minutes: number } {
  const a = wallParts(fromIso, timeZone);
  const b = wallParts(toIso, timeZone);
  return { days: (b.dayMs - a.dayMs) / DAY_MS, minutes: b.minutes - a.minutes };
}

// --- The preview line ---

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Weekly on Tuesday, 10 times", "Every 2 weeks on Tuesday until Jan 26": the same words for the same input. */
export function repeatLabel(spec: RepeatSpec, start: string): string {
  const s = new Date(parseDate(start, "start"));
  const weekday = WEEKDAY_NAMES[s.getUTCDay()]!;
  const what = {
    daily: "Every day",
    weekdays: "Every weekday",
    weekly: `Weekly on ${weekday}`,
    biweekly: `Every 2 weeks on ${weekday}`,
    monthly: `Monthly on day ${s.getUTCDate()}`,
  }[spec.preset];
  if ("count" in spec.end) return `${what}, ${spec.end.count} times`;
  const u = new Date(parseDate(spec.end.until, "end"));
  const year = u.getUTCFullYear() === s.getUTCFullYear() ? "" : `, ${u.getUTCFullYear()}`;
  return `${what} until ${MONTH_NAMES[u.getUTCMonth()]} ${u.getUTCDate()}${year}`;
}
