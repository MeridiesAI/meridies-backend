/**
 * The weekly family digest's rules, pure: which week, who gets one, and what it says.
 *
 * The job (lib/weeklyDigest.ts) reads the rows; everything here is arithmetic and wording, so it is unit tested.
 * The content is deterministic, never a model's: tasks the student finished in the week (only tasks visible to
 * the student), tasks overdue or due in the two weeks after it, college deadlines in those two weeks, and essay
 * word-count movement. Never essay text, never an essay's title or prompt: an essay is named by its kind and
 * school only ("Personal statement", "Boston University supplement"). The student is named by first name only.
 */

import { localDate } from "./studentReminders.js";
import { firstNameOf, settingsFor, type SettingsRow } from "./inactivity.js";

/** The zone a counselor's week is counted in when their profile has none (or an unknown one). */
export const DIGEST_DEFAULT_TIMEZONE = "America/New_York";

/** Items per list in the digest; past it, "and N more". */
export const DIGEST_LIST_MAX = 10;
const TITLE_MAX = 120;
/** A text carries the summary, kept to the composer's text length. */
export const DIGEST_SMS_MAX = 320;

export type DigestWeek = {
  /** Monday, YYYY-MM-DD, in the counselor's zone. */
  periodStart: string;
  /** Sunday, YYYY-MM-DD. */
  periodEnd: string;
  /** The Monday after: overdue and due-soon are counted from this date. */
  nextMonday: string;
  /** Local midnight at the start of periodStart and of nextMonday, as ISO instants (DST-correct). */
  startUtc: string;
  endUtc: string;
  timezone: string;
};

function validZone(tz: string | null | undefined): string {
  if (!tz) return DIGEST_DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return tz;
  } catch {
    return DIGEST_DEFAULT_TIMEZONE;
  }
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const addDays = (date: string, days: number): string => ymd(dayMs(date) + days * 86_400_000);

/** How far the zone's wall clock is ahead of UTC at instant `t`, in ms. */
function zoneOffset(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(t / 1000) * 1000;
}

/** The instant local midnight begins `date` in `tz` (two passes, so a DST change that day is honoured). */
export function zonedDayStartUtc(date: string, tz: string): string {
  const zone = validZone(tz);
  const guess = dayMs(date);
  const first = guess - zoneOffset(guess, zone);
  return new Date(guess - zoneOffset(first, zone)).toISOString();
}

/** The most recent Monday-Sunday week that has ended, in the counselor's zone. */
export function lastCompletedWeek(now: Date, timezone: string | null | undefined): DigestWeek {
  const tz = validZone(timezone);
  const today = localDate(tz, now);
  const sinceMonday = (new Date(dayMs(today)).getUTCDay() + 6) % 7;
  const nextMonday = addDays(today, -sinceMonday);
  const periodStart = addDays(nextMonday, -7);
  return {
    periodStart,
    periodEnd: addDays(nextMonday, -1),
    nextMonday,
    startUtc: zonedDayStartUtc(periodStart, tz),
    endUtc: zonedDayStartUtc(nextMonday, tz),
    timezone: tz,
  };
}

/** The counselor-wide row switches the digest on; a per-student row, when there is one, wins either way. */
export function digestWanted(rows: SettingsRow[], studentId: string): boolean {
  return settingsFor(rows, studentId).weekly_digest === "draft";
}

// ---- Essay word counts ---------------------------------------------------------------------------------------

export type DigestEssay = { id: string; essay_kind: string | null; school: string | null; created_at: string };
export type WordEvent = { entity_id: string | null; word_count: number | null; created_at: string };
export type EssayMove = { label: string; words: number; delta: number };

function essayLabel(e: DigestEssay): string | null {
  if (e.essay_kind === "personal-statement") return "Personal statement";
  if (e.essay_kind === "supplement") {
    const school = oneLine(e.school ?? "", 80);
    return school ? `${school} supplement` : "Supplement essay";
  }
  return null; // 'other' materials are not essays a family is told about
}

/**
 * Word-count movement per essay in the week: the last count recorded in the week against the last one before
 * it (0 for an essay started in the week). An essay with no count before the week that wasn't started in it has
 * no baseline and is left out; so is one whose count didn't move. Only kind, school and numbers are read.
 */
export function essayMovement(input: { week: DigestWeek; essays: DigestEssay[]; before: WordEvent[]; during: WordEvent[] }): EssayMove[] {
  const latest = (events: WordEvent[]) => {
    const out = new Map<string, number>();
    const sorted = [...events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const e of sorted) if (e.entity_id && typeof e.word_count === "number") out.set(e.entity_id, e.word_count);
    return out;
  };
  const start = latest(input.before);
  const end = latest(input.during);
  const moves: EssayMove[] = [];
  const seen = new Map<string, number>();
  for (const e of input.essays) {
    const label = essayLabel(e);
    const words = end.get(e.id);
    if (!label || words === undefined) continue;
    const startedInWeek = Date.parse(e.created_at) >= Date.parse(input.week.startUtc);
    const base = start.get(e.id) ?? (startedInWeek ? 0 : undefined);
    if (base === undefined || words === base) continue;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    moves.push({ label: n > 1 ? `${label} (${n})` : label, words, delta: words - base });
  }
  return moves;
}

