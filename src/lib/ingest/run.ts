/**
 * Starting an ingest outside a request: one runner at a time, under a Postgres
 * lease (the same acquire/release pair the accountability sweep uses).
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { env } from "../../env.js";
import { beat } from "../heartbeat.js";
import { serviceClient } from "../supabase.js";
import { runScorecardIngest, scorecardFetcher, type IngestOutcome } from "./scorecard.js";

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
