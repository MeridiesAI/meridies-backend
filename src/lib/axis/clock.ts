/**
 * AxIS's "now", with an eval-only offset (AxIS activity drafts, spec 4.10).
 *
 * Everything that stamps or checks draft time (the draft's updated_at, its 30-minute expiry, the dialogue state's
 * TTL) reads `axisNow()`, never `Date.now()`. Normally that is the wall clock. The real-model evals start the API
 * with AXIS_EVAL_CLOCK=on and move the clock forward through POST /axis/eval/clock to test expiry, without editing
 * database rows. The flag refuses to boot anywhere but a local Supabase stack, and never with NODE_ENV=production
 * (`evalClockRefusal`, checked in src/index.ts), so the offset can't exist on a real deployment.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal"]);

let offsetMs = 0;

export type EvalClockEnv = { AXIS_EVAL_CLOCK?: string | undefined; NODE_ENV?: string | undefined; SUPABASE_URL?: string | undefined };

/** Why the server must not start with this environment, or null when it may. */
export function evalClockRefusal(e: EvalClockEnv): string | null {
  if (e.AXIS_EVAL_CLOCK !== "on") return null;
  if (e.NODE_ENV === "production") return "refusing to start: AXIS_EVAL_CLOCK is for evals only and must not be set when NODE_ENV=production";
  let host = "";
  try {
    host = new URL(e.SUPABASE_URL ?? "").hostname;
  } catch {
    host = "";
  }
  if (!LOCAL_HOSTS.has(host)) {
    return "refusing to start: AXIS_EVAL_CLOCK needs a local Supabase stack (SUPABASE_URL on localhost, 127.0.0.1 or host.docker.internal)";
  }
  return null;
}

/** Clock mode is on: the flag is set and the environment passes the refusal check (checked again on every use). */
export function evalClockOn(): boolean {
  return process.env.AXIS_EVAL_CLOCK === "on" && evalClockRefusal(process.env) === null;
}

/** Now, for anything that stamps or compares draft and dialogue time. */
export function axisNow(): Date {
  return new Date(Date.now() + (offsetMs && evalClockOn() ? offsetMs : 0));
}

/** Moves AxIS's clock forward. Eval clock mode only. */
export function advanceClock(ms: number): void {
  if (!evalClockOn()) throw new Error("the eval clock is off (AXIS_EVAL_CLOCK)");
  if (!Number.isFinite(ms) || ms < 0) throw new Error("the eval clock only moves forward");
  offsetMs += ms;
}
