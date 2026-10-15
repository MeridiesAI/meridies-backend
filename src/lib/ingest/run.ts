/**
 * Starting an ingest outside a request: one runner at a time, under a Postgres
 * lease (the same acquire/release pair the accountability sweep uses).
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { env } from "../../env.js";
import { beat } from "../heartbeat.js";
import { serviceClient } from "../supabase.js";
import { loadPicks, runCollegePhotoIngest, supabasePhotoStore, type PhotoOutcome } from "./collegePhotos.js";
import { runScorecardIngest, scorecardFetcher, type IngestOutcome } from "./scorecard.js";
import { wikimediaClient } from "./wikimedia.js";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

const LEASE = "scorecard-ingest";
/** A full load is ~30 pages; two hours covers a slow API with retries. */
const LEASE_TTL_SECONDS = 2 * 60 * 60;

export type StartResult =
  | { started: true; holder: string; done: Promise<IngestOutcome | null> }
  | { started: false; reason: "no-key" | "no-service-role" | "locked" | "lease-error" };

export async function startScorecardIngest(
  log: Log,
  trigger: "manual" | "cron" | "script",
  opts: { maxPages?: number } = {}
): Promise<StartResult> {
  if (!env.SCORECARD_API_KEY) return { started: false, reason: "no-key" };
  const svc = serviceClient();
  if (!svc) return { started: false, reason: "no-service-role" };

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error } = await svc.rpc("acquire_job_lease", {
    p_name: LEASE,
    p_holder: holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error) {
    log.error({ code: error.code }, "scorecard ingest: lease unavailable");
    return { started: false, reason: "lease-error" };
  }
  if (!acquired) return { started: false, reason: "locked" };

  const done = runScorecardIngest(svc, scorecardFetcher(env.SCORECARD_API_KEY), log, { trigger, ...opts })
    .then(async (outcome) => {
      log.info({ ...outcome, errors: outcome.errors.length }, "scorecard ingest: finished");
      await beat("scorecard-ingest", outcome.status !== "failed", outcome.errors[0], log as never);
      return outcome;
    })
    .catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : "unknown" }, "scorecard ingest: crashed");
      return null;
    })
    .finally(async () => {
      await svc.rpc("release_job_lease", { p_name: LEASE, p_holder: holder });
    });
  return { started: true, holder, done };
}

// ---- College photos ---------------------------------------------------------------

const PHOTO_LEASE = "college-photos";
/** A first full load is ~6,000 downloads at two at a time; three hours covers it. */
const PHOTO_LEASE_TTL_SECONDS = 3 * 60 * 60;

export type PhotoStartResult =
  | { started: true; holder: string; done: Promise<PhotoOutcome | null> }
  | { started: false; reason: "no-service-role" | "no-schema" | "locked" | "lease-error" };

/**
 * The monthly photo load (lib/ingest/collegePhotos.ts) under its lease. A dry
 * run doesn't come through here: it writes nothing and must not mark the job
 * healthy, so scripts/ingest/college-photos.ts runs it directly.
 */
export async function startCollegePhotoIngest(
  log: Log,
  trigger: "manual" | "cron" | "script",
  opts: { limit?: number; only?: number[] } = {}
): Promise<PhotoStartResult> {
  const svc = serviceClient();
  if (!svc) return { started: false, reason: "no-service-role" };
  const store = supabasePhotoStore(svc);
  // Before the lease and the ingest_runs row: that insert fails on its CHECK
  // until the migration adds the 'college-photos' label.
  if ((await store.probe()) === "no-schema") return { started: false, reason: "no-schema" };

  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error } = await svc.rpc("acquire_job_lease", {
    p_name: PHOTO_LEASE,
    p_holder: holder,
    p_ttl_seconds: PHOTO_LEASE_TTL_SECONDS,
  });
  if (error) {
    log.error({ code: error.code }, "college photos: lease unavailable");
    return { started: false, reason: "lease-error" };
  }
  if (!acquired) return { started: false, reason: "locked" };

  const wm = wikimediaClient();
  const deps = { sparql: wm.sparql, imageinfo: wm.imageinfo, download: wm.download, picks: () => loadPicks() };
  const done = runCollegePhotoIngest(store, deps, log, { trigger, ...opts })
    .then(async (outcome) => {
      // Held deletions are reported as an error so the heartbeat records them;
      // last_ok_at still moves when everything else ran.
      const ok = outcome.status !== "failed";
      if (ok) await beat("college-photos", true, undefined, log as never);
      if (!ok || outcome.held > 0) await beat("college-photos", false, outcome.errors[0], log as never);
      return outcome;
    })
    .catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : "unknown" }, "college photos: crashed");
      return null;
    })
    .finally(async () => {
      await svc.rpc("release_job_lease", { p_name: PHOTO_LEASE, p_holder: holder });
    });
  return { started: true, holder, done };
}
