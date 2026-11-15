/**
 * A school's application deadline for the round a student applies in, and how a college list row's date follows
 * the round (migration 20261126100002).
 *
 * Where a school's date for a round comes from, in order:
 *
 *   1. `college_round_deadlines`: the official date for this admission cycle, one row per school, cycle and
 *      round. The ONE place official per-round dates live; only the service role writes it (a job that reads
 *      colleges' admissions pages, or a curated load), upserting on (college_id, admission_cycle, round).
 *   2. `colleges.deadlines`: the catalog's curated summary ("Regular Decision": "Jan 5"), read by
 *      `catalogDeadline` as before this table existed.
 *   3. Nothing: the student or counselor types the date on the board ("Due", `student_colleges.deadline`).
 *
 * The row's date belongs to its round (`deadlineAfterRoundChange`). Reading the table never fails the request it
 * rides on: while it is missing (code deployed before the migration) every read answers "no official dates" and
 * remembers that for five minutes, as lib/collegePhotos.ts does; any other failure is logged and answered the same
 * way, so the board falls back to the curated summary exactly as it did before.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { serializeErr } from "./requestLog.js";
import { catalogDeadline } from "./studentApplication.js";

/** The round codes, the same as `student_colleges.round` (and the table's CHECK). */
export const ROUND_CODES = ["ED", "ED2", "EA", "REA", "SCEA", "RD", "rolling", "priority"] as const;

export const MISSING_TABLE_TTL_MS = 5 * 60_000;
const MISSING = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

let missingUntil = 0;

/** For tests. */
export function resetOfficialDeadlineCache(): void {
  missingUntil = 0;
}

type Warn = { warn: (o: object, m?: string) => void };

/**
 * One school's official dates for the cycle, by round code, read as the caller (every signed-in user may read
 * them). Never throws: no catalog id, a missing table or a failed read is an empty map.
 */
export async function loadOfficialDeadlines(
  db: SupabaseClient,
  collegeId: string | null | undefined,
  cycle: string,
  log?: Warn,
  now: number = Date.now()
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!collegeId || now < missingUntil) return out;
  let data: unknown;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await db
      .from("college_round_deadlines")
      .select("round, deadline")
      .eq("college_id", collegeId)
      .eq("admission_cycle", cycle));
  } catch (err) {
    log?.warn({ err: serializeErr(err) }, "official deadlines: read failed");
    return out;
  }
  if (error) {
    if (MISSING.has(error.code ?? "")) missingUntil = now + MISSING_TABLE_TTL_MS;
    else log?.warn({ err: serializeErr(error) }, "official deadlines: read failed");
    return out;
  }
  for (const r of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const round = r.round;
    const deadline = r.deadline;
    if (typeof round !== "string" || !(ROUND_CODES as readonly string[]).includes(round)) continue;
    if (typeof deadline !== "string" || !ISO_DAY.test(deadline)) continue;
    out.set(round, deadline);
  }
  return out;
}

/** What is on file for one school: its official dates this cycle and the catalog's curated summary. */
export type RoundDates = {
  official: Map<string, string>;
  /** `colleges.deadlines`. */
  curated: unknown;
  cycle: string;
};

/** Every date on file for a round, official first. No round reads as Regular Decision, as `catalogDeadline` does. */
function datesFor(d: RoundDates, round: string | null): string[] {
  const r = round ?? "RD";
  const out: string[] = [];
  const official = d.official.get(r);
  if (official) out.push(official);
  const curated = catalogDeadline(d.curated, r, d.cycle);
  if (curated && curated !== official) out.push(curated);
  return out;
}

/** The school's date for a round: the official one, else the curated one, else null. */
export function knownDate(d: RoundDates, round: string | null): string | null {
  return datesFor(d, round)[0] ?? null;
}

/**
 * What a round change does to the row's date (`student_colleges.deadline`), when the same change names no date
 * of its own. The date belongs to the round:
 *
 *   - the new round's known date replaces whatever was there, a typed date included (that one was for the old
 *     round);
 *   - with no date known for the new round, a date that was filled in for the old round is cleared, and a date
 *     someone typed stays (it may well be the new round's: typed first, the round picked after);
 *   - picking the round the row already has only fills an empty date.
 *
 * Returns the date to write (null clears it), or undefined to leave the column as it is.
 */
export function deadlineAfterRoundChange(
  current: string | null,
  from: string | null,
  to: string | null,
  d: RoundDates
): string | null | undefined {
  const next = knownDate(d, to);
  if (from === to) return current == null && next ? next : undefined;
  if (next) return next === current ? undefined : next;
  if (current != null && datesFor(d, from).includes(current)) return null;
  return undefined;
}
