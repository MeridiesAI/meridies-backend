import type { FastifyInstance } from "fastify";
import { hasServiceRole } from "../env.js";
import { anthropicKeyWorks } from "../lib/anthropic.js";
import { anonClient, serviceClient } from "../lib/supabase.js";

const PROBE_TIMEOUT_MS = 2000;
/** Reuse a result briefly so a hammered /health is not a database load test. */
const PROBE_CACHE_MS = 5000;

let cached: { at: number; ok: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

/**
 * One HEAD request against a small catalog table — no rows cross the wire.
 * Any error, including the timeout, reads as unreachable; the error itself is
 * logged server-side and never returned, since it can carry the project URL.
 */
async function probeDatabase(log: FastifyInstance["log"]): Promise<boolean> {
  const db = serviceClient() ?? anonClient();
  try {
    const { error } = await db
      .from("colleges")
      .select("id", { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    if (error) {
      log.warn({ code: error.code }, "health: database probe failed");
      return false;
    }
    return true;
  } catch {
    log.warn("health: database probe failed or timed out");
    return false;
  }
}

async function databaseReachable(log: FastifyInstance["log"]): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.ok;
  if (!inFlight) {
    inFlight = probeDatabase(log)
      .then((ok) => {
        cached = { at: Date.now(), ok };
        return ok;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    const [database, anthropic] = await Promise.all([databaseReachable(app.log), anthropicKeyWorks(app.log)]);
    // Config presence and reachability only — never values, URLs or error text.
    // `anthropic` is whether the key is accepted, not merely set. AxIS being
    // down doesn't make the API unhealthy, so only the database sets the code.
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "degraded",
      database,
      anthropic,
      serviceRole: hasServiceRole,
    });
  });
}
