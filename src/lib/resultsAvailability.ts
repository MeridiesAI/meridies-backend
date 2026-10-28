/**
 * College results and scholarship tracking added columns to existing tables
 * (migration 20261028000001). Until it is applied, a write that names one of
 * them fails with "column not found"; the routes answer 503 with a stable code
 * instead of a 500, and everything that doesn't name them keeps working.
 */

import { HttpError } from "./errors.js";

type PgError = { code?: string; message?: string } | null;

/** PostgREST's and Postgres's ways of saying "that column, table or function isn't there". */
const NOT_APPLIED = new Set(["PGRST200", "PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"]);

/** The error saying the migration isn't in yet; also true for a status the old CHECK refuses. */
export function isResultsNotApplied(error: PgError): boolean {
  if (!error?.code) return false;
  if (NOT_APPLIED.has(error.code)) return true;
  // 'not-awarded' is refused by the old scholarship_matches_status_check until the migration is applied.
  return error.code === "23514" && /scholarship_matches_status_check/.test(error.message ?? "");
}

export function resultsUnavailable(error: PgError): HttpError | null {
  return isResultsNotApplied(error)
    ? new HttpError(503, "College results and scholarship tracking aren't switched on yet", "college_results_unavailable")
    : null;
}
