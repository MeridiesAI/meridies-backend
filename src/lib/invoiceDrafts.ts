/**
 * Saved and scheduled invoices (pipeline_invoice_drafts, migration 20261124000004): the payload's shape and
 * the draft as the API returns it. A draft is NOT an invoice: nothing is numbered or billed until it is
 * sent, by `lib/invoiceDispatch.ts` through the same document builders as the counselor's own Send.
 */

import { z } from "zod";
import { composerFields, composerProblem, scheduleFields } from "./invoiceComposer.js";
import { invoiceAgreementInput } from "./invoiceAgreement.js";
import { resolveSendTime, type SendSchedule } from "./invoiceSchedule.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

/** What a draft stores: the invoice body (as POST /pipeline/contacts/:id/invoices takes it) and its schedule. */
export const draftPayload = z
  .object({
    label: z.string().trim().min(1).max(120),
    amountCents: z.number().int().min(1).max(100_000_000),
    dueOn: isoDate,
    agreement: invoiceAgreementInput.optional(),
    ...composerFields,
    ...scheduleFields,
  })
  .strict();
export type DraftPayload = z.infer<typeof draftPayload>;

export const draftStates = ["draft", "scheduled", "sent", "cancelled", "failed"] as const;
export type DraftState = (typeof draftStates)[number];

/** The body's own rules, with no clock: the composer's (lines add up, reminders in range, a text is sent) and a text carries no agreement. */
export function payloadProblem(p: DraftPayload): { code: string; message: string; status: number } | null {
  const c = composerProblem({ ...p, send: true });
  if (c) return { ...c, status: 400 };
  if (p.channel === "text" && p.agreement) return { code: "text_no_agreement", message: "An agreement goes with the invoice email, so it can't go in a text", status: 400 };
  return null;
}

/** A draft's body rules (the composer's, plus: a scheduled one needs a schedule that resolves to a future time). */
export function draftProblem(
  p: DraftPayload,
  state: "draft" | "scheduled",
  ctx: { tz: string | null | undefined; now: number; today: string }
): { code: string; message: string; status: number } | null {
  const body = payloadProblem(p);
  if (body) return body;
  if (p.dueOn < ctx.today) return { code: "due_passed", message: "The due date has already passed", status: 400 };
  if (state === "scheduled") {
    const t = resolveSendTime(p.schedule ?? { mode: "now" }, { dueOn: p.dueOn, tz: ctx.tz, now: ctx.now });
    if (!t.ok) return { code: t.code, message: t.reason, status: 400 };
  }
  return null;
}

/** When a scheduled draft goes: null for a draft; "now" means the next cron run (a minute ago, so it is due). */
export function sendAtFor(p: DraftPayload, state: "draft" | "scheduled", ctx: { tz: string | null | undefined; now: number }): string | null {
  if (state !== "scheduled") return null;
  const t = resolveSendTime((p.schedule ?? { mode: "now" }) as SendSchedule, { dueOn: p.dueOn, tz: ctx.tz, now: ctx.now });
  return t.ok ? (t.sendAt ?? new Date(ctx.now - 60_000).toISOString()) : null;
}

type Row = Record<string, unknown>;
export type DraftDTO = {
  id: string;
  contactId: string;
  payload: DraftPayload;
  state: DraftState;
  sendAt: string | null;
  repeatYearly: boolean;
  sentInvoiceId: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
export const toDraftDTO = (r: Row): DraftDTO => ({
  id: String(r.id),
  contactId: String(r.contact_id),
  payload: r.payload as DraftPayload,
  state: String(r.state) as DraftState,
  sendAt: (r.send_at as string | null) ?? null,
  repeatYearly: r.repeat_yearly === true,
  sentInvoiceId: (r.sent_invoice_id as string | null) ?? null,
  sentAt: (r.sent_at as string | null) ?? null,
  attempts: Number(r.attempts ?? 0),
  lastError: (r.last_error as string | null) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export const DRAFT_COLUMNS = "id, contact_id, payload, state, send_at, repeat_yearly, sent_invoice_id, sent_at, attempts, last_error, created_at, updated_at";
