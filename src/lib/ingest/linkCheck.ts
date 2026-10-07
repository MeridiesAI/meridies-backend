/**
 * The resource library's weekly link check: every library_resources row,
 * through lib/links.ts checkLink (SSRF-safe, HEAD, body never read). A link
 * that fails is flagged `broken` (404/410, gone) or `blocked` (the site
 * refuses robots or errs), never deleted. One ingest_runs row per run.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkLink, type LinkCheck } from "../links.js";
import { serviceClient } from "../supabase.js";

type Log = { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
type Check = (url: string) => Promise<LinkCheck>;

const LEASE = "resources-link-check";
const CONCURRENCY = 4;
const RECHECK_DELAY_MS = 2000;

export async function runLinkCheck(svc: SupabaseClient, log: Log, check: Check = checkLink, trigger: "cron" | "script" = "cron") {
  const started = Date.now();
  const { data: run } = await svc.from("ingest_runs").insert({ source: "resources-link-check", trigger }).select("id").single();
  const { data: rows, error } = await svc.from("library_resources").select("id, url").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(5000);
  if (error) throw new Error(`read resources: ${error.code}`);

  const queue = [...((rows ?? []) as { id: string; url: string }[])];
  const counts = { ok: 0, broken: 0, blocked: 0 };
  const errors: string[] = [];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      let result = await check(r.url);
      // Some sites (calstate.edu) answer robots 404 one moment and 403 the next:
      // a page is called broken only when a second look agrees.
      if (result.status === "broken") {
        await new Promise((res) => setTimeout(res, RECHECK_DELAY_MS));
        const again = await check(r.url);
        if (again.status !== "broken") result = { ...again, status: again.status === "ok" ? "ok" : "blocked" };
      }
      counts[result.status] += 1;
      const { error: e2 } = await svc
        .from("library_resources")
        .update({ link_status: result.status, last_status_code: result.code, last_checked_at: new Date().toISOString() })
        .eq("id", r.id);
      if (e2) errors.push(`${r.id}: ${e2.code}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (run) {
    await svc
      .from("ingest_runs")
      .update({
        status: errors.length ? "partial" : "succeeded",
        rows_upserted: counts.ok + counts.broken + counts.blocked,
        errors: errors.slice(0, 50),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
      })
      .eq("id", (run as { id: string }).id);
  }
  log.info({ ...counts, errors: errors.length }, "resource link check finished");
  return counts;
}

/** Start a check under its lease; resolves when it finishes. */
export async function startLinkCheck(log: Log, trigger: "cron" | "script") {
  const svc = serviceClient();
  if (!svc) return { started: false as const, reason: "no-service-role" as const };
  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error } = await svc.rpc("acquire_job_lease", { p_name: LEASE, p_holder: holder, p_ttl_seconds: 3600 });
  if (error) return { started: false as const, reason: "lease-error" as const };
  if (!acquired) return { started: false as const, reason: "locked" as const };
  const done = runLinkCheck(svc, log, checkLink, trigger)
    .catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : "unknown" }, "resource link check crashed");
      return null;
    })
    .finally(async () => {
      await svc.rpc("release_job_lease", { p_name: LEASE, p_holder: holder });
    });
  return { started: true as const, done };
}
