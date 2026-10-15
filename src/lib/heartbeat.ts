/**
 * Job heartbeats (public.job_heartbeats): each scheduled job records when it
 * last ran cleanly or failed, so GET /internal/status can tell a monitor that a
 * cron stopped. Never fatal: a heartbeat that fails to write is only logged.
 */

import { serviceClient } from "./supabase.js";

export type Job =
  | "accountability-sweep"
  | "message-dispatch"
  | "scorecard-ingest"
  | "resources-link-check"
  | "import-sweep"
  | "events-discovery"
  | "college-photos";

export async function beat(job: Job, ok: boolean, error?: string, log?: { warn: (o: object, m?: string) => void }) {
  const svc = serviceClient();
  if (!svc) return;
  const now = new Date().toISOString();
  const values = ok ? { last_ok_at: now, updated_at: now } : { last_error_at: now, last_error: (error ?? "failed").slice(0, 500), updated_at: now };
  const { error: e } = await svc.from("job_heartbeats").update(values).eq("job", job);
  if (e) log?.warn({ job, code: e.code }, "heartbeat write failed");
}

/** A job is stale when it hasn't run cleanly within twice its expected interval. */
export function isStale(lastOkAt: string | null, expectedEvery: string, now = Date.now()): boolean {
  if (!lastOkAt) return true;
  return now - Date.parse(lastOkAt) > 2 * intervalMs(expectedEvery);
}

/** Postgres interval text ("00:15:00", "7 days", "31 days") -> ms. */
export function intervalMs(v: string): number {
  let ms = 0;
  const days = /(\d+)\s+days?/.exec(v);
  if (days) ms += Number(days[1]) * 86_400_000;
  const hms = /(\d{1,2}):(\d{2}):(\d{2})/.exec(v);
  if (hms) ms += (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) * 1000;
  return ms;
}
