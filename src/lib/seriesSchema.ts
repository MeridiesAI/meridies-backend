/**
 * Repeating events: whether `series_id` exists on `meetings` and `calendar_events` (20261129000002).
 *
 * The calendar feed selects meeting columns by name, so naming `series_id` before the migration is applied
 * is a 42703 and a 500 for every counselor's calendar. It, and the series routes, ask here first.
 */

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
