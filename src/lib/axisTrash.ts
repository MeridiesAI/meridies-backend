/**
 * The AxIS trash's upkeep (20261110000004, AxIS security PR B; lib/axis/ops/trash.ts has the delete and restore).
 *
 *  - `purgeAxisTrash`: what's past 30 days goes, with the document files the trash kept. The scheduled sweep calls
 *    it (lib/sweepSchedule.ts); it runs at most once an hour across every replica, because it keeps the
 *    `axis-trash-purge` lease for the hour (released at once only when the purge failed, so the next sweep tries).
 *  - `forgetAxisTrash`: an account's deletion removes the trash it made and the trash about it, with their files.
 *
 * Both run on the service client: the database functions are EXECUTE to service_role only and hand back the
 * Storage objects nothing needs any more (no live documents row and no remaining trash row points at them).
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSchemaMissing } from "./axis/failsafe.js";
import { serviceClient } from "./supabase.js";

type Log = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
type Freed = { rows: number; objects: { bucket: string; path: string }[] };

const LEASE_NAME = "axis-trash-purge";
const LEASE_SECONDS = 3600;
/** The bucket a document AxIS deleted keeps its file in; a kept file anywhere else is left alone and logged. */
const BUCKET = "student-documents";
const REMOVE_CHUNK = 100;

function freedFrom(data: unknown): Freed {
  const d = (data ?? {}) as { rows?: unknown; objects?: unknown };
  const objects = (Array.isArray(d.objects) ? d.objects : [])
    .map((o) => o as { bucket?: unknown; storage_path?: unknown })
    .filter((o) => typeof o.bucket === "string" && typeof o.storage_path === "string" && o.storage_path !== "")
    .map((o) => ({ bucket: o.bucket as string, path: o.storage_path as string }));
  return { rows: Number(d.rows) || 0, objects };
}

/** Removes the files; returns how many went. A failed chunk is logged (the trash rows are already gone). */
async function removeFiles(svc: SupabaseClient, objects: Freed["objects"], log: Log): Promise<number> {
  const elsewhere = objects.filter((o) => o.bucket !== BUCKET).length;
  if (elsewhere > 0) log.warn({ count: elsewhere }, "axis trash: kept files outside student-documents left in place");
  const paths = [...new Set(objects.filter((o) => o.bucket === BUCKET).map((o) => o.path))];
  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK);
    const { error } = await svc.storage.from(BUCKET).remove(chunk);
    if (error) log.error({ err: error.message, count: chunk.length }, "axis trash: removing kept files failed");
    else removed += chunk.length;
  }
  return removed;
}

/** The hourly purge. Never throws: a failure is logged and the next sweep tries again. */
export async function purgeAxisTrash(log: Log): Promise<{ rows: number; objects: number }> {
  const none = { rows: 0, objects: 0 };
  const svc = serviceClient();
  if (!svc) return none;
  try {
    const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
    const { data: acquired, error: leaseErr } = await svc.rpc("acquire_job_lease", {
      p_name: LEASE_NAME,
      p_holder: holder,
      p_ttl_seconds: LEASE_SECONDS,
    });
    if (leaseErr) {
      log.error({ code: leaseErr.code }, "axis trash purge: lease unavailable, skipped");
      return none;
    }
    // Purged within the hour, here or on another replica.
    if (acquired !== true) return none;

    const { data, error } = await svc.rpc("axis_trash_purge", {});
    if (error) {
      // Before the migration there is nothing to purge: keep the lease and ask again in an hour.
      if (isSchemaMissing(error)) return none;
      await svc.rpc("release_job_lease", { p_name: LEASE_NAME, p_holder: holder });
      log.error({ code: error.code }, "axis trash purge failed");
      return none;
    }
    const freed = freedFrom(data);
    const objects = await removeFiles(svc, freed.objects, log);
    if (freed.rows > 0) log.info({ rows: freed.rows, objects }, "axis trash purged");
    return { rows: freed.rows, objects };
  } catch (err) {
    log.error({ err }, "axis trash purge failed");
    return none;
  }
}

/**
 * An account's deletion: the trash it made and the trash about it, with their files. Throws when the database
 * refuses (the route then refuses the deletion, so nothing is left behind); before the migration there is no trash.
 */
export async function forgetAxisTrash(userId: string, log: Log): Promise<void> {
  const svc = serviceClient();
  if (!svc) throw new Error("axis trash forget needs the service role key");
  const { data, error } = await svc.rpc("axis_trash_forget", { p_user: userId });
  if (error) {
    if (isSchemaMissing(error)) return;
    throw new Error(`axis trash forget failed (${error.code ?? "unknown"})`);
  }
  const freed = freedFrom(data);
  const objects = await removeFiles(svc, freed.objects, log);
  if (freed.rows > 0) log.info({ rows: freed.rows, objects }, "axis trash forgotten for a deleted account");
}
