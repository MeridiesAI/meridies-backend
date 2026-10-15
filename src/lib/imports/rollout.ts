/**
 * Who may use the step-2 Import page (spec §11): a per-practice flag read
 * from the environment, plus the AI kill switch.
 *
 * IMPORTS_ROLLOUT=off|pilot|all (default pilot) and IMPORTS_PILOT, a
 * comma-separated list of practice ids: a firm's id, or a solo counselor's
 * own profile id (the same answer lib/crm.ts gives). The pilot list lives in
 * the environment, so changing it needs a redeploy.
 *
 * "Ready to apply" (GET /imports/held and its apply route) is never gated:
 * held data from the old roster flow lands there for every counselor.
 */

import type { FastifyRequest } from "fastify";
import { env } from "../../env.js";
import { loadWorkspace } from "../crm.js";

export type Rollout = "off" | "pilot" | "all";

export function pilotIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))
  );
}

/** Pure: is the Import page open for this practice? */
export function importsOpen(rollout: Rollout, pilot: Set<string>, practiceId: string | null): boolean {
  if (rollout === "all") return true;
  if (rollout === "off" || !practiceId) return false;
  return pilot.has(practiceId.toLowerCase());
}

/** The caller's practice: their firm, or themselves when solo. */
export async function practiceIdOf(request: FastifyRequest): Promise<string> {
  const ws = await loadWorkspace(request);
  return ws.firmId ?? request.auth.userId;
}

export async function importsEnabledFor(request: FastifyRequest): Promise<boolean> {
  const rollout = env.IMPORTS_ROLLOUT as Rollout;
  if (rollout === "all") return true;
  if (rollout === "off") return false;
  return importsOpen(rollout, pilotIds(env.IMPORTS_PILOT), await practiceIdOf(request));
}

/** The AI kill switch. Off: presets, templates and the counselor's own mapping. */
export function importsAiEnabled(): boolean {
  return env.IMPORTS_AI !== "off";
}
