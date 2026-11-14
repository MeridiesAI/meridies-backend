/**
 * What goes into an invoice email, shared by the counselor's routes (routes/pipeline.ts) and the crons
 * (lib/invoiceDispatch.ts): the draft's figures, the document built from them, and the message.
 *
 * Nothing here does billing arithmetic beyond calling `planInvoice` (lib/payments.ts); the card fee, when the
 * practice passes it on, is lib/invoiceCardFee.ts. The invoice composer's additions (the practice's look, ways
 * to pay, line items, the note, Cc) arrive as `extras`; without them the email is exactly the original one.
 */

import {
  billToOf,
  renderInvoiceEmail,
  renderInvoiceSms,
  type InvoiceDocument,
  type InvoiceEmailAgreement,
  type InvoiceStatus,
  type PracticeIdentity,
} from "./invoiceDocument.js";
import { withAgreementSubject } from "./invoiceAgreement.js";
import { feeFor, type InvoiceExtras } from "./invoiceSettings.js";
import { guardianFootnote } from "./parentCopy.js";
import { HttpError } from "./errors.js";
import { formatUsd, planInvoice, planLine, type AccountDTO } from "./payments.js";

type Row = Record<string, unknown>;

export type InvoiceDraft = {
  label: string;
  /** The package it bills: the invoice's one line item. */
  packageName: string;
  issuedOn: string;
  grossCents: number;
  creditAppliedCents: number;
  alreadyPaidCents: number;
  amountDueCents: number;
  dueOn: string;
  /** Which payment of the package this is, in words. */
  plan: string | null;
};

/**
 * The invoice document and email, the same for the preview and the send: the invoice document
 * (lib/invoiceDocument.ts) with every figure as the draft states it.
 * A pay link adds a "Pay by card" button. An agreement (lib/invoiceAgreement.ts) adds its block
 * above the invoice, a subject that says so, and `recordText` with its private link left out;
 * without one the email is exactly the invoice email.
 */
export function invoiceEmail(
  contact: Row,
  draft: InvoiceDraft,
  number: string | null,
  senderName: string | null,
  practice: PracticeIdentity,
  status: InvoiceStatus,
  payLink: string | null = null,
  agreement: InvoiceEmailAgreement | null = null,
  extras: InvoiceExtras | null = null
) {
  const parent = String(contact.parent_email ?? "");
  const own = String(contact.parent_email || contact.student_email || "");
  const to = extras?.to || own;
  const toParent = to ? to.toLowerCase() === parent.toLowerCase() || (!!extras?.to && to.toLowerCase() !== String(contact.student_email ?? "").toLowerCase()) : Boolean(parent);
  const doc: InvoiceDocument = {
    practice,
    number,
    issuedOn: draft.issuedOn,
    dueOn: draft.dueOn,
    billTo: billToOf(contact),
    lines: extras?.lines ?? [{ description: draft.packageName, detail: draft.label, amountCents: draft.grossCents }],
    subtotalCents: draft.grossCents,
    creditAppliedCents: draft.creditAppliedCents,
    alreadyPaidCents: draft.alreadyPaidCents,
    amountDueCents: draft.amountDueCents,
    status,
    payUrl: payLink,
    plan: draft.plan,
    footnote: toParent
      ? guardianFootnote(senderName)
      : senderName
        ? `Sent by ${senderName} through Meridies.`
        : "Sent through Meridies.",
    ...(extras
      ? { style: extras.style, methods: extras.methods, note: extras.note, feeCents: feeFor(extras, draft.amountDueCents), viewUrl: extras.viewUrl }
      : {}),
  };
  const { html, text, recordText } = renderInvoiceEmail(doc, agreement);
  const subject = `Invoice${number ? ` ${number}` : ""}: ${formatUsd(draft.amountDueCents)} due ${draft.dueOn}`;
  const first = String((toParent ? contact.parent_name : contact.student_name) ?? "").trim().split(/\s+/)[0] || null;
  return {
    to,
    cc: extras?.cc ?? [],
    recipientKind: toParent ? ("guardian" as const) : ("student" as const),
    subject: agreement ? withAgreementSubject(subject) : subject,
    html,
    text,
    /** The text-message version of the same invoice. */
    sms: renderInvoiceSms(doc, first),
    doc,
    ...(recordText !== undefined ? { recordText } : {}),
  };
}

/** A new invoice's status: nothing left to ask is paid (as deriveAccount will read it), else due. */
export const draftStatus = (d: InvoiceDraft): InvoiceStatus => (d.amountDueCents <= 0 ? "paid" : "due");

/** Plan an invoice for this account, or the 409 that says why it can't be sent. */
export function draftInvoice(account: AccountDTO, credits: boolean, b: { label: string; amountCents: number; dueOn: string }, issuedOn: string): InvoiceDraft {
  // Without the migration no credit can be recorded against an invoice.
  const plan = planInvoice(credits ? account : { ...account, creditCents: 0 }, b.amountCents);
  if (!plan.ok) throw new HttpError(409, plan.reason, plan.code);
  return {
    label: b.label,
    packageName: account.packageName,
    issuedOn,
    grossCents: plan.grossCents,
    creditAppliedCents: plan.creditAppliedCents,
    alreadyPaidCents: plan.alreadyPaidCents,
    amountDueCents: plan.amountDueCents,
    dueOn: b.dueOn,
    plan: planLine(account, account.invoices.filter((i) => i.state !== "void").length + 1),
  };
}