// ---- The digest ------------------------------------------------------------------------------------------------

export type DigestInput = {
  fullName: string | null;
  week: DigestWeek;
  /** Tasks visible to the student, finished in the week. */
  completed: { title: string }[];
  /** Tasks visible to the student, not finished, due before nextMonday + 14 days (overdue included). */
  open: { title: string; due_date: string }[];
  /** College deadlines from nextMonday to 13 days after it. */
  deadlines: { name: string; date: string }[];
  essays: EssayMove[];
};

export type WeeklyDigest = { title: string; summary: string; highlights: string[]; body: string };

function oneLine(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
export const shortDay = (date: string): string => fmt.format(new Date(dayMs(date)));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));

function capped(lines: string[]): string[] {
  if (lines.length <= DIGEST_LIST_MAX) return lines;
  return [...lines.slice(0, DIGEST_LIST_MAX), `- and ${lines.length - DIGEST_LIST_MAX} more`];
}

/**
 * The first words of each section of the digest's body, which is also how a section is found again when what a
 * family receives leaves it out at send time (lib/familyVisibility.ts). Change one here and both follow.
 */
export const DIGEST_HEADERS = {
  finished: "Finished this week (",
  upcoming: "Coming up or overdue:",
  collegeDeadlines: "College deadlines in the next two weeks:",
  essays: "Essays (word counts only):",
} as const;

/** The digest for one student's week, or null when there is nothing to report. */
export function buildWeeklyDigest(input: DigestInput): WeeklyDigest | null {
  const { week } = input;
  const overdue = input.open.filter((t) => t.due_date < week.nextMonday).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const dueSoon = input.open.filter((t) => t.due_date >= week.nextMonday).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const deadlines = [...input.deadlines].sort((a, b) => a.date.localeCompare(b.date));
  const essays = input.essays.filter((e) => e.delta !== 0);
  if (input.completed.length + overdue.length + dueSoon.length + deadlines.length + essays.length === 0) return null;

  const first = firstNameOf(input.fullName);
  const span = `${shortDay(week.periodStart)} to ${shortDay(week.periodEnd)}`;
  const sections: string[] = [`Here is ${first}'s week, Monday ${shortDay(week.periodStart)} to Sunday ${shortDay(week.periodEnd)}.`];

  if (input.completed.length) {
    sections.push(
      [`${DIGEST_HEADERS.finished}${input.completed.length}):`, ...capped(input.completed.map((t) => `- ${oneLine(t.title, TITLE_MAX)}`))].join("\n")
    );
  }
  if (overdue.length || dueSoon.length) {
    sections.push(
      [
        DIGEST_HEADERS.upcoming,
        ...capped([
          ...overdue.map((t) => `- Overdue since ${shortDay(t.due_date)}: ${oneLine(t.title, TITLE_MAX)}`),
          ...dueSoon.map((t) => `- Due ${shortDay(t.due_date)}: ${oneLine(t.title, TITLE_MAX)}`),
        ]),
      ].join("\n")
    );
  }
  if (deadlines.length) {
    sections.push(
      [DIGEST_HEADERS.collegeDeadlines, ...capped(deadlines.map((d) => `- ${oneLine(d.name, TITLE_MAX)}: ${shortDay(d.date)}`))].join("\n")
    );
  }
  const essayLines = essays.map((e) => `${e.label}: ${e.words} words, ${signed(e.delta)} this week`);
  if (essays.length) {
    sections.push([DIGEST_HEADERS.essays, ...capped(essayLines.map((l) => `- ${l}`))].join("\n"));
  }

  const counts: string[] = [];
  if (input.completed.length) counts.push(plural(input.completed.length, "task finished", "tasks finished"));
  if (overdue.length) counts.push(`${overdue.length} overdue`);
  if (dueSoon.length) counts.push(`${dueSoon.length} due in the next two weeks`);
  if (deadlines.length) counts.push(plural(deadlines.length, "college deadline coming up", "college deadlines coming up"));
  const essayTotal = essays.reduce((sum, e) => sum + e.delta, 0);
  const summaryParts = essays.length ? [...counts, `essays ${signed(essayTotal)} words`] : counts;

  return {
    title: `${first}'s week: ${span}`,
    summary: oneLine(`${first}'s week (${span}): ${summaryParts.join(", ")}.`, DIGEST_SMS_MAX),
    highlights: [...counts, ...essayLines].slice(0, 12).map((h) => oneLine(h, 240)),
    body: sections.join("\n\n"),
  };
}
