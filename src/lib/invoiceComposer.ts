/**
 * Invoice composer: the optional fields an invoice body may now carry (pure; no I/O).
 *
 * Everything here is OPTIONAL, so a payload from before the composer still validates and means what it
 * always meant. `amountCents` stays the invoice's amount; when `lines` are given they must add up to it
 * exactly (the server never lets a line list and the amount disagree: `deriveAccount` and `planInvoice` stay
 * the only billing arithmetic, they just see the same `amountCents`).
 */

import { z } from "zod";
import { SEND_HOUR, validateReminderOffsets, type SendSchedule } from "./invoiceSchedule.js";

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

export const MAX_LINES = 20;
export const lineItemInput = z
  .object({
    description: text(200).min(1),
    detail: text(200).nullable().optional(),
    amountCents: z.number().int().min(0).max(100_000_000),
  })
  .strict();
export type LineItemInput = z.infer<typeof lineItemInput>;

/** The lines as stored on the invoice (`line_items`): detail always present. */
export type StoredLine = { description: string; detail: string | null; amountCents: number };
export const toStoredLines = (lines: LineItemInput[]): StoredLine[] =>
  lines.map((l) => ({ description: l.description, detail: l.detail?.trim() || null, amountCents: l.amountCents }));

export type LinesCheck = { ok: true } | { ok: false; code: "lines_sum_mismatch"; reason: string };
/** The lines add up to the amount, to the cent. */
export function checkLines(lines: Array<{ amountCents: number }>, amountCents: number): LinesCheck {
  const sum = lines.reduce((n, l) => n + l.amountCents, 0);
  if (sum === amountCents) return { ok: true };
  return { ok: false, code: "lines_sum_mismatch", reason: `The line items add up to ${sum} cents, but the invoice amount is ${amountCents} cents. They must match.` };
}

const email = z.string().trim().toLowerCase().email().max(320);
const scheduleInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("now") }).strict(),
  z.object({ mode: z.literal("tomorrow") }).strict(),
  z.object({ mode: z.literal("before_due"), daysBefore: z.number().int().min(0).max(120) }).strict(),
  z.object({ mode: z.literal("date"), date: isoDate }).strict(),
]);

/** Extra fields on an invoice preview and create, and inside a draft's payload. All optional. */
export const composerFields = {
  lines: z.array(lineItemInput).min(1).max(MAX_LINES).optional(),
  /** Accepted payment method keys (practice_payment_methods.key); null/absent = card only, as before. */
  methods: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)).max(20).optional(),
  passCardFee: z.boolean().optional(),
  note: text(1000).optional(),
  cc: z.array(email).max(5).optional(),
  channel: z.enum(["email", "text"]).optional(),
  /** Day offsets from the due date: -3 = three days before, 0 = on the day, 3 = three days after. */
  reminders: z.array(z.number().int()).max(10).optional(),
  /** Send it to this address instead of the card's (parent, else student). */
  to: email.optional(),
};

/** What a draft stores besides the invoice body: when it goes. */
export const scheduleFields = { schedule: scheduleInput.optional() };
export type { SendSchedule };
export { SEND_HOUR };

/** Whether a body (or a draft's payload) carries any field the composer added (so the invoice records its look and options). */
export const hasComposerFields = (b: Partial<Record<"lines" | "methods" | "passCardFee" | "note" | "cc" | "reminders" | "to", unknown>>): boolean =>
  b.lines !== undefined || b.methods !== undefined || b.passCardFee !== undefined || b.note !== undefined || b.cc !== undefined || b.reminders !== undefined || b.to !== undefined;

/** Server-side rules on the composer fields that zod can't say; null when fine. */
export function composerProblem(b: { lines?: LineItemInput[]; amountCents: number; reminders?: number[]; channel?: string; send?: boolean }): { code: string; message: string } | null {
  if (b.lines) {
    const c = checkLines(b.lines, b.amountCents);
    if (!c.ok) return { code: c.code, message: c.reason };
  }
  if (b.reminders) {
    const r = validateReminderOffsets(b.reminders);
    if (!r.ok) return { code: "bad_reminders", message: r.reason };
  }
  if (b.channel === "text" && b.send === false) return { code: "text_needs_send", message: "A text goes out with the invoice, so it can't be attached to an invoice you only record" };
  return null;
}
