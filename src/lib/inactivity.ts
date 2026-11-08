/**
 * Counselor alerts: the rules, with no database.
 *
 *  - Inactivity. A student's last activity is the later of `profiles.last_active_at` (stamped at most
 *    once an hour on their signed-in requests) and their newest `progress_events` row; one who has done
 *    neither counts from when they joined. A counselor who set `inactive_alert_days` (the counselor-wide
 *    row, or a per-student row that wins over it) hears once per inactive streak: the streak is keyed on
 *    that last-activity instant, so new activity starts a new one. Nobody is alerted on inside the
 *    counselor's quiet hours (the next run picks them up), with accountability switched off for the
 *    student, or before they have been on the roster N days.
 *  - Essay notice. Only when the body really changed, and never with any of its text.
 *
 * `lib/inactivityAlerts.ts` and `lib/essayNotice.ts` do the reads and writes.
 */

import { ALERT_DEFAULTS, DEFAULT_SETTINGS, inQuietHours, type AccountabilitySettings } from "./accountability.js";

export { ALERT_DEFAULTS };

const DAY_MS = 86_400_000;

/** `profiles.last_active_at` is written at most this often per student. */
export const LAST_ACTIVE_WRITE_EVERY_MS = 3_600_000;
/** One essay notice per essay in this window, and this many per student per day. */
export const ESSAY_NOTICE_PER_ESSAY_SECONDS = 6 * 3600;
export const ESSAY_NOTICES_PER_STUDENT_DAY = 20;
/**
 * Clock skew allowed on an activity time. Anything later than now plus this is ignored: a student can write
 * a progress event's time, and a forged far-future mark must not switch their own inactivity alert off.
 */
export const FUTURE_SKEW_MS = 5 * 60_000;

export type FullSettings = AccountabilitySettings & typeof ALERT_DEFAULTS;
export type SettingsRow = FullSettings & { counselor_id: string; student_id: string | null };

export type InactivityStudent = {
  id: string;
  full_name: string | null;
  created_at: string;
  last_active_at: string | null;
};

export type InactiveStudent = {
  studentId: string;
  fullName: string | null;
  /** The streak key, as an ISO instant. */
  lastActivityAt: string;
  days: number;
  threshold: number;
};

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * The later of the two activity signals, else when the student joined; always a normalised ISO instant.
 * A signal in the future (beyond FUTURE_SKEW_MS) is ignored.
 */
export function lastActivityAt(lastActiveAt: string | null, lastEventAt: string | null, createdAt: string, now = new Date()): string {
  const latest = now.getTime() + FUTURE_SKEW_MS;
  const candidates = [ms(lastActiveAt), ms(lastEventAt)].filter((t): t is number => t !== null && t <= latest);
  const t = candidates.length ? Math.max(...candidates) : (ms(createdAt) ?? 0);
  return new Date(t).toISOString();
}

export function inactiveDays(lastActivity: string, now: Date): number {
  return Math.floor((now.getTime() - (ms(lastActivity) ?? now.getTime())) / DAY_MS);
}

/** The student's row wins over the counselor-wide row, which wins over the defaults. */
export function settingsFor(rows: SettingsRow[], studentId: string): FullSettings {
  const chosen = rows.find((r) => r.student_id === studentId) ?? rows.find((r) => r.student_id === null);
  return { ...DEFAULT_SETTINGS, ...ALERT_DEFAULTS, ...(chosen ?? {}) } as FullSettings;
}

/** One counselor's roster in, the students to alert on out (oldest streak first). */
export function selectInactive(input: {
  students: InactivityStudent[];
  lastEvents: Map<string, string>;
  settingsRows: SettingsRow[];
  now: Date;
}): InactiveStudent[] {
  const { now } = input;
  const out: InactiveStudent[] = [];
  for (const s of input.students) {
    const settings = settingsFor(input.settingsRows, s.id);
    const threshold = settings.inactive_alert_days;
    if (threshold == null || threshold < 1 || !settings.enabled) continue;
    if (inQuietHours(settings, now)) continue;
    const joined = ms(s.created_at);
    if (joined === null || now.getTime() - joined < threshold * DAY_MS) continue;
    const last = lastActivityAt(s.last_active_at, input.lastEvents.get(s.id) ?? null, s.created_at, now);
    const days = inactiveDays(last, now);
    if (days < threshold) continue;
    out.push({ studentId: s.id, fullName: s.full_name, lastActivityAt: last, days, threshold });
  }
  return out.sort((a, b) => b.days - a.days);
}

export function shouldTouchLastActive(lastActiveAt: string | null | undefined, now: Date): boolean {
  const t = ms(lastActiveAt);
  // A mark in the future (forged before the column's grant was revoked) is rewritten too.
  return t === null || now.getTime() - t >= LAST_ACTIVE_WRITE_EVERY_MS || t > now.getTime() + FUTURE_SKEW_MS;
}

export function essayBodyChanged(before: string | null | undefined, after: string | null | undefined): boolean {
  return (before ?? "") !== (after ?? "");
}

/** The first word of the display name, at most 40 characters: names are the student's to write. */
export function firstNameOf(fullName: string | null | undefined): string {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 40) : "Your student";
}

export function inactivityTitle(fullName: string | null | undefined, days: number): string {
  return `${firstNameOf(fullName)} hasn't been active in ${days} ${days === 1 ? "day" : "days"}`;
}

export function essayNoticeTitle(fullName: string | null | undefined): string {
  return `${firstNameOf(fullName)} worked on an essay`;
}
