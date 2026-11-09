/**
 * The inactivity alert, and the last-active mark it reads.
 *
 * `runInactivityPass` rides on the scheduled accountability sweep (lib/sweepSchedule.ts), under its lease.
 * It runs on the service client, so it scopes everything itself: it starts from the settings rows that
 * turned the alert on, keeps only approved counselors (`approvedCounselorIds`, asked per run), and reads
 * each one's roster by `profiles.counselor_id` (students, not archived). The rules are `selectInactive`
 * (lib/inactivity.ts). A streak is announced once: the `student_inactivity_alerts` insert is
 * ON CONFLICT DO NOTHING on (student_id, last_activity_at), and only a new row makes the notice. The
 * notice is a bell notification (kind 'system', a first name and a number of days, nothing the student
 * wrote) and, under a per-counselor daily cap, an email to the counselor's sign-in address.
 *
 * `touchLastActive` stamps `profiles.last_active_at` for a signed-in student at most once an hour, with a
 * conditional update so overlapping requests and replicas write once. It never throws and is never awaited
 * by the request.
 */

import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { approvedCounselorIds } from "./access.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import {
  firstNameOf,
  inactivityTitle,
  FUTURE_SKEW_MS,
  LAST_ACTIVE_WRITE_EVERY_MS,
  selectInactive,
  shouldTouchLastActive,
  type InactivityStudent,
  type SettingsRow,
} from "./inactivity.js";
import { consumeRateLimit } from "./limits.js";
import { serviceClient } from "./supabase.js";

type Log = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

/** Students read per counselor, and alerts made per counselor per run. */
const ROSTER_LIMIT = 1000;
const PER_COUNSELOR_ALERTS = 50;
/** Inactivity emails per counselor per day; the bell notice is not capped (one per streak already). */
const EMAILS_PER_COUNSELOR_DAY = 25;
const ID_CHUNK = 200;
const SETTINGS_LIMIT = 5000;

export type InactivityPassResult = { counselors: number; alerted: number; failedCounselors: number; skipped?: string };

export async function runInactivityPass(svc: SupabaseClient, log: Log, now = new Date()): Promise<InactivityPassResult> {
  const result: InactivityPassResult = { counselors: 0, alerted: 0, failedCounselors: 0 };

  const { data: on, error } = await svc
    .from("accountability_settings")
    .select("counselor_id")
    .not("inactive_alert_days", "is", null)
    .limit(SETTINGS_LIMIT);
  if (error) {
    // Before 20261111000003 the column isn't there: nothing is switched on.
    log.warn({ code: error.code }, "inactivity alerts: settings unreadable, pass skipped");
    return { ...result, skipped: "settings-unreadable" };
  }
  const counselorIds = [...new Set((on ?? []).map((r) => r.counselor_id as string))];
  if (counselorIds.length === 0) return result;
  const approved = await approvedCounselorIds(svc, counselorIds);

  for (const counselorId of counselorIds) {
    if (!approved.has(counselorId)) continue;
    result.counselors += 1;
    try {
      result.alerted += await alertCounselor(svc, log, counselorId, now);
    } catch (err) {
      result.failedCounselors += 1;
      log.error({ err, counselorId }, "inactivity alerts: counselor failed");
    }
  }
  return result;
}

