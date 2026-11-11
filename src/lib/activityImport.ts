/**
 * Auto-fill the Activities sheet from an uploaded activity list. `activityProposalsFromDocument` reads the file
 * (a Common App spreadsheet without a model, anything else through AxIS) and marks what the sheet already has;
 * the activities it doesn't have are written straight onto the sheet as `source = 'ai'` rows. Existing rows are
 * never changed or removed.
 */

import type { FastifyRequest } from "fastify";
import { activityProposalsFromDocument, type ActivityProposal } from "./activityListImport.js";
import { fromPostgrest } from "./errors.js";
import { MAX_SHEET_ROWS } from "./profileUpdates.js";

type Row = Record<string, unknown>;

/** The sheet rows to insert: activities with an organization the sheet doesn't have yet, within the cap. Pure. */
export function newActivityRows(
  studentId: string,
  existingCount: number,
  proposals: ActivityProposal[]
): { rows: Row[]; skippedDuplicates: number } {
  const rows: Row[] = [];
  let skippedDuplicates = 0;
  for (const { draft: d, onSheet } of proposals) {
    if (d.kind !== "activity" || !d.organization) continue;
    if (onSheet) {
      skippedDuplicates++;
      continue;
    }
    if (existingCount + rows.length >= MAX_SHEET_ROWS) break;
    rows.push({
      student_id: studentId,
      // On the sheet the organization is the row's name (routes/application.ts capRows).
      name: d.organization,
      organization: d.organization,
      position: d.position,
      category: d.category,
      description: d.description,
      grade_levels: d.gradeLevels,
      hours_per_week: d.hoursPerWeek,
      weeks_per_year: d.weeksPerYear,
      source: "ai",
      sort_order: Math.min(existingCount + rows.length, 999),
    });
  }
  return { rows, skippedDuplicates };
}

export type ActivityImportResult = { added: number; skippedDuplicates: number; full: boolean };

/** The caller has already shown it can edit `studentId`; RLS decides the rest on the caller's own client. */
export async function importActivitiesFromDocument(request: FastifyRequest, studentId: string, documentId: string): Promise<ActivityImportResult> {
  const { count, error: countErr } = await request.db.from("activities").select("id", { count: "exact", head: true }).eq("student_id", studentId);
  if (countErr) throw fromPostgrest(countErr);
  const existing = count ?? 0;
  // A full sheet takes nothing, so don't pay for the read.
  if (existing >= MAX_SHEET_ROWS) return { added: 0, skippedDuplicates: 0, full: true };

  // Throws in words when the file can't be read (the practice's switch, a kept-out or sensitive file, a format AxIS can't open).
  const { proposals } = await activityProposalsFromDocument(request, studentId, documentId);
  const { rows, skippedDuplicates } = newActivityRows(studentId, existing, proposals);
  if (rows.length > 0) {
    const { error } = await request.db.from("activities").insert(rows);
    if (error) throw fromPostgrest(error);
  }
  return { added: rows.length, skippedDuplicates, full: existing + rows.length >= MAX_SHEET_ROWS };
}
