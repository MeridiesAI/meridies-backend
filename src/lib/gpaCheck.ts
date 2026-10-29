/**
 * The GPA-within-scale rule at the routes (bug hunt 2026-10-28, S2-M2): a save
 * that would put a GPA above its scale is a 400 in words, before the database
 * constraint (`student_academics_gpa_within_scale`, 20261028000005) refuses it
 * with a generic error. The scale is the one in the same save, else the one on
 * record.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { badRequest, fromPostgrest } from "./errors.js";
import { gpaOverScale } from "./gpa.js";

export async function assertGpaFitsScale(
  db: SupabaseClient,
  studentId: string,
  next: { gpaWeighted?: number | null; gpaUnweighted?: number | null; gpaScale?: string | null }
): Promise<void> {
  const touchesGpa = next.gpaWeighted != null || next.gpaUnweighted != null || next.gpaScale !== undefined;
  if (!touchesGpa) return;
  const { data, error } = await db
    .from("student_academics")
    .select("gpa_weighted, gpa_unweighted, gpa_scale")
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  const row = (data ?? {}) as { gpa_weighted?: number | null; gpa_unweighted?: number | null; gpa_scale?: string | null };
  const scale = next.gpaScale !== undefined ? next.gpaScale : (row.gpa_scale ?? null);
  const weighted = next.gpaWeighted !== undefined ? next.gpaWeighted : (row.gpa_weighted ?? null);
  const unweighted = next.gpaUnweighted !== undefined ? next.gpaUnweighted : (row.gpa_unweighted ?? null);
  const why =
    gpaOverScale(weighted === null ? null : Number(weighted), scale, "weighted") ??
    gpaOverScale(unweighted === null ? null : Number(unweighted), scale, "unweighted");
  if (why) throw badRequest(why);
}
