/**
 * The Reach / Target / Safety tag on a school a student added from Build College Lists.
 *
 * A student can't set a school's `fit` (private.student_colleges_counselor_columns refuses it: fit is the
 * counselor's judgement), yet the counselor reads the same board and expects a tag on every card. So the SERVER
 * works it out, with the Builder's own rules (lib/collegesV10.ts studentOdds + fitFor: the school's published
 * admit rate moved by where the student's SAT and unweighted GPA sit against the school's middle; under 15%
 * admitted is a reach for anyone; no published rate is a reach) from the student's numbers on file, and writes it
 * with the service client. Nothing here takes a tag from the request.
 *
 * It is always read WITH scores, even when the student built a test-optional list: the tag on the board means
 * "your odds given your scores", and it can differ from the tier the Builder showed for a test-optional run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fitFor, studentOdds, type Fit, type ListSchool, type StudentNumbers } from "./collegesV10.js";

/** Reach / Target / Safety by catalog college id, one answer per school. */
export function fitsForSchools(numbers: StudentNumbers, schools: ListSchool[]): Map<string, Fit> {
  const fits = new Map<string, Fit>();
  for (const s of schools) {
    if (fits.has(s.collegeId)) continue;
    fits.set(s.collegeId, fitFor(s, studentOdds(numbers, s, true)));
  }
  return fits;
}

type Log = { warn(obj: unknown, msg?: string): void };

/**
 * Writes `fit` (and only `fit`) on rows the student has just added. The update is keyed on the row, the student
 * AND `added_by = the student`, so it can never touch a row the counselor added or a tag the counselor set on a
 * school that was already there. A row with no catalog school (typed in by hand) has no odds to read and is left
 * alone. Never throws: a row whose write fails simply has no tag, and the counselor can set it. Returns how many
 * rows were tagged.
 */
export async function stampFits(
  svc: Pick<SupabaseClient, "from"> | null,
  opts: { studentId: string; numbers: StudentNumbers; rows: { rowId: string; school: ListSchool | null }[]; log: Log }
): Promise<number> {
  if (!svc) return 0;
  let stamped = 0;
  for (const { rowId, school } of opts.rows) {
    if (!school) continue;
    const fit = fitFor(school, studentOdds(opts.numbers, school, true));
    try {
      const { error } = await svc
        .from("student_colleges")
        .update({ fit })
        .eq("id", rowId)
        .eq("student_id", opts.studentId)
        .eq("added_by", opts.studentId);
      if (error) {
        opts.log.warn({ code: (error as { code?: string }).code }, "Couldn't tag a school the student added; it stays untagged");
        continue;
      }
      stamped++;
    } catch (err) {
      opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Couldn't tag a school the student added; it stays untagged");
    }
  }
  return stamped;
}
