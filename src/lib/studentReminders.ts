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
 *
 * Where it goes (the student writes their preferences, so neither address is
 * trusted as a destination on its own):
 * - Email only ever goes to the student's own sign-in address
 *   (`profiles.email`, which no client can write). The address typed in
 *   Settings is not followed.
 * - A text goes only to the number the student's counselor recorded on the
 *   student's card (`profiles.phone_recorded_by_counselor`, written by a
 *   trigger when the counselor saves the phone, never by the student;
 *   20261024000042), and only when the student's own reminder number is that
 *   same number. Before that migration, or with no number recorded, no text
 *   goes out.
 * - At most MAX_REMINDERS_PER_DAY per channel per student per due date, and
 *   a title the student wrote never goes into a text (smsTitle).
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
/** Reminders per channel, per student, per due date. */
export const MAX_REMINDERS_PER_DAY = 5;
/** The longest task title a text carries. */
export const SMS_TITLE_MAX = 60;

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

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A phone number written any common way, as E.164, or null. A bare US
 * number (10 digits, or 11 starting with 1) reads as +1; anything else must
 * carry its own "+".
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(v)) return v;
  if (/^\d{10}$/.test(v)) return `+1${v}`;
  if (/^1\d{10}$/.test(v)) return `+${v}`;
  return null;
}

/**
 * Where this student's reminders may go. Email: the sign-in address, never
 * the one typed in Settings. Text: the number the counselor recorded, and
 * only when the student's own reminder number is that number.
 */
export function reminderDestinations(
  pref: { email_enabled?: unknown; sms_enabled?: unknown; sms_phone?: unknown },
  profile: { email?: unknown; phone_recorded_by_counselor?: unknown }
): { email: string | null; sms: string | null } {
  const login = typeof profile.email === "string" && profile.email.includes("@") ? profile.email : null;
  const email = pref.email_enabled === true ? login : null;
  const recorded = normalizePhone(profile.phone_recorded_by_counselor);
  const chosen = normalizePhone(pref.sms_phone);
  const sms = pref.sms_enabled === true && recorded && chosen === recorded ? recorded : null;
  return { email, sms };
}

/**
 * What of a task's title a text may carry: nothing for a to-do the student
 * wrote themselves, and for a counselor's task at most SMS_TITLE_MAX
 * characters with no link, address or phone number in it.
 */
export function smsTitle(title: string, source: unknown): string | null {
  if (source !== "counselor") return null;
  const t = oneLine(title, 300);
  if (!t) return null;
  if (/https?:|www\.|@|\b[a-z0-9-]+\.(com|net|org|io|ly|co|me|app|xyz|info|biz|link|us|gl)\b|\d{6,}/i.test(t)) return null;
  return t.length > SMS_TITLE_MAX ? `${t.slice(0, SMS_TITLE_MAX - 1).trimEnd()}…` : t;
}

export function reminderSms(title: string | null, url: string): string {
  return title ? `Meridies: "${title}" is due tomorrow. ${url}` : `Meridies: a task on your To-Do is due tomorrow. ${url}`;
}

export function reminderEmail(first: string, title: string, url: string) {
  const t = oneLine(title, 200);
  return {
    heading: `Due tomorrow: ${t}`,
    paragraphs: [`Hi ${first}, "${t}" is due tomorrow.`],
    cta: { label: "Open the task", url },
    footnote: "You're receiving this at your Meridies sign-in email because you turned on email reminders in Settings.",
  };
}

/** How many reminders this student already has on this channel for this due date; an unreadable log counts as full. */
async function sentToday(svc: SupabaseClient, studentId: string, template: string, channel: "email" | "sms"): Promise<number> {
  const { count, error } = await svc
    .from("message_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("student_id", studentId)
    .eq("template", template)
    .eq("channel", channel)
    .eq("recipient_kind", "student");
  if (error) return MAX_REMINDERS_PER_DAY;
  return count ?? 0;
}

let recordedPhoneMissingUntil = 0;

/** The profiles the job needs; without 20261024000042 the recorded phone reads as absent (no texts). */
async function loadProfiles(svc: SupabaseClient, ids: string[], log: Log): Promise<Row[]> {
  const base = "id, full_name, email, counselor_id, archived_at, role";
  if (Date.now() >= recordedPhoneMissingUntil) {
    const { data, error } = await svc.from("profiles").select(`${base}, phone_recorded_by_counselor`).in("id", ids);
    if (!error) return (data ?? []) as Row[];
    if (error.code !== "42703" && error.code !== "PGRST204") throw new Error(`profiles read failed (${error.code ?? "unknown"})`);
    recordedPhoneMissingUntil = Date.now() + 5 * 60_000;
    log.warn("student reminders: profiles.phone_recorded_by_counselor is missing (20261024000042 not applied); no texts are sent");
  }
  const { data, error } = await svc.from("profiles").select(base).in("id", ids);
  if (error) throw new Error(`profiles read failed (${error.code ?? "unknown"})`);
  return (data ?? []) as Row[];
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
      .select("student_id, sms_enabled, sms_phone, email_enabled")
      .or("sms_enabled.eq.true,email_enabled.eq.true")
      .limit(MAX_STUDENTS);
    if (error) throw new Error(`student_preferences read failed (${error.code ?? "unknown"})`);
    if (!prefs?.length) return { ran: true, sent, skipped };

    const ids = prefs.map((p) => String(p.student_id));
    const profiles = await loadProfiles(svc, ids, log);
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
      const to = reminderDestinations(pref, profile);
      if (!to.email && !to.sms) {
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
        .select("id, title, due_date, status, source")
        .eq("student_id", sid)
        // A counselor-only task is never the student's reminder.
        .eq("visible_to_student", true)
        .eq("due_date", tomorrow)
        .neq("status", "complete")
        // The counselor's tasks first, so the daily cap never crowds them out.
        .order("source", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(50);
      if (tErr) {
        log.warn({ code: tErr.code }, "student reminders: tasks read failed");
        continue;
      }

      const first = String(profile.full_name ?? "").trim().split(/\s+/)[0] || "there";
      const template = reminderTemplate(tomorrow);
      let emailBudget = to.email ? MAX_REMINDERS_PER_DAY - (await sentToday(svc, sid, template, "email")) : 0;
      let smsBudget = to.sms ? MAX_REMINDERS_PER_DAY - (await sentToday(svc, sid, template, "sms")) : 0;
      for (const t of tasks ?? []) {
        const taskId = String(t.id);
        const title = String(t.title ?? "Your task");
        const url = taskUrl(taskId);
        const base = { student_id: sid, deliverable_id: taskId, recipient_kind: "student" as const, recipient_id: sid, template, logger: log };

        if (to.email) {
          if (emailBudget <= 0 || (await alreadySent(svc, taskId, template, "email"))) skipped += 1;
          else {
            emailBudget -= 1;
            const message = reminderEmail(first, title, url);
            const r = await sendEmail({
              ...base,
              to: to.email,
              subject: oneLine(`Due tomorrow: ${title}`, 120),
              html: brandedEmail(message),
              text: brandedText(message),
            });
            if (r.sent) sent += 1;
          }
        }
        if (to.sms) {
          if (smsBudget <= 0 || (await alreadySent(svc, taskId, template, "sms"))) skipped += 1;
          else {
            smsBudget -= 1;
            const r = await sendSms({ ...base, to: to.sms, body: reminderSms(smsTitle(title, t.source), url) });
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
