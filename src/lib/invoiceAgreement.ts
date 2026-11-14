/**
 * An agreement sent with an invoice: one email to the family holding the invoice
 * (lib/invoiceDocument.ts) and a "Review and accept the agreement" button to the
 * agreement's own /agree/:token page (routes/agreements.ts). Used by
 * `POST /pipeline/contacts/:id/invoices` (new invoice), its preview, and
 * `POST /pipeline/invoices/:id/send` (Send again).
 *
 * NOTHING NEW IS STORED. The invoice and the agreement are linked only by the
 * email that carried both: the agreement is the contact's own (same
 * `contact_id`), its link is minted exactly as `POST /agreements/:id/send`
 * mints one (`issue_agreement_link` on the caller's client: `crm_can_bill`, 30
 * days, a resend expires the earlier links, status draft|sent -> sent), and the
 * delivery record (`message_deliveries`, template `pipeline-invoice-agreement`,
 * pointed at by the invoice's `message_delivery_id`) names the agreement with
 * its link left out. No column, no migration.
 *
 * The agreement's own rules are untouched: text only, immutable once sent (the
 * database's guard), accepted only through `accept_agreement` on the public
 * page. Typed-name acceptance, NOT a certified electronic signature.
 *
 * Behind AGREEMENTS_ENABLED like every agreements route: a request that asks
 * for an agreement while the switch is off is refused (404 `agreements_off`)
 * before anything is written, and a request without one is the invoice send
 * exactly as before.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { env } from "../env.js";
import {
  AGREEMENT_COLUMNS,
  agreementBodyText,
  agreementsEnabled,
  agreementsError,
  agreementsOff,
  agreementsUnavailable,
  agreementTitle,
  isOpenAgreement,
  mintAgreementLink,
  mintAgreementLinkAsService,
} from "./agreements.js";
import { CONTRACT_ATTACH_MAX_BYTES, CONTRACT_BUCKET, attachmentName, contractsUnavailable, sha256OfBytes, type ContractType } from "./contracts.js";
import { downloadCapped } from "./storageDownload.js";
import { serviceClient } from "./supabase.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import type { EmailAttachment } from "./email.js";
import { AGREEMENT_CONSENT_VERSION } from "./agreementConsent.js";
import { HttpError, notFound } from "./errors.js";

type Row = Record<string, unknown>;

/** One of the contact's agreements (draft or sent), or a new one written in the invoice form. */
export const invoiceAgreementInput = z.union([
  z.object({ agreementId: z.string().uuid() }).strict(),
  z.object({ title: agreementTitle, bodyText: agreementBodyText }).strict(),
  // A contract from the practice's library (lib/contracts.ts): saved as an agreement bound to the file.
  z.object({ contractId: z.string().uuid() }).strict(),
]);
export type InvoiceAgreementInput = z.infer<typeof invoiceAgreementInput>;

/** The delivery record's template when an invoice email carries an agreement. */
export const INVOICE_AGREEMENT_TEMPLATE = "pipeline-invoice-agreement";

/**
 * The gate, before anything is read or written: no agreement asked for is the old path; one
 * asked for needs the switch on, an address to send to, and the email actually going out.
 */
export function checkInvoiceAgreement(input: InvoiceAgreementInput | undefined, opts: { to: string; send: boolean }): void {
  if (!input) return;
  if (!agreementsEnabled()) throw agreementsOff();
  if (!opts.send) throw new HttpError(400, "An agreement goes out with the invoice email, so it can't be attached to an invoice you only record", "agreement_needs_send");
  if (!opts.to) throw new HttpError(400, "Add an email address to the contact's card first", "contact_no_email");
  if (!env.PUBLIC_API_URL) throw agreementsUnavailable();
}

/** The subject when an agreement goes with the invoice. */
export function withAgreementSubject(subject: string): string {
  return `${subject} · agreement to review`.slice(0, 200);
}

/**
 * The agreement to send: one of the contact's own that can still be sent (draft or sent; not
 * accepted, not void), read on the caller's client so RLS decides who may; or, for a new one, its
 * title and text, not yet saved (`saveInlineAgreement` saves it when the invoice goes out).
 */
