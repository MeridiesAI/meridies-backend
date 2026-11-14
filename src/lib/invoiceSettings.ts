/**
 * Invoice composer: reading the practice's settings (methods, style) for an invoice, with whatever client
 * the caller has (the counselor's, or the service role in the crons and the public pay page).
 *
 * Every read degrades: without the migration (20261124000003) or with a read error the invoice is the
 * invoice it always was (original look, card only). Never fails an invoice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { crmError } from "./crm.js";
import { HttpError } from "./errors.js";
import { acceptedMethods, BUILTIN_METHODS, toMethodDTO, type PaymentMethodDTO } from "./paymentMethods.js";
import { DEFAULT_STYLE, styleFromSnapshot, toStyle, type InvoiceStyle } from "./invoiceStyle.js";
import { cardFeeCents } from "./invoiceCardFee.js";
import { takesCardMethod } from "./paymentMethods.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import type { StoredLine } from "./invoiceComposer.js";

type Row = Record<string, unknown>;

export const settingsUnavailable = () => new HttpError(503, "Invoice settings aren't switched on yet", "invoice_settings_unavailable");
export const composerUnavailable = () =>
  new HttpError(503, "The invoice composer isn't switched on yet. Send the invoice without those options.", "invoice_composer_unavailable");

/** A database error from the settings tables: "not applied yet" is the calm 503, anything else the CRM mapping. */
export function settingsError(error: { code?: string; message?: string } | null): HttpError {
  return isResultsNotApplied(error) ? settingsUnavailable() : crmError(error);
}

/** The practice a contact belongs to: its firm, or its solo counselor. */
export const practiceIdOf = (contact: Row): string => String(contact.firm_id ?? contact.counselor_id);

/** The built-ins as a practice with nothing saved yet would show them (nothing persisted). */
export const virtualMethods = (): PaymentMethodDTO[] =>
  BUILTIN_METHODS.map((m) => ({ key: m.key, label: m.label, instructions: m.instructions, enabled: true, builtin: true, sort: m.sort }));

/** The practice's methods in order; the built-ins when none are saved or the table isn't there. */
export async function readMethods(db: SupabaseClient, practiceId: string): Promise<PaymentMethodDTO[]> {
  const { data, error } = await db.from("practice_payment_methods").select("*").eq("practice_id", practiceId).order("sort").order("created_at").limit(100);
  if (error || !data || data.length === 0) return virtualMethods();
  return (data as Row[]).map(toMethodDTO);
}

/** The practice's saved style; the original look's defaults when none or the table isn't there. */
export async function readStyle(db: SupabaseClient, practiceId: string): Promise<InvoiceStyle> {
  const { data, error } = await db.from("practice_invoice_style").select("*").eq("practice_id", practiceId).maybeSingle();
  return error || !data ? { ...DEFAULT_STYLE } : toStyle(data as Row);
}

/** What the composer adds to an invoice's document. Null: a plain invoice, drawn as before. */
export type InvoiceExtras = {
  style: InvoiceStyle;
  /** The accepted methods to list (enabled ones, practice order). */
  methods: PaymentMethodDTO[];
  /** The accepted keys as stored (null: card only). */
  acceptedKeys: string[] | null;
  note: string | null;
  passCardFee: boolean;
  lines: StoredLine[] | null;
  to: string | null;
  cc: string[];
};

export type ExtrasSource = {
  acceptedKeys?: string[] | null;
  /** A style to preview with instead of the saved one. */
  styleOverride?: InvoiceStyle | null;
  /** A sent invoice's stored look: wins, so it never re-skins. */
  snapshot?: unknown;
  note?: string | null;
  passCardFee?: boolean | null;
  lines?: StoredLine[] | null;
  to?: string | null;
  cc?: string[] | null;
};

/** Whether the source carries anything the composer added (else the document is the original). */
export const usesComposer = (s: ExtrasSource): boolean =>
  Boolean(s.acceptedKeys || s.snapshot || s.styleOverride || s.note || s.passCardFee || s.lines || s.to || (s.cc && s.cc.length));

export async function buildExtras(db: SupabaseClient, practiceId: string, s: ExtrasSource): Promise<InvoiceExtras | null> {
  if (!usesComposer(s)) return null;
  const [methods, saved] = await Promise.all([s.acceptedKeys ? readMethods(db, practiceId) : Promise.resolve([]), s.snapshot ? Promise.resolve(null) : s.styleOverride ? Promise.resolve(s.styleOverride) : readStyle(db, practiceId)]);
  const style = styleFromSnapshot(s.snapshot) ?? saved ?? { ...DEFAULT_STYLE };
  return {
    style,
    methods: acceptedMethods(s.acceptedKeys, methods),
    acceptedKeys: s.acceptedKeys ?? null,
    note: s.note?.trim() || null,
    passCardFee: s.passCardFee === true,
    lines: s.lines ?? null,
    to: s.to ?? null,
    cc: s.cc ?? [],
  };
}

/** The card fee for what is owed now, 0 unless the flag is on, the invoice passes it on and cards are accepted. */
export function feeFor(extras: InvoiceExtras | null, owedCents: number): number {
  return extras ? cardFeeCents(owedCents, extras.passCardFee && takesCardMethod(extras.acceptedKeys)) : 0;
}

/** An invoice row's composer columns as a source (Send again, the pay page, reminders). */
export function sourceFromInvoiceRow(r: Row): ExtrasSource {
  return {
    acceptedKeys: Array.isArray(r.accepted_methods) ? (r.accepted_methods as string[]) : null,
    snapshot: r.style_snapshot ?? null,
    note: (r.note as string | null) ?? null,
    passCardFee: r.pass_card_fee === true,
    lines: Array.isArray(r.line_items) ? (r.line_items as StoredLine[]) : null,
    cc: Array.isArray(r.cc) ? (r.cc as string[]) : null,
  };
}
