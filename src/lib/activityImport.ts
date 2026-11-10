/**
 * Auto-fill the Activities sheet from an uploaded activity list. AxIS reads the file
 * (`proposalsFromDocument`, the same reader the student's Profile Update uses) and the
 * activities it finds are written straight onto the sheet as `source = 'ai'` rows, adding
 * only what the sheet doesn't already hold. Existing rows are never changed or removed.
 */

import type { FastifyRequest } from "fastify";
import { fromPostgrest, notFound } from "./errors.js";
import { MAX_SHEET_ROWS, type Proposal } from "./profileUpdates.js";
import { proposalsFromDocument } from "./profileUpdateDocument.js";

type Row = Record<string, unknown>;
export type ExistingActivity = { organization: string | null; position: string | null };

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The same activity when the organization matches and the positions match or either is unstated.
function same(a: ExistingActivity, b: ExistingActivity): boolean {
  if (norm(a.organization) !== norm(b.organization)) return false;
  const pa = norm(a.position);
  const pb = norm(b.position);
  return !pa || !pb || pa === pb;
}

/** The sheet rows to insert: activities with an organization, not already on the sheet, within the cap. Pure. */
export function newActivityRows(
  studentId: string,
  existing: ExistingActivity[],
  proposals: Proposal[]
): { rows: Row[]; skippedDuplicates: number } {
  const known = [...existing];
  const rows: Row[] = [];
  let skippedDuplicates = 0;
  for (const { draft: d } of proposals) {
    if (d.kind !== "activity" || !d.organization) continue;
    const candidate = { organization: d.organization, position: d.position };
    if (known.some((k) => same(k, candidate))) {
      skippedDuplicates++;
      continue;
    }
    if (known.length >= MAX_SHEET_ROWS) break;
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
      sort_order: Math.min(known.length, 999),
    });
    known.push(candidate);
  }
  return { rows, skippedDuplicates };
}

export type ActivityImportResult = { added: number; skippedDuplicates: number; full: boolean };

export async function importActivitiesFromDocument(request: FastifyRequest, documentId: string): Promise<ActivityImportResult> {
  // Read on the caller's client, so RLS decides which file and which sheet they can see.
  const { data: doc, error } = await request.db.from("documents").select("student_id").eq("id", documentId).maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!doc?.student_id) throw notFound("That file isn't on file");
  const studentId = String(doc.student_id);

  const { data: current, error: currentErr } = await request.db
    .from("activities")
    .select("organization, position")
    .eq("student_id", studentId);
  if (currentErr) throw fromPostgrest(currentErr);
  const existing = (current ?? []) as ExistingActivity[];
  // A full sheet takes nothing, so don't pay for the read.
  if (existing.length >= MAX_SHEET_ROWS) return { added: 0, skippedDuplicates: 0, full: true };

  // Throws in words when the file can't be read (the practice's switch, a kept-out file, a format AxIS can't open).
  const proposals = await proposalsFromDocument(request, documentId);
  const { rows, skippedDuplicates } = newActivityRows(studentId, existing, proposals);
  if (rows.length > 0) {
    const { error: insertErr } = await request.db.from("activities").insert(rows);
    if (insertErr) throw fromPostgrest(insertErr);
  }
  return { added: rows.length, skippedDuplicates, full: existing.length + rows.length >= MAX_SHEET_ROWS };
}
