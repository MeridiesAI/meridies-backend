/**
 * Paged table reads for the data exports (`routes/account.ts`).
 *
 * PostgREST answers at most `max_rows` (1,000, supabase/config.toml) rows a
 * query whatever `.limit()` asks, so a single read silently cut every export
 * table at 1,000 rows. Each table is now read in pages of `PAGE_SIZE` in a
 * stable order (`ORDER_KEYS`: the table's primary key) until an EMPTY page
 * (never a short one: max_rows may be lower than the page) or the per-table
 * cap; at the cap a one-row probe says whether anything was left out, and only then is the table reported `truncated`.
 */

export const PAGE_SIZE = 1000;
export const TABLE_ROW_CAP = 5000;

/** Thrown from `onPage` to stop a read (a size budget ran out). */
export class ReadStopped extends Error {
  constructor() {
    super("read stopped");
    this.name = "ReadStopped";
  }
}

/**
 * Stable order per table: the primary key. Tables keyed by student alone have one row per student;
 * `meeting_attendees` is (meeting_id, student_id), so per student meeting_id is unique.
 */
export const ORDER_KEYS: Record<string, readonly string[]> = {
  alumni_records: ["student_id"],
  deliverable_documents: ["deliverable_id", "document_id"],
  intake_responses: ["student_id"],
  meeting_attendees: ["meeting_id"],
  scholarship_match_prefs: ["student_id"],
  student_academics: ["student_id"],
  student_aid_profiles: ["student_id"],
  student_alert_prefs: ["student_id"],
  student_personal_details: ["student_id"],
  student_private_notes: ["student_id"],
  student_status_overrides: ["student_id"],
};

export function orderKeysFor(table: string): readonly string[] {
  return ORDER_KEYS[table] ?? ["id"];
}

type Row = Record<string, unknown>;
export type PageFetch = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;

/**
 * Reads pages [from, to] (inclusive, PostgREST's `range`) until an empty page or `cap` rows. An error is
 * returned with the rows read so far, never thrown; `onPage` may throw (ReadStopped) to stop, discarding the
 * read. `stop`, asked after each page, ends it the way the cap does instead: the rows so far are kept, and a
 * one-row probe decides `truncated` (a size budget that runs out; lib/axisChatExport.ts).
 */
export async function readPaged(
  fetchPage: PageFetch,
  opts: { pageSize?: number; cap?: number; onPage?: (rows: Row[]) => void; stop?: () => boolean } = {}
): Promise<{ rows: Row[]; truncated: boolean; error: unknown }> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const cap = opts.cap ?? TABLE_ROW_CAP;
  const rows: Row[] = [];
  while (rows.length < cap) {
    const from = rows.length;
    const to = Math.min(from + pageSize, cap) - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) return { rows, truncated: false, error };
    const page = ((data ?? []) as Row[]).slice(0, to - from + 1);
    if (page.length) opts.onPage?.(page);
    rows.push(...page);
    // Only an empty page ends the table: a short one may just be the server's max_rows, which can be lower
    // than the page asked for. `from` moves on by the rows actually received.
    if (page.length === 0) return { rows, truncated: false, error: null };
    if (opts.stop?.()) break;
  }
  const probe = await fetchPage(rows.length, rows.length);
  if (probe.error) return { rows, truncated: false, error: probe.error };
  return { rows, truncated: (probe.data ?? []).length > 0, error: null };
}

// Offsets are not a snapshot: a row inserted or deleted between two pages can be read twice or missed at a
// page boundary. Good enough for an export; a consistent copy would need one transaction.
