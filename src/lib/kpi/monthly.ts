/**
 * Time saved: the scheduled job. Daily it clears stale activity signals; on the
 * full run it finalizes last month (locking it), then sends each consultant's
 * email and each eligible firm's summary, once.
 *
 *  - Heartbeat timestamps older than 24 hours are cleared (nothing finer than the
 *    per-task running total is kept); tasks idle for 14 days are deleted, never counted.
 *  - A consultant's first email waits until their first completion is 14+ days old.
 *  - kpi_email_sends makes a re-run send nothing twice.
 */
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../env.js";
import { approvedCounselorIds } from "../access.js";
import { sendEmail } from "../email.js";
import { beat } from "../heartbeat.js";
import { renderConsultantEmail, renderFirmEmail, type FirmTotals } from "./emails.js";
import { loadReport } from "./load.js";
import { monthIn, monthsBack } from "./report.js";

type Log = { info: (o: object, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

export type MonthlyResult = {
  month: string | null;
  purged: { cleared: number; abandoned: number };
  finalized: number;
  consultantEmails: number;
  firmEmails: number;
  errors: number;
};

const LEASE = "kpi-monthly";
const DAY = 24 * 60 * 60 * 1000;

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const UNSUBSCRIBE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Clear heartbeat times older than 24 h; delete tasks idle 14+ days. */
export async function purgeSignals(svc: SupabaseClient, now = new Date()): Promise<MonthlyResult["purged"]> {
  const cutoff = new Date(now.getTime() - DAY).toISOString();
  const cleared = await svc
    .from("kpi_task_sessions")
    .update({ last_heartbeat_at: null })
    .lt("last_heartbeat_at", cutoff)
    .select("subject_id");
  if (cleared.error) throw new Error(`purge: ${cleared.error.code}`);
  const idleBefore = new Date(now.getTime() - 14 * DAY).toISOString().slice(0, 10);
  const abandoned = await svc.from("kpi_task_sessions").delete().lt("last_active_on", idleBefore).select("subject_id");
  if (abandoned.error) throw new Error(`purge: ${abandoned.error.code}`);
  return { cleared: cleared.data?.length ?? 0, abandoned: abandoned.data?.length ?? 0 };
}

/**
 * An unsubscribe link for this run; only its hash is stored. One token per
 * recipient per run (`cache`), so an owner's own email and firm email share a
 * working link; an earlier month's link stops working.
 */
async function unsubscribeUrl(svc: SupabaseClient, profileId: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(profileId);
  if (cached) return cached;
  const token = randomBytes(32).toString("base64url");
  const { error } = await svc
    .from("kpi_baselines")
    .upsert({ counselor_id: profileId, unsubscribe_token_hash: hashToken(token) }, { onConflict: "counselor_id" });
  if (error) throw new Error(`unsubscribe token: ${error.code}`);
  const base = env.PUBLIC_API_URL ?? env.APP_URL;
  const url = `${base.replace(/\/+$/, "")}/kpi/unsubscribe/${token}`;
  cache.set(profileId, url);
  return url;
}

async function wantsEmail(svc: SupabaseClient, profileId: string): Promise<boolean> {
  const { data, error } = await svc.from("kpi_baselines").select("monthly_email").eq("counselor_id", profileId).maybeSingle();
  if (error) throw new Error(`email preference: ${error.code}`); // fail closed: an unreadable preference sends nothing
  return data ? data.monthly_email !== false : true;
}

async function alreadySent(svc: SupabaseClient, recipient: string, month: string, kind: "consultant" | "firm", firmId: string | null) {
  let q = svc.from("kpi_email_sends").select("id").eq("recipient_id", recipient).eq("month", `${month}-01`).eq("kind", kind);
  q = firmId ? q.eq("firm_id", firmId) : q.is("firm_id", null);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`sends: ${error.code}`);
  return (data ?? []).length > 0;
}

async function emailOf(svc: SupabaseClient, id: string): Promise<string | null> {
  const { data } = await svc.from("profiles").select("email").eq("id", id).maybeSingle();
  return (data?.email as string | null) ?? null;
}

const distinct = (rows: Array<Record<string, unknown>> | null, key: string) =>
  [...new Set((rows ?? []).map((r) => r[key]).filter((v): v is string => typeof v === "string"))];

export async function runMonthly(svc: SupabaseClient, log: Log, opts: { month?: string; purgeOnly?: boolean; now?: Date } = {}): Promise<MonthlyResult> {
  const now = opts.now ?? new Date();
  const result: MonthlyResult = { month: null, purged: await purgeSignals(svc, now), finalized: 0, consultantEmails: 0, firmEmails: 0, errors: 0 };
  if (opts.purgeOnly) return result;

  const month = opts.month ?? monthsBack(monthIn("UTC", now), 1).slice(0, 7);
  result.month = month;
  const first = `${month}-01`;
  const link = `${env.APP_URL.replace(/\/+$/, "")}/dashboard/counselor/time-saved?month=${month}`;
  const tokens = new Map<string, string>();

  const { data: rows, error } = await svc.from("kpi_completions").select("counselor_id, firm_id").eq("month", first).limit(50000);
  if (error) throw new Error(`completions: ${error.code}`);
  const approved = await approvedCounselorIds(svc, distinct(rows, "counselor_id"));

  for (const counselorId of approved) {
    try {
      const { error: finErr } = await svc
        .from("kpi_months")
        .upsert({ counselor_id: counselorId, month: first }, { onConflict: "counselor_id,month", ignoreDuplicates: true });
      if (finErr) throw new Error(`finalize: ${finErr.code}`);
      result.finalized++;

      if (!(await wantsEmail(svc, counselorId)) || (await alreadySent(svc, counselorId, month, "consultant", null))) continue;
      const { data: firstRow } = await svc
        .from("kpi_completions")
        .select("completed_at")
        .eq("counselor_id", counselorId)
        .order("completed_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!firstRow || now.getTime() - new Date(String(firstRow.completed_at)).getTime() < 14 * DAY) continue;
      const to = await emailOf(svc, counselorId);
      if (!to) continue;

      const report = await loadReport(svc, counselorId, month);
      if (report.empty) continue;
      const mail = renderConsultantEmail(report, link, await unsubscribeUrl(svc, counselorId, tokens));
      const sent = await sendEmail({ to, ...mail, template: "kpi-monthly", idempotencyKey: `kpi-monthly:${counselorId}:${month}`, logger: log });
      if (!sent.sent) continue;
      await svc.from("kpi_email_sends").insert({ recipient_id: counselorId, month: first, kind: "consultant" });
      result.consultantEmails++;
    } catch (err) {
      result.errors++;
      log.error({ err: err instanceof Error ? err.message : "unknown" }, "kpi monthly: consultant step failed");
    }
  }

  for (const firmId of distinct(rows, "firm_id")) {
    try {
      const { data: totals, error: tErr } = await svc.rpc("kpi_firm_totals", { p_firm: firmId, p_month: first });
      if (tErr) throw new Error(`firm totals: ${tErr.code}`);
      if (!(totals as { available?: boolean })?.available) continue;
      const { data: firm } = await svc.from("firms").select("name, owner_id").eq("id", firmId).maybeSingle();
      if (!firm) continue;
      const { data: admins } = await svc.from("firm_members").select("profile_id").eq("firm_id", firmId).in("seat_role", ["owner", "admin"]);
      const recipients = await approvedCounselorIds(svc, [String(firm.owner_id), ...distinct(admins, "profile_id")]);
      for (const adminId of recipients) {
        if (!(await wantsEmail(svc, adminId)) || (await alreadySent(svc, adminId, month, "firm", firmId))) continue;
        const to = await emailOf(svc, adminId);
        if (!to) continue;
        const mail = renderFirmEmail({ month, ...(totals as Omit<FirmTotals, "month">) }, String(firm.name), link, await unsubscribeUrl(svc, adminId, tokens));
        const sent = await sendEmail({ to, ...mail, template: "kpi-firm-monthly", idempotencyKey: `kpi-firm:${firmId}:${adminId}:${month}`, logger: log });
        if (!sent.sent) continue;
        await svc.from("kpi_email_sends").insert({ recipient_id: adminId, month: first, kind: "firm", firm_id: firmId });
        result.firmEmails++;
      }
    } catch (err) {
      result.errors++;
      log.error({ err: err instanceof Error ? err.message : "unknown" }, "kpi monthly: firm step failed");
    }
  }
  return result;
}

export type StartMonthly =
  | { ran: true; result: MonthlyResult }
  | { ran: false; reason: "no-service-role" | "locked" | "lease-error" | "failed" };

/** Run under the job lease and record the heartbeat. */
export async function runMonthlyJob(svc: SupabaseClient | null, log: Log, opts: { month?: string; purgeOnly?: boolean }): Promise<StartMonthly> {
  if (!svc) return { ran: false, reason: "no-service-role" };
  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error } = await svc.rpc("acquire_job_lease", { p_name: LEASE, p_holder: holder, p_ttl_seconds: 900 });
  if (error) return { ran: false, reason: "lease-error" };
  if (!acquired) return { ran: false, reason: "locked" };
  try {
    const result = await runMonthly(svc, log, opts);
    await beat("kpi-monthly", result.errors === 0, result.errors ? `${result.errors} step(s) failed` : undefined, log);
    return { ran: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    log.error({ err: message }, "kpi monthly: failed");
    await beat("kpi-monthly", false, message.slice(0, 200), log);
    return { ran: false, reason: "failed" };
  } finally {
    await svc.rpc("release_job_lease", { p_name: LEASE, p_holder: holder });
  }
}
