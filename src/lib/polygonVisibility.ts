/**
 * Whether a student sees their strength profile (migration 20261028000005).
 *
 * Two switches, either one hides it from the student: their own
 * (`student_preferences.show_strength_profile`) and their counselor's
 * (`student_polygon_settings.hidden_by_counselor`). Hiding changes only what
 * the student sees; the counselor's polygon, the axes and the history are
 * untouched.
 *
 * Until the migration is applied nothing is hidden and nothing fails: a
 * missing table or column reads as "shown", and a write that needs it answers
 * 503 `polygon_visibility_unavailable`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError, fromPostgrest } from "./errors.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

export type PolygonVisibility = {
  /** Whether the student sees their strength profile. */
  visible: boolean;
  /** Who hid it; the counselor's switch wins when both are on. */
  hiddenBy: "counselor" | "student" | null;
};

export function visibilityUnavailable(): HttpError {
  return new HttpError(503, "Hiding the strength profile isn't switched on yet", "polygon_visibility_unavailable");
}

/** The counselor's switch for one student; false when unset or the table is missing. */
export async function hiddenByCounselor(db: SupabaseClient, studentId: string): Promise<boolean> {
  const { data, error } = await db
    .from("student_polygon_settings")
    .select("hidden_by_counselor")
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) {
    if (isResultsNotApplied(error)) return false;
    throw fromPostgrest(error);
  }
  return data?.hidden_by_counselor === true;
}

export function visibilityOf(counselorHid: boolean, studentShows: boolean): PolygonVisibility {
  if (counselorHid) return { visible: false, hiddenBy: "counselor" };
  if (!studentShows) return { visible: false, hiddenBy: "student" };
  return { visible: true, hiddenBy: null };
}

/** Set the counselor's switch (an upsert on the counselor's own client; RLS decides). */
export async function setHiddenByCounselor(db: SupabaseClient, studentId: string, hidden: boolean): Promise<void> {
  const { error } = await db
    .from("student_polygon_settings")
    .upsert({ student_id: studentId, hidden_by_counselor: hidden }, { onConflict: "student_id" });
  if (error) {
    if (isResultsNotApplied(error)) throw visibilityUnavailable();
    throw fromPostgrest(error);
  }
}
