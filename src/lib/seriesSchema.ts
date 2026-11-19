/**
 * Repeating events: whether `series_id` exists on `meetings` and `calendar_events` (20261129000003).
 *
 * The calendar feed selects meeting columns by name, so naming `series_id` before the migration is applied
 * is a 42703 and a 500 for every counselor's calendar. It, and the series routes, ask here first.
 */

import { z } from "zod";
import { HttpError } from "./errors.js";

/** What every series route answers until the migration is applied. */
export const SERIES_UNAVAILABLE = () => new HttpError(503, "Repeating events aren't switched on yet.", "series_unavailable");

/** How a series repeats (meetings and practice events alike): a preset and a count or an end date, not both. */
export const repeatBody = z
  .object({
    preset: z.enum(["daily", "weekdays", "weekly", "biweekly", "monthly"]),
    count: z.number().int().min(2).max(52).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date").optional(),
  })
  .strict()
  .refine((r) => (r.count === undefined) !== (r.until === undefined), "Give a count or an end date");

const MISSING_TTL_MS = 30_000;
let readiness: { ready: boolean; until: number } | null = null;
const SCHEMA_CODES = new Set(["42703", "42P01", "PGRST204", "PGRST205"]);

type ProbeDb = {
  from(table: string): { select(cols: string): { limit(n: number): PromiseLike<{ error: { code?: string } | null }> } };
};

/**
 * Whether the column exists, from a zero-row read on the caller's client (`invitesReady`'s rules). Ready is kept
 * for the life of the process; missing for 30 seconds, so applying the migration takes effect without a deploy.
 * Any other error reads as not ready, uncached: nothing names the column on a guess.
 */
export async function seriesReady(db: ProbeDb, now: number = Date.now()): Promise<boolean> {
  if (readiness && (readiness.ready || now < readiness.until)) return readiness.ready;
  try {
    const { error } = await db.from("meetings").select("series_id").limit(0);
    if (!error) {
      readiness = { ready: true, until: Number.POSITIVE_INFINITY };
      return true;
    }
    if (error.code && SCHEMA_CODES.has(error.code)) readiness = { ready: false, until: now + MISSING_TTL_MS };
    return false;
  } catch {
    return false;
  }
}

/** For tests. */
export function resetSeriesReady(): void {
  readiness = null;
}
