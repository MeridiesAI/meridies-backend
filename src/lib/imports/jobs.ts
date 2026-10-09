/**
 * Running import jobs (spec §5.7–§5.10).
 *
 * The route requests a job (a status change under RLS) and kicks it here at
 * once; the cron sweep picks up any job still waiting after a minute (a
 * crash, a deploy). Each job is one transaction on the import_worker
 * connection; the SQL function locks with SKIP LOCKED, so the kick and the
 * sweep can never both apply the same import.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { beat } from "../heartbeat.js";
import { brandedEmail, brandedText, sendEmail } from "../email.js";
import { serviceClient } from "../supabase.js";
import { env } from "../../env.js";
import { withWorkerTransaction } from "./db.js";

export type ImportJobKind = "commit" | "undo" | "apply";
export type ImportJobOutcome = { status: string } & Record<string, unknown>;

type Log = {
  info: (o: object | string, m?: string) => void;
  warn: (o: object | string, m?: string) => void;
  error: (o: object | string, m?: string) => void;
};

const FUNCTION_FOR: Record<ImportJobKind, string> = {
  commit: "public.commit_import",
  undo: "public.undo_import",
  apply: "public.apply_held_item",
};

const FAILURE_MESSAGE = "Couldn't save. Nothing was changed. Try again.";

const BUSY_ATTEMPTS = 3;
const BUSY_RETRY_MS = 2000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runImportJob(
  kind: ImportJobKind,
  id: string,
  actor: string,
  log: Log
): Promise<ImportJobOutcome> {
  try {
    let out: ImportJobOutcome = { status: "busy" };
    for (let attempt = 1; attempt <= BUSY_ATTEMPTS; attempt++) {
      out = await withWorkerTransaction(async (c) => {
        const { rows } = await c.query(`select ${FUNCTION_FOR[kind]}($1, $2) as out`, [id, actor]);
        return rows[0].out as ImportJobOutcome;
      });
      // Busy means another worker holds the lock; the sweep is the backstop.
      if (out.status !== "busy" || attempt === BUSY_ATTEMPTS) break;
      await sleep(BUSY_RETRY_MS);
    }
    return out;
  } catch (err) {
    log.error({ err, kind, id }, "import job failed; rolled back");
    await withWorkerTransaction((c) =>
      c.query("select public.fail_import_job($1, $2, $3)", [kind, id, FAILURE_MESSAGE])
    ).catch((e: unknown) => log.error({ err: e, kind, id }, "import job: could not record the failure"));
    return { status: "failed" };
  }
}

/** Fire-and-forget after the HTTP reply; the client polls for the result. */
export function kickImportJob(kind: ImportJobKind, id: string, actor: string, log: Log): void {
  setImmediate(() => {
    void runImportJob(kind, id, actor, log);
  });
}

export type ImportSweepOutcome =
  | { ran: true; jobs: number; expired: number; warned: number; compacted: number }
  | { ran: false; reason: "no-service-role" | "no-worker" | "locked" | "lease-error" };

const LEASE = "import-sweep";
const LEASE_TTL_SECONDS = 15 * 60;
const STALE_SECONDS = 60;

export async function runImportSweep(log: Log): Promise<ImportSweepOutcome> {
  const svc = serviceClient();
  if (!svc) return { ran: false, reason: "no-service-role" };
  if (!env.IMPORT_DATABASE_URL) return { ran: false, reason: "no-worker" };

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error: leaseErr } = await svc.rpc("acquire_job_lease", {
    p_name: LEASE,
    p_holder: holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (leaseErr) return { ran: false, reason: "lease-error" };
  if (acquired !== true) return { ran: false, reason: "locked" };

  try {
    const due = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select kind, id, actor from public.import_jobs_due($1)", [STALE_SECONDS]);
      return rows as Array<{ kind: ImportJobKind; id: string; actor: string }>;
    });
    for (const job of due) await runImportJob(job.kind, job.id, job.actor, log);

    const holds = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select public.expire_import_holds() as out");
      return rows[0].out as { expired: number; warn: HoldWarning[] };
    });
    for (const w of holds.warn) await warnHoldExpiring(w, log);

    const compacted = await withWorkerTransaction(async (c) => {
      const { rows } = await c.query("select public.compact_imports() as n");
      return Number(rows[0].n);
    });

    await beat("import-sweep", true, undefined, log);
    const outcome = { ran: true as const, jobs: due.length, expired: holds.expired, warned: holds.warn.length, compacted };
    log.info(outcome, "import sweep finished");
    return outcome;
  } catch (err) {
    await beat("import-sweep", false, err instanceof Error ? err.message : String(err), log);
    throw err;
  } finally {
    const { error } = await svc.rpc("release_job_lease", { p_name: LEASE, p_holder: holder });
    if (error) log.warn({ code: error.code }, "import sweep: lease release failed");
  }
}

type HoldWarning = {
  itemId: string;
  counselorId: string;
  counselorEmail: string;
  counselorName: string | null;
  importedName: string | null;
  heldUntil: string;
};

/** In-app and email, 7 days before held data expires (§5.8). */
async function warnHoldExpiring(w: HoldWarning, log: Log): Promise<void> {
  const svc = serviceClient();
  const who = w.importedName ?? "A student";
  const when = new Date(w.heldUntil).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const title = `${who}'s imported data expires ${when}`;
  const body = "Review it in Ready to apply before then, or it will be deleted.";
  const href = "/dashboard/counselor/imports/held";
  if (svc) {
    const { error } = await svc.from("notifications").insert({
      recipient_id: w.counselorId,
      kind: "system",
      urgency: "high",
      title,
      body,
      href,
    });
    if (error) log.warn({ code: error.code, itemId: w.itemId }, "hold warning: notification insert failed");
  }
  const email = {
    heading: title,
    paragraphs: [body],
    cta: { label: "Open Ready to apply", url: `${env.APP_URL}${href}` },
  };
  await sendEmail({
    to: w.counselorEmail,
    subject: title,
    html: brandedEmail(email),
    text: brandedText(email),
    template: "import-hold-expiring",
    recipient_kind: "counselor",
    recipient_id: w.counselorId,
  });
}
