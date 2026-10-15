/**
 * Retention (spec §5.10, §7.6), run by the import sweep on every pass:
 * drafts and reviews never saved expire after 7 days with their staged
 * values, invitations never sent expire 14 days after the save, sent ones
 * when the invitation does, masked samples go at commit, raw files once an
 * import is saved, undone or expired, and objects nobody registered after
 * 24 hours.
 *
 * Acts for no counselor: it deletes only raw files in the private `imports`
 * bucket and staged values whose time is up. The database decides what is
 * due (import_retention, import_files_to_delete, import_orphan_objects on the
 * worker connection); the service client only removes objects through the
 * Storage API, which Supabase requires (rows in storage.objects can't be
 * deleted directly).
 *
 * Before the step-2 migrations the probe answers false and this step is
 * skipped; any failure here is logged and isolated, so it never fails the
 * sweep's heartbeat.
 */

import { serviceClient } from "../supabase.js";
import { step2MigratedOnWorker } from "./availability.js";
import { withWorkerTransaction } from "./db.js";

type Log = { info: (o: object | string, m?: string) => void; warn: (o: object | string, m?: string) => void };

export type RetentionOutcome =
  | { ran: false; reason: "not-migrated" | "no-service-role" | "failed" }
  | { ran: true; expiredDrafts: number; unsentExpired: number; unacceptedExpired: number; profilesWiped: number; stuckStaging: number; filesDeleted: number; orphansDeleted: number };

const BATCH = 200;

async function removeObjects(paths: string[], log: Log): Promise<boolean> {
  const svc = serviceClient();
  if (!svc || paths.length === 0) return paths.length === 0;
  const { error } = await svc.storage.from("imports").remove(paths);
  if (error) {
    log.warn({ count: paths.length }, "import retention: storage removal failed; the next sweep retries");
    return false;
  }
  return true;
}

export async function runImportRetention(log: Log): Promise<RetentionOutcome> {
  try {
    if (!(await withWorkerTransaction((c) => step2MigratedOnWorker(c)))) return { ran: false, reason: "not-migrated" };
    if (!serviceClient()) return { ran: false, reason: "no-service-role" };

    const db = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select public.import_retention() as out");
      return rows[0].out as Record<string, number>;
    });

    const due = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select file_id, storage_path from public.import_files_to_delete($1)", [BATCH]);
      return rows as Array<{ file_id: string; storage_path: string }>;
    });
    let filesDeleted = 0;
    if (due.length > 0 && (await removeObjects(due.map((d) => d.storage_path), log))) {
      filesDeleted = await withWorkerTransaction(async (c) => {
        const { rows } = await c.query("select public.import_mark_files_deleted($1::uuid[]) as n", [due.map((d) => d.file_id)]);
        return Number(rows[0].n);
      });
    }

    const orphans = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select name from public.import_orphan_objects($1)", [BATCH]);
      return rows.map((r) => String(r.name));
    });
    const orphansDeleted = orphans.length > 0 && (await removeObjects(orphans, log)) ? orphans.length : 0;

    const out = {
      ran: true as const,
      expiredDrafts: Number(db.expiredDrafts ?? 0),
      unsentExpired: Number(db.unsentExpired ?? 0),
      unacceptedExpired: Number(db.unacceptedExpired ?? 0),
      profilesWiped: Number(db.profilesWiped ?? 0),
      stuckStaging: Number(db.stuckStaging ?? 0),
      filesDeleted,
      orphansDeleted,
    };
    log.info(out, "import retention finished");
    return out;
  } catch (err) {
    log.warn({ code: (err as { code?: string } | null)?.code }, "import retention failed; the next sweep retries");
    return { ran: false, reason: "failed" };
  }
}