async function alertCounselor(svc: SupabaseClient, log: Log, counselorId: string, now: Date): Promise<number> {
  // An errored settings read is not "no settings": throw, like loadSettings.
  const { data: rows, error: sErr } = await svc.from("accountability_settings").select("*").eq("counselor_id", counselorId);
  if (sErr) throw new Error(`settings read failed (${sErr.code ?? "unknown"})`);

  const { data: roster, error: rErr } = await svc
    .from("profiles")
    .select("id, full_name, created_at, last_active_at")
    .eq("counselor_id", counselorId)
    .eq("role", "student")
    .is("archived_at", null)
    .order("id")
    .limit(ROSTER_LIMIT);
  if (rErr) throw new Error(`roster read failed (${rErr.code ?? "unknown"})`);
  const students = (roster ?? []) as InactivityStudent[];
  if (students.length === 0) return 0;

  const lastEvents = new Map<string, string>();
  for (let i = 0; i < students.length; i += ID_CHUNK) {
    const ids = students.slice(i, i + ID_CHUNK).map((s) => s.id);
    const { data: events, error: eErr } = await svc.rpc("student_last_progress", { p_students: ids });
    if (eErr) throw new Error(`progress read failed (${eErr.code ?? "unknown"})`);
    for (const e of (events ?? []) as { student_id: string; last_event_at: string | null }[]) {
      if (e.last_event_at) lastEvents.set(e.student_id, e.last_event_at);
    }
  }

  const due = selectInactive({ students, lastEvents, settingsRows: (rows ?? []) as SettingsRow[], now }).slice(0, PER_COUNSELOR_ALERTS);
  if (due.length === 0) return 0;

  const { data: counselor } = await svc.from("profiles").select("email").eq("id", counselorId).maybeSingle();
  const to = (counselor?.email as string | null) ?? null;

  let alerted = 0;
  for (const d of due) {
    const { data: inserted, error: iErr } = await svc
      .from("student_inactivity_alerts")
      .upsert({ student_id: d.studentId, last_activity_at: d.lastActivityAt }, { onConflict: "student_id,last_activity_at", ignoreDuplicates: true })
      .select("student_id");
    if (iErr) throw new Error(`alert insert failed (${iErr.code ?? "unknown"})`);
    if (!inserted || inserted.length === 0) continue; // this streak was announced already

    const title = inactivityTitle(d.fullName, d.days);
    const href = `/dashboard/counselor/students/${d.studentId}`;
    const { error: nErr } = await svc.from("notifications").insert({
      recipient_id: counselorId,
      student_id: d.studentId,
      kind: "system",
      urgency: "normal",
      title,
      body: `No sign-in or progress since ${d.lastActivityAt.slice(0, 10)}.`,
      href,
      action_items: [],
      created_by: null,
    });
    if (nErr) {
      // Unannounce the streak, so the next sweep tries again rather than never telling anyone.
      log.error({ code: nErr.code, studentId: d.studentId }, "inactivity alerts: notification insert failed");
      const { error: dErr } = await svc
        .from("student_inactivity_alerts")
        .delete()
        .eq("student_id", d.studentId)
        .eq("last_activity_at", d.lastActivityAt);
      if (dErr) log.error({ code: dErr.code, studentId: d.studentId }, "inactivity alerts: alert row cleanup failed");
      continue;
    }
    alerted += 1;

    if (!to) continue;
    if (!(await consumeRateLimit(`inactivity-email:counselor:${counselorId}`, EMAILS_PER_COUNSELOR_DAY, 86_400, log))) {
      log.info({ counselorId }, "inactivity alerts: email throttled");
      continue;
    }
    const first = firstNameOf(d.fullName);
    const template = {
      heading: title,
      paragraphs: [
        `${first} hasn't signed in or made progress since ${d.lastActivityAt.slice(0, 10)}.`,
        `You asked to hear after ${d.threshold} ${d.threshold === 1 ? "day" : "days"} without activity. You can change this in Settings.`,
      ],
      cta: { label: `Open ${first}'s page`, url: `${env.APP_URL}${href}` },
    };
    await sendEmail({
      to,
      subject: title,
      html: brandedEmail(template),
      text: brandedText(template),
      template: "inactivity-alert",
      student_id: d.studentId,
      recipient_id: counselorId,
      recipient_kind: "counselor",
      logger: log as FastifyBaseLogger,
    }).catch((err) => log.error({ err }, "inactivity alerts: email failed"));
  }
  return alerted;
}

/**
 * Stamp a signed-in student's last activity, at most once an hour. The conditional update means only one of
 * several overlapping requests writes. Fire and forget: never awaited by the request, never throws.
 */
export function touchLastActive(profile: { id: string; role?: string | null; last_active_at?: string | null }, log: Log, now = new Date()): void {
  if (profile.role !== "student" || !shouldTouchLastActive(profile.last_active_at, now)) return;
  const svc = serviceClient();
  if (!svc) return;
  const cutoff = new Date(now.getTime() - LAST_ACTIVE_WRITE_EVERY_MS).toISOString();
  const future = new Date(now.getTime() + FUTURE_SKEW_MS).toISOString();
  void Promise.resolve(
    svc
      .from("profiles")
      .update({ last_active_at: now.toISOString() })
      .eq("id", profile.id)
      .or(`last_active_at.is.null,last_active_at.lt.${cutoff},last_active_at.gt.${future}`)
  )
    .then(({ error }) => {
      if (error) log.warn({ code: error.code }, "last_active_at write failed");
    })
    .catch((err) => log.warn({ err }, "last_active_at write failed"));
}
