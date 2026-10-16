/**
 * Is step 2 usable here? Three answers, in this order:
 *  - the practice isn't in the rollout: 403 imports_not_enabled;
 *  - the step-2 migrations aren't applied: 503 imports_unavailable;
 *  - IMPORT_DATABASE_URL isn't set: 503.
 *
 * The migration probe asks for public.imports_step2_ready(), the last object
 * the last step-2 migration creates, so a database with only some of the
 * files applied answers "not ready" rather than failing call by call. A ready
 * answer is kept for the process; a missing one is asked again after 30 s
 * (the same shape as lib/axis/failsafe.ts). Step-1 routes (held data,
 * commit, undo, status) never ask this.
 */

import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { hasImportWorker } from "../../env.js";
import { HttpError } from "../errors.js";
import { importsEnabledFor } from "./rollout.js";

const MISSING_TTL_MS = 30_000;
let ready = false;
let missingUntil = 0;

/** For tests. */
export function resetAvailabilityCache(): void {
  ready = false;
  missingUntil = 0;
}

export async function step2Migrated(request: FastifyRequest): Promise<boolean> {
  if (ready) return true;
  if (Date.now() < missingUntil) return false;
  const { data, error } = await request.db.rpc("imports_step2_ready");
  if (!error && data === true) {
    ready = true;
    return true;
  }
  // A missing function is cached briefly; any other error is answered as
  // "not ready" without caching, so a blip doesn't hide the page for 30 s.
  if (error?.code === "PGRST202" || error?.code === "42883") missingUntil = Date.now() + MISSING_TTL_MS;
  return false;
}

/** The sweep's version, on the worker connection (no request there). */
export async function step2MigratedOnWorker(c: PoolClient): Promise<boolean> {
  const { rows } = await c.query("select to_regprocedure('public.imports_step2_ready()') is not null as ok");
  return rows[0]?.ok === true;
}

export const notEnabled = () => new HttpError(403, "Importing files isn't switched on for your practice yet", "imports_not_enabled");
export const unavailableNow = () => new HttpError(503, "Imports need a database update before they can run.", "imports_unavailable");
export const noWorker = () => new HttpError(503, "Imports aren't set up on this server yet", "imports_unavailable");

export async function assertImportsReady(request: FastifyRequest): Promise<void> {
  if (!(await importsEnabledFor(request))) throw notEnabled();
  if (!(await step2Migrated(request))) throw unavailableNow();
  if (!hasImportWorker) throw noWorker();
}

/** Is the Import page usable for the caller's practice? The same three questions, answered without throwing. */
export async function step2UsableFor(request: FastifyRequest): Promise<boolean> {
  return hasImportWorker && (await importsEnabledFor(request)) && (await step2Migrated(request));
}