export async function resolveInvoiceAgreement(
  db: SupabaseClient,
  contactId: string,
  input: InvoiceAgreementInput
): Promise<ResolvedAgreement> {
  if ("contractId" in input) {
    const { data, error } = await db.from("contract_files").select("id, name, storage_path, mime, size_bytes, sha256, archived_at").eq("id", input.contractId).maybeSingle();
    if (error) throw isResultsNotApplied(error) ? contractsUnavailable() : agreementsError(error);
    const file = data as unknown as Row | null;
    if (!file || file.archived_at) throw notFound("That contract isn't in your library");
    return {
      id: null,
      title: String(file.name).slice(0, 160),
      contract: { id: String(file.id), name: String(file.name), path: String(file.storage_path), mime: String(file.mime) as ContractType, sizeBytes: Number(file.size_bytes), sha256: String(file.sha256) },
    };
  }
  if (!("agreementId" in input)) return { id: null, title: input.title };
  const { data, error } = await db
    .from("agreements")
    .select(AGREEMENT_COLUMNS)
    .eq("id", input.agreementId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (error) throw agreementsError(error);
  const row = data as unknown as Row | null;
  if (!row) throw notFound("That agreement isn't one of this family's");
  if (!isOpenAgreement(row.status)) throw new HttpError(409, "This agreement was already accepted or withdrawn", "agreement_closed");
  return { id: String(row.id), title: String(row.title) };
}

/** The file a contract agreement is bound to. */
export type ContractRef = { id: string; name: string; path: string; mime: ContractType; sizeBytes: number; sha256: string };
export type ResolvedAgreement = { id: string | null; title: string; contract?: ContractRef };

/** A new agreement written in the invoice form, saved as a draft (exactly as `POST /agreements` saves one). */
export async function saveInlineAgreement(
  db: SupabaseClient,
  p: { contactId: string; counselorId: string; title: string; bodyText: string }
): Promise<string> {
  const { data, error } = await db
    .from("agreements")
    .insert({
      counselor_id: p.counselorId,
      contact_id: p.contactId,
      title: p.title,
      body_text: p.bodyText,
      consent_version: AGREEMENT_CONSENT_VERSION,
    })
    .select("id")
    .single();
  if (error) throw agreementsError(error);
  return String((data as Row).id);
}

/** A contract from the library, saved as a draft agreement bound to its file (the database writes its text from the file). */
export async function saveContractAgreement(
  db: SupabaseClient,
  p: { contactId: string; counselorId: string; contractId: string; title: string }
): Promise<string> {
  const { data, error } = await db
    .from("agreements")
    .insert({
      counselor_id: p.counselorId,
      contact_id: p.contactId,
      title: p.title,
      // Replaced by the guard with the file's own text; the column needs something.
      body_text: "Contract file",
      consent_version: AGREEMENT_CONSENT_VERSION,
      contract_file_id: p.contractId,
    })
    .select("id")
    .single();
  if (error) throw isResultsNotApplied(error) ? contractsUnavailable() : agreementsError(error);
  return String((data as Row).id);
}

/**
 * Save the inline draft if there is one, then mint the link the email carries, the same way
 * `POST /agreements/:id/send` does (and with the same effect: the agreement is `sent`, earlier
 * links stop working). Runs on the caller's client; `service: true` (the scheduled-invoice cron, no signed-in
 * user) runs on the service client and mints with `mintAgreementLinkAsService`.
 */
export async function issueInvoiceAgreement(
  db: SupabaseClient,
  p: {
    contactId: string;
    counselorId: string;
    input: InvoiceAgreementInput;
    resolved: ResolvedAgreement;
    service?: boolean;
  }
): Promise<{ id: string; title: string; url: string; contract?: ContractRef }> {
  const publicApiUrl = env.PUBLIC_API_URL;
  if (!publicApiUrl) throw agreementsUnavailable();
  const id =
    p.resolved.id ??
    (p.resolved.contract
      ? await saveContractAgreement(db, { contactId: p.contactId, counselorId: p.counselorId, contractId: p.resolved.contract.id, title: p.resolved.title })
      : await saveInlineAgreement(db, {
          contactId: p.contactId,
          counselorId: p.counselorId,
          title: p.resolved.title,
          bodyText: "bodyText" in p.input ? p.input.bodyText : "",
        }));
  try {
    const { url } = p.service
      ? await mintAgreementLinkAsService(db, id, { publicApiUrl, supersede: true, createdBy: p.counselorId })
      : await mintAgreementLink(db, id, { publicApiUrl });
    return { id, title: p.resolved.title, url, ...(p.resolved.contract ? { contract: p.resolved.contract } : {}) };
  } catch (err) {
    throw agreementsError(err as { code?: string; message?: string });
  }
}

/**
 * The contract's PDF as an email attachment, when it is a PDF of at most 5 MB (read with the service role from
 * the private bucket, after the caller has shown the contract is the practice's). A Word file, a larger one or a
 * read that fails sends no attachment: the email's link carries the family to the file.
 */
export async function contractAttachment(c: ContractRef | undefined, svc: SupabaseClient | null = serviceClient()): Promise<EmailAttachment[] | undefined> {
  if (!svc || !c || c.mime !== "application/pdf" || c.sizeBytes > CONTRACT_ATTACH_MAX_BYTES) return undefined;
  const got = await downloadCapped(svc, CONTRACT_BUCKET, c.path, CONTRACT_ATTACH_MAX_BYTES);
  // The bytes must be the ones whose hash was recorded (a signed upload URL can outlive the registration).
  if (got.status !== "ok" || sha256OfBytes(got.bytes) !== c.sha256) return undefined;
  return [{ filename: attachmentName(c.name, c.mime), content: got.bytes.toString("base64"), contentType: c.mime }];
}
