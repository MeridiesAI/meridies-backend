/**
 * Saved task sets (migration 20261111000005): a counselor's named list of up to 30 tasks, applied in one
 * go to picked students or to a class year (`routes/taskSets.ts`).
 *
 * An item is what the Create task form takes, minus the student and with dates RELATIVE, so one set means
 * the right thing every year: `dueOffsetDays` (days after the day it is applied, in the counselor's own
 * time zone) or `dueMonth`/`dueDay` (the next time that date comes round, today included; Feb 29 is Feb 28
 * in a year without one, the yearly blast rule). Stages take the same rule.
 *
 * Pure: the schemas, the date arithmetic (whole calendar days, never milliseconds, so a DST change can't
 * move a date) and class-year matching. Tests: `test/unit/task-sets.test.ts`,
 * `test/integration/task-sets.test.mjs`.
 */

import { z } from "zod";
import { validMonthDay } from "./stageTemplates.js";

export const TASK_KINDS = [
  "essay",
  "common-app-section",
  "activity-list",
  "document",
  "test-registration",
  "recommendation",
  "aid-form",
  "custom",
] as const;

export const TASK_SET_MAX_ITEMS = 30;
export const APPLY_MAX_STUDENTS = 100;
/** Assignment emails a counselor's set applies may send a day; past it the tasks are made and the email is skipped. */
export const TASK_SET_EMAIL_DAILY_CAP = 200;

/** A relative due date: an offset, a month and day, or nothing. Never both, never half of a month/day. */
type RelativeDue = { dueOffsetDays?: number; dueMonth?: number; dueDay?: number };

const relativeDue = {
  dueOffsetDays: z.number().int().min(0).max(730).optional(),
  dueMonth: z.number().int().min(1).max(12).optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
};

function checkDue(v: RelativeDue, ctx: z.RefinementCtx) {
  const hasMonth = v.dueMonth !== undefined;
  const hasDay = v.dueDay !== undefined;
  if (hasMonth !== hasDay) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give a month and a day together" });
    return;
  }
  if (hasMonth && v.dueOffsetDays !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Use days after, or a month and day, not both" });
    return;
  }
  if (hasMonth && !validMonthDay(v.dueMonth!, v.dueDay!)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "That month doesn't have that day" });
  }
}

const stageItem = z
  .object({
    name: z.string().trim().min(1).max(300),
    detail: z.string().trim().max(2000).optional(),
    ...relativeDue,
  })
  .strict()
  .superRefine(checkDue);

export const taskSetItem = z
  .object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(TASK_KINDS).optional(),
    instructions: z.string().trim().max(8000).optional(),
    targetWords: z.number().int().min(0).max(100_000).optional(),
    stages: z.array(stageItem).max(20).optional(),
    ...relativeDue,
  })
  .strict()
  .superRefine(checkDue);

export type TaskSetItem = z.infer<typeof taskSetItem>;

const items = z.array(taskSetItem).min(1).max(TASK_SET_MAX_ITEMS);
const name = z.string().trim().min(1).max(80);

/** `shared: true` lets the rest of the caller's firm read (and apply) it; only the owner changes it. */
export const taskSetBody = z.object({ name, items, shared: z.boolean().optional() }).strict();

export const taskSetPatch = z
  .object({ name: name.optional(), items: items.optional(), shared: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const applyBody = z
  .object({
    studentIds: z.array(z.string().uuid()).min(1).max(APPLY_MAX_STUDENTS).optional(),
    classYear: z.string().regex(/^\d{4}$/, "Use a four-digit class year").optional(),
    notifyEmail: z.boolean().optional(),
  })
  .strict()
  .refine((v) => (v.studentIds === undefined) !== (v.classYear === undefined), "Pick students or a class year");

export type ApplyBody = z.infer<typeof applyBody>;

// ---- dates ----------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** `date` (YYYY-MM-DD) plus `days` calendar days. Noon UTC arithmetic: no zone, no DST. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Today's date in `timeZone` (the counselor's), UTC when unset or unknown. */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    } catch {
      // An unknown zone name: fall through to UTC.
    }
  }
  return now.toISOString().slice(0, 10);
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function onYear(y: number, month: number, day: number): string {
  return iso(y, month, month === 2 && day === 29 && !isLeap(y) ? 28 : day);
}

/** The next `month`/`day` on or after `today`; Feb 29 is Feb 28 in a year without one. */
export function nextMonthDay(month: number, day: number, today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = onYear(year, month, day);
  return thisYear >= today ? thisYear : onYear(year + 1, month, day);
}

/** An item's (or stage's) due date when applied on `today`, or null when it has none. */
export function dueDateFor(due: RelativeDue, today: string): string | null {
  if (due.dueOffsetDays !== undefined) return addDays(today, due.dueOffsetDays);
  if (due.dueMonth !== undefined && due.dueDay !== undefined) return nextMonthDay(due.dueMonth, due.dueDay, today);
  return null;
}

// ---- class year ---------------------------------------------------------------------------------

type RosterRow = { id?: unknown; grad_year?: unknown; archived_at?: unknown; role?: unknown };

/** The active (not archived) students of a roster whose class year is `year`, the blast filter's match. */
export function studentsInClass(roster: RosterRow[], year: string): string[] {
  const want = year.trim();
  return roster
    .filter((r) => r.role === "student" && !r.archived_at && String(r.grad_year ?? "").trim() === want)
    .map((r) => String(r.id));
}

// ---- DTO ----------------------------------------------------------------------------------------

export type TaskSetDto = {
  id: string;
  name: string;
  items: TaskSetItem[];
  /** Readable by the rest of the owner's firm. */
  shared: boolean;
  /** The caller owns it (and so may change or delete it). */
  mine: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export function toTaskSet(r: Record<string, unknown>, callerId: string): TaskSetDto {
  return {
    id: String(r.id),
    name: String(r.name),
    items: Array.isArray(r.items) ? (r.items as TaskSetItem[]) : [],
    shared: r.firm_id !== null && r.firm_id !== undefined,
    mine: r.counselor_id === callerId,
    ownerId: String(r.counselor_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
