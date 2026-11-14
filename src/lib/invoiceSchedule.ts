/**
 * Invoice composer: when a scheduled invoice goes and when its reminders do (pure; no I/O).
 *
 * Every time of day is wall-clock in the PRACTICE's zone: the sending counselor's `profiles.timezone`,
 * UTC when there is none (or it isn't a real zone). Sends and reminders go at 9:00 local (`SEND_HOUR`).
 * The crons run every 10-15 minutes, so "9:00" means "the first run at or after 9:00".
 */

import { nextYear } from "./blasts.js";
import { isTimeZone, zonedToUtc } from "./eventsHub.js";

export const SEND_HOUR = 9;
const SEND_TIME = `0${SEND_HOUR}:00`;
/** A reminder not sent within this long of its time (the cron was down) is dropped, never sent late. */
export const REMINDER_WINDOW_MS = 36 * 3_600_000;
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_DAYS = 30;

export type SendSchedule =
  | { mode: "now" }
  | { mode: "tomorrow" }
  | { mode: "before_due"; daysBefore: number }
  | { mode: "date"; date: string };

export type SendTime = { ok: true; sendAt: string | null } | { ok: false; code: "send_time_passed"; reason: string };

const zoneOf = (tz: string | null | undefined) => (tz && isTimeZone(tz) ? tz : "UTC");

/** Today's date (YYYY-MM-DD) at `now` in `tz`. */
export function dateIn(now: number, tz: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zoneOf(tz), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

/** A plain date moved by whole days (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The instant a schedule sends at (null: right now), or why it can't. */
export function resolveSendTime(s: SendSchedule, ctx: { dueOn: string; tz: string | null | undefined; now: number }): SendTime {
  const tz = zoneOf(ctx.tz);
  if (s.mode === "now") return { ok: true, sendAt: null };
  const day = s.mode === "tomorrow" ? addDays(dateIn(ctx.now, tz), 1) : s.mode === "date" ? s.date : addDays(ctx.dueOn, -s.daysBefore);
  const sendAt = zonedToUtc(day, SEND_TIME, tz);
  if (Date.parse(sendAt) <= ctx.now) {
    return { ok: false, code: "send_time_passed", reason: "That send time has already passed. Pick a later one, or send it now." };
  }
  return { ok: true, sendAt };
}

/** Reminder offsets in days from the due date (negative = before): whole, small, unique, sorted. */
export function validateReminderOffsets(raw: number[]): { ok: true; offsets: number[] } | { ok: false; reason: string } {
  if (!raw.every((n) => Number.isInteger(n) && Math.abs(n) <= MAX_REMINDER_DAYS)) {
    return { ok: false, reason: `Reminders are whole days, up to ${MAX_REMINDER_DAYS} before or after the due date` };
  }
  const offsets = [...new Set(raw)].sort((a, b) => a - b);
  if (offsets.length > MAX_REMINDERS) return { ok: false, reason: `At most ${MAX_REMINDERS} reminders` };
  return { ok: true, offsets };
}

/** Whether a reminder at `offset` days from `dueOn` is not yet time, due now, or too old to send. */
export function reminderState(dueOn: string, offset: number, now: number, tz: string | null | undefined): "later" | "due" | "stale" {
  const at = Date.parse(zonedToUtc(addDays(dueOn, offset), SEND_TIME, zoneOf(tz)));
  if (now < at) return "later";
  return now < at + REMINDER_WINDOW_MS ? "due" : "stale";
}

/** The next copy of a yearly draft: the send time keeps its local hour (nextYear), the due date moves a year (Feb 29 -> 28). */
export function nextYearlyDraft(p: { sendAt: string; dueOn: string; tz: string | null | undefined }): { sendAt: string; dueOn: string } {
  const tz = zoneOf(p.tz);
  const [y, m, d] = p.dueOn.split("-").map(Number) as [number, number, number];
  const dim = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  const dueOn = `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
  return { sendAt: nextYear(p.sendAt, tz), dueOn };
}
