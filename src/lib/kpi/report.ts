/**
 * Time saved: one consultant's month, built from the ledger only (every figure was
 * snapshotted when the work was finished). "Value of time" and "extra students"
 * are two readings of the same hours: the page shows them as either/or.
 */
import { TASK_TYPES, type TaskType } from "./types.js";

export type CompletionRow = {
  task_type: TaskType;
  student_id: string | null;
  month: string;
  manual_minutes: number;
  manual_is_estimate: boolean;
  meridies_minutes: number | string;
  measure_method: "active" | "capped" | "median" | "signup";
  saved_minutes: number | string;
  hourly_rate: number | string;
  rate_is_estimate: boolean;
};

export type ActivityCounts = { aiRuns: Record<string, number>; researchRuns: Record<string, number> };

export type ReportLine = {
  studentId: string | null;
  studentName: string | null;
  manual: number;
  meridies: number;
  method: CompletionRow["measure_method"];
  saved: number;
  estimate: boolean;
  calc: string;
};

export type KpiReport = {
  month: string;
  hoursSaved: number;
  students: number;
  valueOfTime: number | null;
  valueIsEstimate: boolean;
  extraStudents: { upTo: number; basedOnMonths: number } | null;
  byTask: Array<{ taskType: TaskType; completions: number; savedMinutes: number; display: "saved" | "no-time-saved-yet"; lines: ReportLine[] }>;
  activity: ActivityCounts;
  empty: boolean;
};

const n = (v: number | string) => Number(v);
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export function buildReport(
  rows: CompletionRow[],
  last12: CompletionRow[],
  hoursPerStudentYear: number,
  activity: ActivityCounts,
  month: string,
  studentNames: Record<string, string>
): KpiReport {
  const savedMinutes = rows.reduce((sum, r) => sum + n(r.saved_minutes), 0);
  const hoursSaved = round(savedMinutes / 60, 1);
  const value = rows.reduce((sum, r) => sum + (n(r.saved_minutes) / 60) * n(r.hourly_rate), 0);

  const yearMinutes = last12.reduce((sum, r) => sum + n(r.saved_minutes), 0);
  const upTo = Math.floor(yearMinutes / 60 / hoursPerStudentYear);
  const months = new Set(last12.map((r) => r.month.slice(0, 7))).size;

  const byTask = TASK_TYPES.flatMap((taskType) => {
    const mine = rows.filter((r) => r.task_type === taskType);
    if (mine.length === 0) return [];
    const total = mine.reduce((sum, r) => sum + n(r.saved_minutes), 0);
    return [{
      taskType,
      completions: mine.length,
      savedMinutes: round(total, 2),
      display: total > 0 ? ("saved" as const) : ("no-time-saved-yet" as const),
      lines: mine.map((r) => {
        const meridies = round(n(r.meridies_minutes), 1);
        return {
          studentId: r.student_id,
          studentName: r.student_id ? (studentNames[r.student_id] ?? null) : null,
          manual: r.manual_minutes,
          meridies,
          method: r.measure_method,
          saved: round(n(r.saved_minutes), 1),
          estimate: r.manual_is_estimate,
          calc: `${r.manual_minutes} min estimate − ${meridies} min in Meridies${r.manual_is_estimate ? " (estimated)" : ""}`,
        };
      }),
    }];
  });

  return {
    month,
    hoursSaved,
    students: new Set(rows.map((r) => r.student_id).filter(Boolean)).size,
    valueOfTime: savedMinutes > 0 ? Math.round(value) : null,
    valueIsEstimate: rows.some((r) => r.rate_is_estimate),
    extraStudents: upTo > 0 ? { upTo, basedOnMonths: months } : null,
    byTask,
    activity,
    empty: rows.length === 0,
  };
}

/** "YYYY-MM" for a moment in a time zone (UTC when the zone is unknown). */
export function monthIn(timeZone: string | null | undefined, at = new Date()): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(at).slice(0, 7);
  try {
    return fmt(timeZone || "UTC");
  } catch {
    return fmt("UTC");
  }
}

/** First day of the month `back` months before "YYYY-MM", as "YYYY-MM-01". */
export function monthsBack(month: string, back: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return d.toISOString().slice(0, 10);
}

/** Minutes east of UTC that `timeZone` reads at instant `at` (throws on an unknown zone). */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((wall - at.getTime()) / 60000);
}

/** The instant a month ("YYYY-MM") begins at local midnight in `timeZone` (UTC when unknown or unset). */
export function zonedMonthStart(month: string, timeZone: string | null | undefined): Date {
  const [y, m] = month.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, 1);
  if (!timeZone) return new Date(utc);
  try {
    let at = utc - offsetMinutes(new Date(utc), timeZone) * 60000;
    at = utc - offsetMinutes(new Date(at), timeZone) * 60000; // settle across a DST change
    return new Date(at);
  } catch {
    return new Date(utc);
  }
}
