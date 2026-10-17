/**
 * Does the database have what this build reads?
 *
 * Railway deploys `main` the moment a pull request merges, and migrations are
 * applied to Supabase by hand. A build that lands before its migration fails
 * every signed-in request (app.authenticate selects the new column), which is
 * what happened on 2026-10-10. /health reports the answer from here, and
 * railway.json points Railway's healthcheck at /health, so a build whose
 * schema is not there never goes live: the previous deployment keeps serving.
 *
 * WHEN A MIGRATION ADDS SOMETHING THE CODE CANNOT RUN WITHOUT, add it below
 * in the same pull request. Keep the list short: only what would break
 * requests across the board, not every column a single feature reads.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const REQUIRED_SCHEMA: Record<string, string[]> = {
  // 20261017000001: read by app.authenticate on every signed-in request.
  profiles: ["counselor_approved_at", "counselor_approved_via", "counselor_revoked_at"],
  // 20261017000001: the account review link.
  counselor_access_requests: ["token_hash", "superseded_by"],
  // 20261024000001: the context layer's documents loader selects it on every AxIS read.
  documents: ["kind_confirmed"],
};

/** PostgREST's ways of saying "no such column" and "no such table". */
const MISSING = new Set(["42703", "42P01", "PGRST204", "PGRST205"]);
const PROBE_TIMEOUT_MS = 2000;

/**
 * The required tables whose columns are not all there, as "table(col, col)".
 * One GET with limit 0 per table: no rows cross the wire. (Not a HEAD: a HEAD
 * error carries no body, so there would be no code to read.) Only a definite
 * "missing" answer counts. Permission denied means the table exists, and a
 * timeout or any other error is the database probe's business, not a reason
 * to call the schema wrong.
 */
export async function missingSchema(
  db: SupabaseClient,
  required: Record<string, string[]> = REQUIRED_SCHEMA
): Promise<string[]> {
  const results = await Promise.all(
    Object.entries(required).map(async ([table, columns]) => {
      try {
        const { error } = await db
          .from(table)
          .select(columns.join(","))
          .limit(0)
          .abortSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS));
        return error?.code && MISSING.has(error.code) ? `${table}(${columns.join(", ")})` : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((r): r is string => r !== null);
}
