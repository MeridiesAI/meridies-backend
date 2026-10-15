/**
 * Machine-to-machine routes. Not for the app, and never authenticated with a
 * user JWT: a shared secret from the environment, compared in constant time.
 *
 * Railway cron service (see AGENTS.md, "Scheduled jobs"):
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "$API_URL/internal/accountability/sweep"
 *
 * and monthly, the College Scorecard catalog refresh:
 *     "$API_URL/internal/ingest/scorecard"
 * and weekly, the resource library's link check:
 *     "$API_URL/internal/resources/link-check"
 * and every 5–15 minutes, the import pipeline's sweep:
 *     "$API_URL/internal/imports/sweep"
 * and weekly, the Events Hub's discovery of colleges' upcoming events:
 *     "$API_URL/internal/events/discover"
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { unauthorized, unavailable } from "../lib/errors.js";
import { summarizeHeartbeats, type HeartbeatRow } from "../lib/heartbeat.js";
import { runImportSweep } from "../lib/imports/jobs.js";
import { startEventsDiscovery } from "../lib/eventsDiscovery.js";
import { startLinkCheck } from "../lib/ingest/linkCheck.js";
import { serviceClient } from "../lib/supabase.js";
import { startScorecardIngest } from "../lib/ingest/run.js";
import { runScheduledSweep } from "../lib/sweepSchedule.js";

/**
 * Hash both sides first so the comparison is fixed-length: timingSafeEqual
 * throws on a length mismatch, and branching on length would leak it.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function requireCronSecret(request: FastifyRequest): Promise<void> {
  const expected = env.CRON_SECRET;
  if (!expected) throw unavailable("Scheduled jobs are not configured");

  const header = request.headers.authorization ?? "";
  const [scheme, value] = header.split(" ");
  const presented = scheme?.toLowerCase() === "bearer" ? (value ?? "").trim() : "";
  if (!presented || !secretMatches(presented, expected)) throw unauthorized();
}

export default async function internalRoutes(app: FastifyInstance) {
  app.post(
    "/accountability/sweep",
    {
      preHandler: [requireCronSecret],
      // A cron fires a few times an hour; anything faster is a guessing attempt.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const outcome = await runScheduledSweep(request.log, "cron");
      if (!outcome.ran) {
        if (outcome.reason === "locked") {
          return reply.code(409).send({ ran: false, reason: "A sweep is already running" });
        }
        return reply.code(503).send({
          ran: false,
          reason:
            outcome.reason === "no-service-role"
              ? "Scheduled sweep needs the service role key"
              : "Scheduled sweep could not take its lease",
        });
      }
      return outcome;
    }
  );

  /**
   * Refresh the catalog from College Scorecard. The load takes minutes, longer
   * than a cron's HTTP call should wait, so this starts it under its lease and
   * answers 202; the run records itself in ingest_runs.
   */
  app.post(
    "/ingest/scorecard",
    { preHandler: [requireCronSecret], config: { rateLimit: { max: 4, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const r = await startScorecardIngest(request.log, "cron");
      if (!r.started) {
        if (r.reason === "locked") return reply.code(409).send({ started: false, reason: "An ingest is already running" });
        const reason =
          r.reason === "no-key"
            ? "Set SCORECARD_API_KEY to load the catalog"
            : r.reason === "no-service-role"
              ? "The ingest needs the service role key"
              : "The ingest could not take its lease";
        return reply.code(503).send({ started: false, reason });
      }
      return reply.code(202).send({ started: true });
    }
  );

  /** Weekly: flag library links that stopped answering. 202; recorded in ingest_runs. */
  app.post(
    "/resources/link-check",
    { preHandler: [requireCronSecret], config: { rateLimit: { max: 4, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const r = await startLinkCheck(request.log, "cron");
      if (!r.started) {
        if (r.reason === "locked") return reply.code(409).send({ started: false, reason: "A link check is already running" });
        return reply.code(503).send({ started: false, reason: "The link check needs the service role key and its lease" });
      }
      return reply.code(202).send({ started: true });
    }
  );

  /**
   * Weekly: the colleges most listed across rosters, each searched on its own
   * site for upcoming events (lib/eventsDiscovery.ts). 202; the run records
   * itself in ingest_runs and job_heartbeats.
   */
  app.post(
    "/events/discover",
    { preHandler: [requireCronSecret], config: { rateLimit: { max: 4, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const r = await startEventsDiscovery(request.log, "cron");
      if (!r.started) {
        if (r.reason === "locked") return reply.code(409).send({ started: false, reason: "Event discovery is already running" });
        const reason =
          r.reason === "no-key"
            ? "Set ANTHROPIC_API_KEY to discover events"
            : r.reason === "no-service-role"
              ? "Event discovery needs the service role key"
              : "Event discovery could not take its lease";
        return reply.code(503).send({ started: false, reason });
      }
      return reply.code(202).send({ started: true });
    }
  );

  /**
   * Every 5–15 minutes: finish import jobs a crash or deploy left waiting,
   * expire held data (warning 7 days before) and compact changes past the
   * 30-day undo window.
   */
  app.post(
    "/imports/sweep",
    { preHandler: [requireCronSecret], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const r = await runImportSweep(request.log);
      if (!r.ran) {
        if (r.reason === "locked") return reply.code(409).send({ ran: false, reason: "An import sweep is already running" });
        const reason =
          r.reason === "no-worker"
            ? "Set IMPORT_DATABASE_URL to run import jobs"
            : r.reason === "no-service-role"
              ? "The import sweep needs the service role key"
              : "The import sweep could not take its lease";
        return reply.code(503).send({ ran: false, reason });
      }
      return r;
    }
  );

  /**
   * For a monitor (an uptime check with a keyword match on "all-ok"): every
   * scheduled job's last clean run, whether it's overdue, and whether its last
   * run failed. 503 when any is overdue, or when a job that runs daily or less
   * often is failing (lib/heartbeat.ts failingAlerts), so a plain status-code
   * monitor alerts too.
   */
  app.get("/status", { preHandler: [requireCronSecret], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (_request, reply) => {
    const svc = serviceClient();
    if (!svc) return reply.code(503).send({ status: "degraded", reason: "no service role key" });
    const { data, error } = await svc.from("job_heartbeats").select("job, last_ok_at, last_error_at, expected_every");
    if (error) return reply.code(503).send({ status: "degraded", reason: "heartbeats unreadable" });
    const summary = summarizeHeartbeats((data ?? []) as HeartbeatRow[]);
    return reply.code(summary.status === "all-ok" ? 200 : 503).send(summary);
  });
}
