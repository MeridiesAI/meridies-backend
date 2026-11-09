/**
 * The real-model evals' clock control (AxIS activity drafts, spec 4.10): moves AxIS's clock forward so the
 * 30-minute draft expiry can be tested without editing database rows.
 *
 * Registered only in eval clock mode (AXIS_EVAL_CLOCK=on), which refuses to boot with NODE_ENV=production or
 * anything but a local Supabase stack (lib/axis/clock.ts evalClockRefusal, checked in src/index.ts). Behind the cron
 * secret like the scheduled jobs.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { advanceClock, axisNow } from "../lib/axis/clock.js";
import { requireCronSecret } from "./internal.js";

const body = z.object({ minutes: z.number().int().min(1).max(1440) }).strict();

export default async function axisEvalRoutes(app: FastifyInstance) {
  app.post("/clock", { preHandler: [requireCronSecret] }, async (request) => {
    const { minutes } = body.parse(request.body);
    advanceClock(minutes * 60_000);
    return { now: axisNow().toISOString() };
  });
}
