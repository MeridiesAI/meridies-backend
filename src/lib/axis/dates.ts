/**
 * Relative dates in a counselor's question, read without a model: "this
 * week", "by Friday", "next 10 days", "before Nov 1", "overdue". The result is
 * a window of ISO dates (UTC, like every date the backend writes) the planner
 * and the direct answers query with.
 */
import { fold } from "./text.js";

export type DateWindow = {
  /** Null reaches back without limit: overdue items are in the window. */
  from: string | null;
  to: string;
  label: string;
};

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
export const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, couple: 2, few: 3,
};

function weekdayIndex(w: string): number {
  const i = WEEKDAYS.indexOf(w);
  return i >= 0 ? i : (WEEKDAY_ABBR[w] ?? -1);
}

/** The next date on that weekday, today included. */
function nextWeekday(today: Date, wd: number): Date {
  return addDays(today, (wd - today.getUTCDay() + 7) % 7);
}

/** A month and day, in this year unless that has passed by more than a month (then next year). */
function monthDay(today: Date, month: number, day: number, year?: number): Date | null {
  if (day < 1 || day > 31) return null;
  let y = year ?? today.getUTCFullYear();
  let d = new Date(Date.UTC(y, month, day));
  if (d.getUTCMonth() !== month) return null;
  if (year === undefined && d.getTime() < today.getTime() - 31 * DAY) {
    y += 1;
    d = new Date(Date.UTC(y, month, day));
  }
  return d;
}

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

function explicitDate(t: string, today: Date): Date | null {
  const isoM = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (isoM) return monthDay(today, Number(isoM[2]) - 1, Number(isoM[3]), Number(isoM[1]));
  const named = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(t);
  if (named) return monthDay(today, MONTHS[named[1]!]!, Number(named[2]), named[3] ? Number(named[3]) : undefined);
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (numeric) {
    const y = numeric[3] ? (numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])) : undefined;
    return monthDay(today, Number(numeric[1]) - 1, Number(numeric[2]), y);
  }
  return null;
}

export function parseWindow(text: string, now = new Date()): DateWindow | null {
  const t = fold(text).replace(/[,?!]/g, " ").replace(/\s+/g, " ");
  const today = utcMidnight(now);
  const overdue = /\b(overdue|past due|late|missed)\b/.test(t);
  const window = forwardWindow(t, today);
  if (overdue && window) return { from: null, to: window.to, label: `overdue and ${window.label}` };
  if (overdue) return { from: null, to: iso(addDays(today, -1)), label: "overdue" };
  return window;
}

function forwardWindow(t: string, today: Date): DateWindow | null {
  const span = (days: number, label: string): DateWindow => ({ from: iso(today), to: iso(addDays(today, days)), label });

  if (/\btoday\b|\btonight\b/.test(t)) return { from: iso(today), to: iso(today), label: "today" };
  if (/\btomorrow\b/.test(t)) {
    const d = iso(addDays(today, 1));
    return { from: d, to: d, label: "tomorrow" };
  }
  const n = new RegExp(`\\b(?:next|coming|within|in|over the next|the next)\\s+(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})\\s+(day|days|week|weeks|month|months)\\b`).exec(t);
  if (n) {
    const count = /^\d+$/.test(n[1]!) ? Number(n[1]) : (NUMBER_WORDS[n[1]!] ?? 1);
    const unit = n[2]!.startsWith("day") ? 1 : n[2]!.startsWith("week") ? 7 : 30;
    const days = Math.min(count * unit, 366);
    return span(days, `next ${days} days`);
  }
  if (/\bthis weekend\b/.test(t)) {
    const sat = nextWeekday(today, 6);
    return { from: iso(today), to: iso(addDays(sat, 1)), label: "this weekend" };
  }
  if (/\bnext week\b/.test(t)) {
    const monday = addDays(nextWeekday(addDays(today, 1), 1), 0);
    return { from: iso(monday), to: iso(addDays(monday, 6)), label: "next week" };
  }
  if (/\b(this week|rest of the week|end of the week|by the weekend)\b/.test(t)) {
    const sunday = nextWeekday(today, 0);
    return { from: iso(today), to: iso(sunday), label: "this week" };
  }
  if (/\bnext month\b/.test(t)) {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0));
    return { from: iso(first), to: iso(last), label: "next month" };
  }
  if (/\bthis month\b/.test(t)) {
    const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    return { from: iso(today), to: iso(last), label: "this month" };
  }
  const until = /\b(by|before|until|till|through|ahead of)\s+(.+)$/.exec(t);
  if (until) {
    const rest = until[2]!;
    const wd = /^(?:this |next )?([a-z]+)/.exec(rest);
    const idx = wd ? weekdayIndex(wd[1]!) : -1;
    if (idx >= 0) {
      const d = nextWeekday(today, idx);
      return { from: iso(today), to: iso(/^next /.test(rest) ? addDays(d, 7) : d), label: `by ${WEEKDAYS[idx]}` };
    }
    const d = explicitDate(rest, today);
    if (d && d.getTime() >= today.getTime()) return { from: iso(today), to: iso(d), label: `by ${iso(d)}` };
  }
  for (const w of t.split(" ")) {
    const idx = weekdayIndex(w);
    if (idx >= 0 && w.length >= 3 && !(w === "sat" && /\bsat\b(?! (morning|afternoon|night))/.test(t))) {
      const d = nextWeekday(today, idx);
      return { from: iso(d), to: iso(d), label: WEEKDAYS[idx]! };
    }
  }
  const d = explicitDate(t, today);
  if (d) return { from: iso(d), to: iso(d), label: iso(d) };
  return null;
}
