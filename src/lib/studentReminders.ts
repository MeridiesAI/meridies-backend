/**
 * Due-date reminders on the student's own channels (SV Demo v2 Notifications).
 *
 * A student switches texts and email on in Settings (`student_preferences`).
 * Once a day's worth of runs, each open task due tomorrow (in the counselor's
 * time zone) gets one reminder per channel that is on. It rides the scheduled
 * message dispatch (`POST /communication/internal/dispatch`), so it needs no
 * cron of its own.
 *
 * - One send per task, channel and due date: the `message_deliveries` row is
 *   the record (template `task-due-reminder:<date>`), so a re-dated task is
 *   reminded again and a second run is a no-op.
 * - Never inside the counselor's quiet hours; a later run picks it up.
 * - Only students still on a counselor's roster and not archived.
 * - Runs under its own lease so two replicas can't send the same reminder.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { DEFAULT_SETTINGS, inQuietHours, loadSettings, type AccountabilitySettings } from "./accountability.js";
import { brandedEmail, brandedText, sendEmail, sendSms } from "./email.js";
import { approvedCounselorIds } from "./access.js";

type Log = FastifyBaseLogger;

type Row = Record<string, unknown>;

const LEASE_NAME = "student-reminders";
const LEASE_TTL_SECONDS = 10 * 60;
/** Enough for any practice today; a run that hits it finishes on the next. */
const MAX_STUDENTS = 2000;

export const REMINDER_TEMPLATE = "task-due-reminder";

export type ReminderTally = { ran: boolean; sent: number; skipped: number; reason?: string };

/** The calendar date `days` after `now`, in `timeZone`, as YYYY-MM-DD. */
export function localDate(timeZone: string, now = new Date(), days = 0): string {
  const shifted = new Date(now.getTime() + days * 86_400_000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
  } catch {
    return shifted.toISOString().slice(0, 10);
  }
}

export function reminderTemplate(dueDate: string): string {
  return `${REMINDER_TEMPLATE}:${dueDate}`;
}

function taskUrl(taskId: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/dashboard/student?task=${encodeURIComponent(taskId)}`;
}

export function reminderSms(title: string, url: string): string {
  return `Meridies: "${title}" is due tomorrow. ${url}`;
}

export function reminderEmail(first: string, title: string, url: string) {
  return {
    heading: `Due tomorrow: ${title}`,
    paragraphs: [`Hi ${first}, "${title}" is due tomorrow.`],
    cta: { label: "Open the task", url },
    footnote: "You're receiving this because you turned on email reminders in Meridies Settings.",
  };
}

async function alreadySent(svc: SupabaseClient, taskId: string, template: string, channel: "email" | "sms") {
  const { data, error } = await svc
    .from("message_deliveries")
    .select("id")
    .eq("deliverable_id", taskId)
    .eq("template", template)
    .eq("channel", channel)
    .eq("recipient_kind", "student")
    .limit(1);
  // An unreadable log is treated as sent: a duplicate reminder is worse than a missed one.
  if (error) return true;
  return (data ?? []).length > 0;
}

export async function sendStudentReminders(svc: SupabaseClient, log: Log): Promise<ReminderTally> {
  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  const { data: acquired, error: leaseErr } = await svc.rpc("acquire_job_lease", {
    p_name: LEASE_NAME,
    p_holder: holder,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (leaseErr) return { ran: false, sent: 0, skipped: 0, reason: "lease-error" };
  if (acquired !== true) return { ran: false, sent: 0, skipped: 0, reason: "locked" };

  let sent = 0;
  let skipped = 0;
  try {
    const { data: prefs, error } = await svc
      .from("student_preferences")
      .select("student_id, sms_enabled, sms_phone, email_enabled, email_address")
      .or("sms_enabled.eq.true,email_enabled.eq.true")
      .limit(MAX_STUDENTS);
    if (error) throw new Error(`student_preferences read failed (${error.code ?? "unknown"})`);
    if (!prefs?.length) return { ran: true, sent, skipped };

    const ids = prefs.map((p) => String(p.student_id));
    const { data: profiles, error: pErr } = await svc
      .from("profiles")
      .select("id, full_name, counselor_id, archived_at, role")
      .in("id", ids);
    if (pErr) throw new Error(`profiles read failed (${pErr.code ?? "unknown"})`);
    const byId = new Map((profiles ?? []).map((p) => [String(p.id), p as Row]));
    // A counselor who is not approved sends nothing, reminders included.
    const approved = await approvedCounselorIds(
      svc,
      (profiles ?? []).map((p) => String(p.counselor_id ?? "")).filter(Boolean)
    );

    const settingsFor = new Map<string, AccountabilitySettings>();

    for (const pref of prefs) {
      const sid = String(pref.student_id);
      const profile = byId.get(sid);
      if (!profile || profile.role !== "student" || profile.archived_at || !profile.counselor_id) continue;
      const counselorId = String(profile.counselor_id);
      if (!approved.has(counselorId)) {
        skipped += 1;
        continue;
      }

      let settings = settingsFor.get(`${counselorId}:${sid}`);
      if (!settings) {
        settings = await loadSettings({ db: svc }, counselorId, sid).catch(() => DEFAULT_SETTINGS);
        settingsFor.set(`${counselorId}:${sid}`, settings);
      }
      if (inQuietHours(settings)) continue;

      const tomorrow = localDate(settings.timezone, new Date(), 1);
      const { data: tasks, error: tErr } = await svc
        .from("deliverables")
        .select("id, title, due_date, status")
        .eq("student_id", sid)
        // A counselor-only task is never the student's reminder.
        .eq("visible_to_student", true)
        .eq("due_date", tomorrow)
        .neq("status", "complete")
        .limit(50);
      if (tErr) {
        log.warn({ code: tErr.code }, "student reminders: tasks read failed");
        continue;
      }

      const first = String(profile.full_name ?? "").trim().split(/\s+/)[0] || "there";
      for (const t of tasks ?? []) {
        const taskId = String(t.id);
        const title = String(t.title ?? "Your task");
        const template = reminderTemplate(tomorrow);
        const url = taskUrl(taskId);
        const base = { student_id: sid, deliverable_id: taskId, recipient_kind: "student" as const, recipient_id: sid, template, logger: log };

        if (pref.email_enabled && pref.email_address) {
          if (await alreadySent(svc, taskId, template, "email")) skipped += 1;
          else {
            const message = reminderEmail(first, title, url);
            const r = await sendEmail({
              ...base,
              to: String(pref.email_address),
              subject: `Due tomorrow: ${title}`,
              html: brandedEmail(message),
              text: brandedText(message),
            });
            if (r.sent) sent += 1;
          }
        }
        if (pref.sms_enabled && pref.sms_phone) {
          if (await alreadySent(svc, taskId, template, "sms")) skipped += 1;
          else {
            const r = await sendSms({ ...base, to: String(pref.sms_phone), body: reminderSms(title, url) });
            if (r.sent) sent += 1;
          }
        }
      }
    }
  } finally {
    const { error } = await svc.rpc("release_job_lease", { p_name: LEASE_NAME, p_holder: holder });
    if (error) log.warn({ code: error.code }, "student reminders: lease release failed");
  }

  log.info({ sent, skipped }, "student reminders finished");
  return { ran: true, sent, skipped };
}
