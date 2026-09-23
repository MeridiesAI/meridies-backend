/**
 * The scheduled accountability sweep.
 *
 * `runEscalationSweep` (lib/accountability.ts) is the rule; this file is only
 * *when* and *for whom*. Two triggers share it:
 *
 *  - `POST /internal/accountability/sweep`, called by a Railway cron service
 *    with `Authorization: Bearer $CRON_SECRET` (routes/internal.ts).
 *  - an optional in-process interval, `SWEEP_INTERVAL_MINUTES`, which every
 *    replica starts.
 *
 * Either way a run takes the `accountability-sweep` lease in Postgres first, so
 * two replicas (or the cron and an interval) never sweep at once. The per-flag
 * claim inside the sweep is the second line: even a run that outlives its lease
 * cannot queue the same escalation twice.
 *
 * It runs on the service-role client, so RLS is not scoping anything: each
 * counselor's sweep is handed exactly the students whose `counselor_id` is that
 * counselor, derived here from `profiles`, never from a caller.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { runEscalationSweep } from "./accountability.js";
import { serviceClient } from "./supabase.js";

const LEASE_NAME = "accountability-sweep";
/** Long enough for a large roster; a crashed holder frees it after this. */
const LEASE_TTL_SECONDS = 15 * 60;
/** Flags read per scheduled run, and per counselor within it. */
const MAX_DUE_FLAGS = 2000;
const PER_COUNSELOR_LIMIT = 100;
const ID_CHUNK = 200;

type Log = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export type SweepTrigger = "manual" | "cron" | "interval";

export type SweepAuditSummary = {
  actorId: string | null;
  trigger: SweepTrigger;
  counselors: number;
  escalated: number;
  skipped: number;
  failedCounselors: number;
  durationMs: number;
};

export type ScheduledSweepOutcome =
  | { ran: false; reason: "no-service-role" | "locked" | "lease-error" }
  | ({ ran: true } & Omit<SweepAuditSummary, "actorId" | "trigger">);

/**
 * One `audit_log` row per sweep run. Service role, because audit_log has no
 * insert policy by design. Never throws: an audit write failing must not turn a
 * completed sweep into an error the caller retries.
 */
export async function recordSweepAudit(log: Log, summary: SweepAuditSummary): Promise<void> {
  const svc = serviceClient();
  if (!svc) return;
  const { actorId, ...metadata } = summary;
  const { error } = await svc.from("audit_log").insert({
    actor_id: actorId,
    action: `accountability.sweep.${summary.trigger}`,
    entity_type: "accountability_sweep",
    metadata,
  });
  if (error) log.warn({ code: error.code }, "accountability sweep: audit_log write failed");
}

/** Students with a due flag, grouped under the counselor who owns them. */
async function dueStudentsByCounselor(
  svc: SupabaseClient,
  now: string
): Promise<Map<string, string[]>> {
  const { data: flags, error } = await svc
    .from("red_flags")
    .select("student_id")
    .eq("status", "open")
    .lt("escalate_at", now)
    .order("escalate_at", { ascending: true })
    .limit(MAX_DUE_FLAGS);
  if (error) throw new Error(`red_flags read failed (${error.code ?? "unknown"})`);

  const studentIds = [...new Set((flags ?? []).map((f) => f.student_id as string))];
  const byCounselor = new Map<string, string[]>();

  for (let i = 0; i < studentIds.length; i += ID_CHUNK) {
    const chunk = studentIds.slice(i, i + ID_CHUNK);
    const { data: students, error: pErr } = await svc
      .from("profiles")
      .select("id, counselor_id")
      .in("id", chunk)
      .not("counselor_id", "is", null)
      // An archived student's family is not chased by automation. The
      // dashboard button still sweeps whatever its RLS read returns.
      .is("archived_at", null);
    if (pErr) throw new Error(`profiles read failed (${pErr.code ?? "unknown"})`);

    for (const s of students ?? []) {
      const cid = s.counselor_id as string;
      if (!byCounselor.has(cid)) byCounselor.set(cid, []);
      byCounselor.get(cid)!.push(s.id as string);
    }
  }
  return byCounselor;
}

/** Sweep every counselor's roster once, under the lease. */
export async function runScheduledSweep(
  log: Log,
  trigger: Exclude<SweepTrigger, "manual">
): Promise<ScheduledSweepOutcome> {
  const svc = serviceClient();
  if (!svc) {
    log.warn(
      "accountability sweep skipped: SUPABASE_SERVICE_ROLE_KEY is not set, and a " +
        "scheduled sweep has no user to run as."
    );
    return { ran: false, reason: "no-service-role" };
  }

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error: leaseErr } = await svc.rpc("acquire_job_lease", {
    p_name: LEASE_NAME,
    p_holder: holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (leaseErr) {
    // Without the lease we cannot promise a single runner, so do not run.
    log.error({ code: leaseErr.code }, "accountability sweep: lease unavailable, skipped");
    return { ran: false, reason: "lease-error" };
  }
  if (acquired !== true) {
    log.info("accountability sweep: another runner holds the lease, skipped");
    return { ran: false, reason: "locked" };
  }

  const startedAt = Date.now();
  let counselors = 0;
  let escalated = 0;
  let skipped = 0;
  let failedCounselors = 0;

  try {
    const byCounselor = await dueStudentsByCounselor(svc, new Date().toISOString());
    counselors = byCounselor.size;

    for (const [counselorId, studentIds] of byCounselor) {
      try {
        const result = await runEscalationSweep({ db: svc }, counselorId, {
          studentIds,
          limit: PER_COUNSELOR_LIMIT,
          log,
        });
        escalated += result.escalated;
        skipped += result.skipped.length;
      } catch (err) {
        // One counselor's failure must not starve the rest of the practice list.
        failedCounselors += 1;
        log.error({ err, counselorId }, "accountability sweep: counselor sweep failed");
      }
    }
  } finally {
    const { error } = await svc.rpc("release_job_lease", { p_name: LEASE_NAME, p_holder: holder });
    if (error) log.warn({ code: error.code }, "accountability sweep: lease release failed");
  }

  const summary = {
    counselors,
    escalated,
    skipped,
    failedCounselors,
    durationMs: Date.now() - startedAt,
  };
  log.info(summary, `accountability sweep (${trigger}) finished`);
  await recordSweepAudit(log, { actorId: null, trigger, ...summary });
  return { ran: true, ...summary };
}

/**
 * The in-process schedule. Off unless SWEEP_INTERVAL_MINUTES is set. Call it
 * while building the app, before `listen`. `running`
 * stops this replica overlapping itself; the lease stops replicas overlapping
 * each other.
 */
export function startSweepInterval(app: FastifyInstance): void {
  const minutes = env.SWEEP_INTERVAL_MINUTES;
  if (!minutes) return;
  if (!serviceClient()) {
    app.log.warn(
      "SWEEP_INTERVAL_MINUTES is set but SUPABASE_SERVICE_ROLE_KEY is not: the " +
        "scheduled accountability sweep will log and skip every run."
    );
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledSweep(app.log, "interval");
    } catch (err) {
      app.log.error({ err }, "accountability sweep (interval) failed");
    } finally {
      running = false;
    }
  };

  // Hooks are registered now (they cannot be added once the app has booted);
  // the timer itself starts only when the server is ready.
  let timer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    timer = setInterval(() => void tick(), minutes * 60_000);
    timer.unref();
    app.log.info(`accountability sweep scheduled every ${minutes} minutes`);
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
}
