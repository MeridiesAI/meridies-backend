/**
 * Insert a message_deliveries row, surviving a database that does not have
 * `invitation_id` yet (migration 20261018000002 applied by hand, later than
 * the code). Without the column an insert that names it fails outright, which
 * would drop the delivery row of every invite email. So: when the insert is
 * refused for that column, retry once without it, and remember for a few
 * minutes that the column is missing, so later inserts leave it out up front
 * instead of failing first every time. Once the migration is in, the cache
 * expires and invite rows carry their invitation again.
 */

type Row = Record<string, unknown>;
type Result = { data: Row | null; error: { code?: string; message: string } | null };
export type DeliveryInserter = (row: Row) => Promise<Result>;

export const MISSING_COLUMN_TTL_MS = 5 * 60_000;

let missingUntil = 0;

/** For tests. */
export function resetDeliveryColumnCache(): void {
  missingUntil = 0;
}

/** Postgres "undefined column" or PostgREST's schema-cache miss, naming invitation_id. */
export function isMissingInvitationColumn(error: { code?: string; message: string } | null): boolean {
  if (!error) return false;
  return (error.code === "42703" || error.code === "PGRST204") && /invitation_id/.test(error.message);
}

export async function insertDelivery(insert: DeliveryInserter, row: Row, now: number = Date.now()): Promise<Result> {
  const hasColumn = "invitation_id" in row;
  if (hasColumn && now < missingUntil) {
    const { invitation_id: _dropped, ...rest } = row;
    return insert(rest);
  }
  const first = await insert(row);
  if (!hasColumn || !isMissingInvitationColumn(first.error)) return first;
  missingUntil = now + MISSING_COLUMN_TTL_MS;
  const { invitation_id: _dropped, ...rest } = row;
  return insert(rest);
}
