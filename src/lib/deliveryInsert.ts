/**
 * Insert a message_deliveries row, surviving a database that does not have
 * an optional link column yet: `invitation_id` (migration 20261018000002) or
 * `meeting_id` (20261023090001), each applied by hand, possibly later than
 * the code. Without the column an insert that names it fails outright, which
 * would drop the delivery row of every invite email. So: when the insert is
 * refused for one of those columns, drop that column and retry, and remember
 * for a few minutes that it is missing, so later inserts leave it out up
 * front instead of failing first every time. Postgres names one missing
 * column per error, so a row naming both may take two retries; each column
 * is cached on its own. Once the migration is in, the cache expires and rows
 * carry their link again.
 */

type Row = Record<string, unknown>;
type Result = { data: Row | null; error: { code?: string; message: string } | null };
export type DeliveryInserter = (row: Row) => Promise<Result>;

export const MISSING_COLUMN_TTL_MS = 5 * 60_000;

export const OPTIONAL_COLUMNS = ["invitation_id", "meeting_id"] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

const missingUntil: Record<OptionalColumn, number> = { invitation_id: 0, meeting_id: 0 };

/** For tests. */
export function resetDeliveryColumnCache(): void {
  for (const c of OPTIONAL_COLUMNS) missingUntil[c] = 0;
}

/** Postgres "undefined column" or PostgREST's schema-cache miss, naming this column. */
export function isMissingColumn(error: { code?: string; message: string } | null, column: OptionalColumn): boolean {
  if (!error) return false;
  return (error.code === "42703" || error.code === "PGRST204") && new RegExp(`\\b${column}\\b`).test(error.message);
}

export function isMissingInvitationColumn(error: { code?: string; message: string } | null): boolean {
  return isMissingColumn(error, "invitation_id");
}

/** The meeting_id foreign key refused the row: the meeting was deleted in the meantime. */
export function isGoneMeeting(error: { code?: string; message: string } | null): boolean {
  return error?.code === "23503" && /meeting_id/.test(error.message);
}

function without(row: Row, column: OptionalColumn): Row {
  const { [column]: _dropped, ...rest } = row;
  return rest;
}

export async function insertDelivery(insert: DeliveryInserter, row: Row, now: number = Date.now()): Promise<Result> {
  let current = row;
  for (const c of OPTIONAL_COLUMNS) {
    if (c in current && now < missingUntil[c]) current = without(current, c);
  }
  for (let retries = 0; ; retries++) {
    const result = await insert(current);
    if (retries > OPTIONAL_COLUMNS.length) return result;
    // A meeting deleted while its invites were still going out: keep the row, unlinked.
    if ("meeting_id" in current && isGoneMeeting(result.error)) {
      current = without(current, "meeting_id");
      continue;
    }
    const missing = OPTIONAL_COLUMNS.find((c) => c in current && isMissingColumn(result.error, c));
    if (!missing) return result;
    missingUntil[missing] = now + MISSING_COLUMN_TTL_MS;
    current = without(current, missing);
  }
}
