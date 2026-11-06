/**
 * Seasonal stage emails (migration 20261110000003): the rules the template and blast routes share.
 *
 * A seasonal draft is an `email_templates` row in the 'families' set with a stage, a suggested month
 * and day and the class it is for (`class_offset`: 0 seniors, 1 juniors, 2 sophomores, 3 freshmen).
 * It is only ever a suggestion: Email Blast's Season view turns it into an ordinary scheduled blast
 * the counselor reviews first, and the date and class are resolved in the app, never here.
 *
 * Everything degrades without the migration: the routes read the new columns only after a probe,
 * and the stage-only routes answer 503 `stage_templates_unavailable`.
 *
 * Pure helpers (`validMonthDay`, `sameClasses`) plus two zero-row probes, in the style of
 * `scheduleReady` (lib/blasts.ts). Tests: `test/unit/stage-templates.test.ts`,
 * `test/integration/stage-templates.test.mjs`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError, fromPostgrest } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

/** The columns the migration adds to `email_templates`. */
export const STAGE_COLUMNS = "stage, send_month, send_day, class_offset, audience";

export function stageUnavailable(): HttpError {
  return new HttpError(503, "Seasonal drafts aren't switched on yet", "stage_templates_unavailable");
}

const MISSING_RECHECK_MS = 30_000;

/** Whether a table has the migration's columns: a ready answer is kept for the process, a missing one for 30 s. */
export function columnProbe(table: "email_templates" | "email_blasts", columns: string) {
  let ready = false;
  let missingAt = 0;
  return async function check(db: SupabaseClient): Promise<boolean> {
    if (ready) return true;
    if (Date.now() - missingAt < MISSING_RECHECK_MS) return false;
    const { error } = await db.from(table).select(columns).limit(0);
    if (!error) {
      ready = true;
      return true;
    }
    if (isResultsNotApplied(error)) {
      missingAt = Date.now();
      return false;
    }
    throw fromPostgrest(error);
  };
}

/** `email_templates` has the stage columns. */
export const stageColumnsReady = columnProbe("email_templates", STAGE_COLUMNS);

/** `email_blasts` has `source_template_id`. */
export const blastSourceReady = columnProbe("email_blasts", "source_template_id");

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A month and day that exist in some year (Feb 29 is allowed), the same rule as the table's CHECK. */
export function validMonthDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  return day <= (DAYS_IN_MONTH[month - 1] ?? 0);
}

/** Two lists of class years are the same set ("2027" and "2027" match whatever the order). */
export function sameClasses(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]) => [...new Set(list.map((y) => y.trim()))].sort().join(",");
  return norm(a) === norm(b);
}

/** The class years a stored blast filters on, from its `filters` jsonb. */
export function classYearsOf(filters: unknown): string[] {
  const years = (filters as { classYears?: unknown } | null | undefined)?.classYears;
  return Array.isArray(years) ? years.map((y) => String(y)) : [];
}
