/**
 * Machine-to-machine routes. Not for the app, and never authenticated with a
 * user JWT: a shared secret from the environment, compared in constant time.
 *
 * Railway cron service (see AGENTS.md, "Scheduled jobs"):
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "$API_URL/internal/accountability/sweep"
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { unauthorized, unavailable } from "../lib/errors.js";
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
}
