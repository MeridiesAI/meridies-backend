/**
 * The batched student export (`POST /account/export/students`) and the Google
 * Sheets roster summary (`POST /account/export/drive`): the pure parts.
 *
 * - Caseload scoping: an id the caller can't see and an id that doesn't exist
 *   both come back `not_found`, with the same shape and the same cost, and
 *   neither is ever read, so the answer can't tell a guess that hit someone
 *   else's student from a random uuid.
 * - Cost: one unit per distinct id asked for, from its own hourly bucket
 *   (`account:export-batch`), never the per-student export's 60 an hour.
 * - Size: the batch stops at `MAX_BATCH_ROWS` rows or `MAX_BATCH_BYTES` of
 *   JSON and the route answers 413 `export_too_large`, so one huge record
 *   can't take the API down; the app retries with a smaller batch.
 * - Files: uploaded files' bytes are never in an export. Each student's
 *   `documents` rows are listed by name so the app can say what to download.
 */

import { csvCell, toCsv } from "./csv.js";

type Row = Record<string, unknown>;

/** The most students in one batch; the app loops batches of this size. */
export const EXPORT_BATCH_MAX = 25;
/** Units (students) a counselor may export in batches per hour: a 120-student roster is 5 batches. */
export const BATCH_EXPORT_UNITS_PER_HOUR = 200;
/** One batch's ceiling, across all its students: rows (each profile counts one) and JSON bytes. */
export const MAX_BATCH_ROWS = 20_000;
export const MAX_BATCH_BYTES = 20 * 1024 * 1024;
/** The most students one roster-summary Sheet covers (caseloadStudentIds' own cap). */
export const MAX_SUMMARY_STUDENTS = 250;

export const FILES_NOT_INCLUDED_NOTE =
  "Uploaded files are not included in this export. Each student's documents are listed by name; download them from the student's Files.";

export type StudentRecordExport = { profile: unknown; records: Record<string, Row[]>; notIncluded: string[] };

export type ExportedDocument = {
  id: string | null;
  filename: string | null;
  title: string | null;
  kind: string | null;
  source: string | null;
  storagePath: string | null;
  externalUrl: string | null;
};

export type BatchStudent =
  | {
      id: string;
      status: "ok";
      json: { exportedAt: string; kind: "student" } & StudentRecordExport;
      csv: Record<string, string>;
      documents: ExportedDocument[];
      rows: number;
      bytes: number;
    }
  | { id: string; status: "not_found" };

const norm = (id: string) => id.toLowerCase();

function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = norm(raw);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Units a batch spends: one per distinct id asked for, whether or not it is on the caseload. */
export function exportCost(ids: readonly string[]): number {
  return unique(ids).length;
}

/**
 * The ids to export (on the caseload, in request order, once each) and the
 * rest. The caller's own id is in `caseloadStudentIds` and is never a student.
 */
export function splitByCaseload(
  requested: readonly string[],
  caseload: Iterable<string>,
  callerId: string
): { allowed: string[]; notFound: string[] } {
  const visible = new Set<string>();
  for (const id of caseload) visible.add(norm(id));
  visible.delete(norm(callerId));
  const allowed: string[] = [];
  const notFound: string[] = [];
  for (const id of unique(requested)) (visible.has(id) ? allowed : notFound).push(id);
  return { allowed, notFound };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function documentsOf(records: Record<string, Row[]>): ExportedDocument[] {
  return (records.documents ?? []).map((d) => ({
    id: str(d.id),
    filename: str(d.filename),
    title: str(d.title),
    kind: str(d.kind),
    source: str(d.source),
    storagePath: str(d.storage_path),
    externalUrl: str(d.external_web_url),
  }));
}

/** One student's part of a batch: the per-student export's JSON, a CSV per table with rows, the document list. */
export function assembleStudent(id: string, exported: StudentRecordExport, exportedAt: string): Extract<BatchStudent, { status: "ok" }> {
  const csv: Record<string, string> = {};
  let rows = 0;
  if (exported.profile && typeof exported.profile === "object") {
    csv.profile = toCsv([exported.profile as Row]);
    rows += 1;
  }
  for (const [table, tableRows] of Object.entries(exported.records)) {
    if (!tableRows.length) continue;
    csv[table] = toCsv(tableRows);
    rows += tableRows.length;
  }
  const json = { exportedAt, kind: "student" as const, ...exported };
  return {
    id,
    status: "ok",
    json,
    csv,
    documents: documentsOf(exported.records),
    rows,
    bytes: Buffer.byteLength(JSON.stringify(json)),
  };
}

/** A batch's running total against the row and byte ceilings. */
export class ExportBudget {
  private rows = 0;
  private bytes = 0;
  constructor(
    private readonly maxRows = MAX_BATCH_ROWS,
    private readonly maxBytes = MAX_BATCH_BYTES
  ) {}
  /** Adds a student's size; false when it takes the batch over either ceiling. */
  take(rows: number, bytes: number): boolean {
    this.rows += rows;
    this.bytes += bytes;
    return this.rows <= this.maxRows && this.bytes <= this.maxBytes;
  }
}

export type SummaryRow = {
  name: string | null;
  email: string | null;
  gradYear: string | null;
  status: "active" | "archived";
  colleges: number;
  tasks: number;
  documents: number;
  essays: number;
  meetings: number;
};

/** Tables counted per student on the roster summary, and the column each fills. */
export const SUMMARY_COUNTS = [
  ["colleges", "student_colleges"],
  ["tasks", "deliverables"],
  ["documents", "documents"],
  ["essays", "essays"],
  ["meetings", "meetings"],
] as const;

const SUMMARY_HEADER = ["Name", "Email", "Grad year", "Status", "Colleges", "Tasks", "Documents", "Essays", "Meetings"];

/** The roster summary as CSV, one row per student, every cell guarded (Sheets runs formulas from an imported CSV). */
export function rosterSummaryCsv(rows: readonly SummaryRow[]): string {
  const lines = [SUMMARY_HEADER.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.name, r.email, r.gradYear, r.status, r.colleges, r.tasks, r.documents, r.essays, r.meetings].map(csvCell).join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}
