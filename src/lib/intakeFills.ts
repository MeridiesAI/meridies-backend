/**
 * What the onboarding questionnaire filled on a student's record, for the
 * "From the questionnaire" marks on the info card and the Application sheets.
 *
 * The questionnaire writes in the database (private.sync_intake_answers,
 * migration 20261023010002) and records each write in `intake_fills` as a
 * hash. `public.intake_filled_fields(p_student)` answers, for someone who can
 * see the student, which fields and rows it filled and whether each still
 * holds exactly what it wrote (`matchesCurrent`). A value someone edited since
 * is theirs and loses the mark.
 *
 * A mark is cosmetic, so this never breaks the read it decorates: without the
 * migration (a schema miss) it answers "no marks" and warns once per process,
 * the same degrade as `deliveryInsert.ts`; any other error, or a payload of
 * the wrong shape, is logged and also answers "no marks".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { serializeErr } from "./requestLog.js";

/** The info card's values the questionnaire can fill (StudentInfo keys). */
export type QuestionnaireField =
  | "highSchool"
  | "gradYear"
  | "gpaWeighted"
  | "gpaUnweighted"
  | "classRank"
  | "sat"
  | "act"
  | "firstGen"
  | "intendedMajors";

/** `table.field` in intake_fills -> the info card value it shows as. */
export const INFO_KEY_OF: Readonly<Record<string, QuestionnaireField>> = {
  "profiles.high_school": "highSchool",
  "profiles.grad_year": "gradYear",
  "student_academics.gpa_weighted": "gpaWeighted",
  "student_academics.gpa_unweighted": "gpaUnweighted",
  "student_academics.class_rank": "classRank",
  "student_academics.sat_superscore": "sat",
  "student_academics.act_composite": "act",
  "student_personal_details.first_gen": "firstGen",
  "student_personal_details.intended_majors": "intendedMajors",
};

const fillSchema = z.array(
  z.object({
    targetTable: z.string(),
    field: z.string(),
    rowId: z.string().nullable(),
    filledAt: z.string(),
    matchesCurrent: z.boolean(),
  })
);

export type IntakeFill = z.infer<typeof fillSchema>[number];

/** "No such function / table" from Postgres or PostgREST: the migration isn't applied. */
const SCHEMA_MISS = new Set(["42883", "42P01", "PGRST202", "PGRST205"]);

let warnedMissing = false;

/** For tests. */
export function resetIntakeFillsWarning(): void {
  warnedMissing = false;
}

type RpcClient = Pick<SupabaseClient, "rpc">;
type Log = Pick<FastifyBaseLogger, "warn" | "error">;

export async function loadIntakeFills(db: RpcClient, studentId: string, log?: Log): Promise<IntakeFill[]> {
  let data: unknown;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await db.rpc("intake_filled_fields", { p_student: studentId }));
  } catch (err) {
    log?.error({ err: serializeErr(err) }, "questionnaire fills could not be read");
    return [];
  }
  if (error) {
    if (error.code && SCHEMA_MISS.has(error.code)) {
      if (!warnedMissing) {
        warnedMissing = true;
        log?.warn("intake_filled_fields is missing: apply 20261023010002 to show questionnaire marks");
      }
      return [];
    }
    log?.error({ err: serializeErr(error) }, "questionnaire fills could not be read");
    return [];
  }
  const parsed = fillSchema.safeParse(data ?? []);
  if (!parsed.success) {
    log?.error("questionnaire fills came back in an unexpected shape");
    return [];
  }
  return parsed.data;
}

/** The info card values that still hold what the questionnaire wrote, each once. */
export function questionnaireFields(fills: readonly IntakeFill[]): QuestionnaireField[] {
  const out = new Set<QuestionnaireField>();
  for (const f of fills) {
    if (!f.matchesCurrent) continue;
    const key = INFO_KEY_OF[`${f.targetTable}.${f.field}`];
    if (key) out.add(key);
  }
  return [...out];
}

/** Ids of the rows of one sheet that still hold what the questionnaire wrote. */
export function questionnaireRowIds(fills: readonly IntakeFill[], table: "activities" | "awards"): Set<string> {
  const out = new Set<string>();
  for (const f of fills) {
    if (f.matchesCurrent && f.field === "*" && f.targetTable === table && f.rowId) out.add(f.rowId);
  }
  return out;
}
