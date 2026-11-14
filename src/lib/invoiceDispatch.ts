/**
 * The invoice composer's two crons (routes/internal.ts):
 *
 *   dispatchDueInvoiceDrafts   every 10-15 minutes: send the scheduled drafts that are due, as real invoices.
 *   dispatchInvoiceReminders   hourly: send the reminders (-3 / 0 / +3 days from the due date, as the invoice says)
 *                              for invoices still owed.
 *
 * Both run on the service role with no signed-in user, so NOTHING a draft or an invoice row says is trusted: the
 * counselor who composed it must still be approved and still able to bill that family (the rule of
 * `private.crm_can_bill`, re-read here), the package, the credit rules and the amounts are planned again with
 * `planInvoice` (the same function the counselor's own Send uses, lib/invoiceSend.ts `draftInvoice`), and the
 * document comes from the same builders (`invoiceEmail`).
 *
 * Idempotent: a draft is CLAIMED before anything happens (`claimed_at`, reclaimed after ten minutes) and marked
 * `sent` the moment its invoice is numbered, before the email goes, so a crash never numbers a second invoice
 * (an email that fails leaves the invoice on file, unsent, exactly like the counselor's own Send). A reminder is
 * claimed by `claim_invoice_reminder` (one atomic update on `reminders_sent`) and released if its send fails.
 * A counselor's runs are capped at 100 sends a day; over it, the work waits for the next day's run.
 *
 * A yearly draft rolls: once sent, the next one is written a year on (same payload, due date a year later).
 * Before migration 20261124000004 both crons answer `ran: false`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { approvedCounselorIds } from "./access.js";
import { todayIn } from "./crm.js";
import { HttpError } from "./errors.js";
import { checkInvoiceAgreement, contractAttachment, issueInvoiceAgreement, resolveInvoiceAgreement } from "./invoiceAgreement.js";
import { toStoredLines } from "./invoiceComposer.js";
import { draftPayload, type DraftPayload } from "./invoiceDrafts.js";
import { invoiceStatus, readPractice, type PracticeIdentity } from "./invoiceDocument.js";
import { draftInvoice, draftStatus, invoiceEmail, type InvoiceDraft } from "./invoiceSend.js";
import { buildExtras, practiceIdOf, sourceFromInvoiceRow, type InvoiceExtras } from "./invoiceSettings.js";
import { nextYearlyDraft, reminderState } from "./invoiceSchedule.js";
import { snapshotOf } from "./invoiceStyle.js";
import { textingAvailable } from "./invoiceTexting.js";
import { sendEmail, sendSms } from "./email.js";
import { consumeRateLimit } from "./limits.js";
import { takesCardMethod } from "./paymentMethods.js";
import { formatUsd, planLine } from "./payments.js";
import { replyAddressFor } from "./replyRouting.js";
import { isResultsNotApplied } from "./resultsAvailability.js";
import { serializeErr } from "./requestLog.js";
import { invoiceOwed } from "./stripeConnect.js";
import { mintPayLink, practiceAccount, readAccount, stripeConfigured } from "./stripePractice.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export const INVOICE_DAILY_CAP = 100;
const CLAIM_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 3_600_000;

export type DraftTally = { sent: number; failed: number; retried: number; held: number; rolled: number };
export type ReminderTally = { sent: number; skipped: number; held: number; failed: number };

// ---- Shared: who may bill, who is writing --------------------------------------------------------

/** `private.crm_can_bill`, for the service role: a solo counselor's own contact, or in a firm an owner/admin or the contact's own consultant. */
export async function userCanBill(svc: SupabaseClient, contact: Row, userId: string): Promise<boolean> {
  const firmId = (contact.firm_id as string | null) ?? null;
  if (!firmId) return String(contact.counselor_id) === userId;
  const [member, firm] = await Promise.all([
    svc.from("firm_members").select("seat_role").eq("firm_id", firmId).eq("profile_id", userId).maybeSingle(),
    svc.from("firms").select("owner_id").eq("id", firmId).maybeSingle(),
  ]);
  if (member.error || firm.error) throw new Error("read firm for billing check");
  const role = (member.data as Row | null)?.seat_role;
  const isOwner = (firm.data as Row | null)?.owner_id === userId;
  return isOwner || role === "owner" || role === "admin" || (role != null && String(contact.owner_id ?? "") === userId);
}

type Sender = { fullName: string | null; email: string | null; timezone: string | null };
async function senderOf(svc: SupabaseClient, userId: string): Promise<Sender> {
  const { data } = await svc.from("profiles").select("full_name, email, timezone").eq("id", userId).maybeSingle();
  const r = (data as Row | null) ?? {};
  return { fullName: (r.full_name as string | null) ?? null, email: (r.email as string | null) ?? null, timezone: (r.timezone as string | null) ?? null };
}

async function practiceFor(svc: SupabaseClient, contact: Row, sender: Sender, userId: string): Promise<PracticeIdentity> {
  const firmId = (contact.firm_id as string | null) ?? null;
  const own = !firmId && String(contact.counselor_id) === userId ? sender.fullName : null;
  return readPractice(svc, { firmId, counselorId: String(contact.counselor_id) }, own);
}

async function senderFields(userId: string, contactId: string, party: "parent" | "student", sender: Sender, log: Log) {
  const routed = await replyAddressFor({ counselorId: userId, party, contactId }, log);
  const replyTo = routed ?? sender.email ?? undefined;
  return { fromName: sender.fullName, ...(replyTo ? { replyTo } : {}) };
}

/** A card pay link when the practice takes cards, else null; never throws. */
async function cardLink(svc: SupabaseClient, invoice: Row, owedCents: number, userId: string, log: Log): Promise<string | null> {
  if (owedCents <= 0) return null;
  try {
    if (!(await stripeConfigured(svc))) return null;
    const acct = await practiceAccount(svc, String(invoice.number_scope));
    return acct?.charges_enabled === true ? await mintPayLink(svc, String(invoice.id), userId) : null;
  } catch (err) {
    log.warn({ err: serializeErr(err) }, "invoice dispatch: could not make a pay link");
    return null;
  }
}

async function viewLink(svc: SupabaseClient, invoice: Row, userId: string, log: Log): Promise<string | null> {
  try {
    return await mintPayLink(svc, String(invoice.id), userId);
  } catch (err) {
    log.warn({ err: serializeErr(err) }, "invoice dispatch: could not make a view link");
    return null;
  }
}

let creditsReady = false;
async function creditsAvailable(svc: SupabaseClient): Promise<boolean> {
  if (creditsReady) return true;
  const probe = await svc.from("pipeline_invoices").select("credit_applied_cents").limit(0);
  if (!probe.error) creditsReady = true;
  return creditsReady;
}

// ---- Drafts ----------------------------------------------------------------------------------------------

/** A draft that can't ever be sent as written: failed with its reason, never retried. */
class Permanent extends Error {}

/** The draft's owner is not (or no longer) someone who may send: wait, don't fail. */
class Held extends Error {}

export async function dispatchDueInvoiceDrafts(svc: SupabaseClient, log: Log, max = 50): Promise<DraftTally & { ran: boolean }> {
  const tally: DraftTally = { sent: 0, failed: 0, retried: 0, held: 0, rolled: 0 };
  const now = new Date();
  const stale = new Date(now.getTime() - CLAIM_MS).toISOString();
  const { data, error } = await svc
    .from("pipeline_invoice_drafts")
    .select("*")
    .eq("state", "scheduled")
    .lte("send_at", now.toISOString())
    .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
    .order("send_at", { ascending: true })
    .limit(max);
  if (error && isResultsNotApplied(error)) return { ran: false, ...tally };
  if (error) throw new Error(`read invoice drafts failed (${error.code ?? "unknown"})`);
  const due = (data ?? []) as Row[];
  if (due.length === 0) return { ran: true, ...tally };
  const approved = await approvedCounselorIds(svc, due.map((d) => String(d.created_by ?? "")).filter(Boolean));

  for (const draft of due) {
    const id = String(draft.id);
    const creator = draft.created_by ? String(draft.created_by) : "";
    if (!creator || !approved.has(creator)) {
      tally.held += 1; // fail closed: a pending, revoked or deleted counselor sends nothing
      continue;
    }
    if (!(await consumeRateLimit(`invoice-draft:${creator}`, INVOICE_DAILY_CAP, 86_400))) {
      await svc.from("pipeline_invoice_drafts").update({ send_at: new Date(now.getTime() + RETRY_MS).toISOString() }).eq("id", id).eq("state", "scheduled");
      tally.held += 1;
      continue;
    }
    // Claim it. Two overlapping runs can't both win this update.
    const claim = await svc
      .from("pipeline_invoice_drafts")
      .update({ claimed_at: now.toISOString() })
      .eq("id", id)
      .eq("state", "scheduled")
      .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
      .select("id")
      .maybeSingle();
    if (claim.error || !claim.data) continue;

    try {
      const rolled = await sendDraft(svc, draft, creator, log);
      tally.sent += 1;
      if (rolled) tally.rolled += 1;
    } catch (err) {
      const message = err instanceof HttpError || err instanceof Permanent ? err.message : "Something went wrong sending it";
      if (err instanceof Held) {
        await svc.from("pipeline_invoice_drafts").update({ claimed_at: null }).eq("id", id).eq("state", "scheduled");
        tally.held += 1;
        continue;
      }
      const permanent = err instanceof Permanent || (err instanceof HttpError && err.statusCode < 500);
      const attempts = Number(draft.attempts ?? 0) + 1;
      if (!(err instanceof HttpError || err instanceof Permanent)) log.error({ err: serializeErr(err), draft: id }, "invoice dispatch: a scheduled invoice failed");
      if (permanent || attempts >= MAX_ATTEMPTS) {
        await svc.from("pipeline_invoice_drafts").update({ state: "failed", claimed_at: null, attempts, last_error: message.slice(0, 300) }).eq("id", id).eq("state", "scheduled");
        tally.failed += 1;
      } else {
        await svc
          .from("pipeline_invoice_drafts")
          .update({ claimed_at: null, attempts, last_error: message.slice(0, 300), send_at: new Date(now.getTime() + RETRY_MS).toISOString() })
          .eq("id", id)
          .eq("state", "scheduled");
        tally.retried += 1;
      }
    }
  }
  return { ran: true, ...tally };
}

/** Send one claimed draft. Returns whether it rolled a yearly copy. Throws Permanent / HttpError for what can never work as written. */
async function sendDraft(svc: SupabaseClient, draft: Row, creator: string, log: Log): Promise<boolean> {
  const parsed = draftPayload.safeParse(draft.payload);
  if (!parsed.success) throw new Permanent("This saved invoice is no longer valid. Open it and save it again.");
  const p: DraftPayload = parsed.data;
  const contactId = String(draft.contact_id);

  const { data: c, error: cErr } = await svc.from("pipeline_contacts").select("*").eq("id", contactId).maybeSingle();
  if (cErr) throw new Error(`read contact failed (${cErr.code ?? "unknown"})`);
  const contact = c as Row | null;
  if (!contact) throw new Permanent("The family is no longer in the pipeline");
  if (!(await userCanBill(svc, contact, creator))) throw new Permanent("The person who scheduled this can no longer bill this family");

  const sender = await senderOf(svc, creator);
  const today = todayIn(sender.timezone);
  if (p.dueOn < today) throw new Permanent("The due date had already passed when it was time to send");
  const account = await readAccount(svc, contactId, today);
  if (!account) throw new Permanent("This family has no package any more");
  const credits = await creditsAvailable(svc);
  const inv = draftInvoice(account, credits, p, today); // 409 nothing_to_invoice / over_billable / already_covered: refused, not retried

  const text = p.channel === "text";
  const to = p.to || String(contact.parent_email || contact.student_email || "");
  const phone = String(contact.parent_phone || contact.student_phone || "").trim();
  if (text) {
    if (!phone) throw new Permanent("The card has no phone number to text");
    if (!(await textingAvailable(creator))) throw new Permanent("Texting invoices needs your own texting number");
  } else if (!to) {
    throw new Permanent("The card has no email address");
  }
  checkInvoiceAgreement(p.agreement, { to, send: true });
  const resolved = p.agreement ? await resolveInvoiceAgreement(svc, contactId, p.agreement) : null;

  const practiceId = practiceIdOf(contact);
  const extras = await buildExtras(svc, practiceId, {
    acceptedKeys: p.methods ?? null,
    note: p.note ?? null,
    passCardFee: p.passCardFee ?? null,
    lines: p.lines ? toStoredLines(p.lines) : null,
    to: p.to ?? null,
    cc: p.cc ?? null,
  });
  const composer = extras !== null;

  const ins = await svc
    .from("pipeline_invoices")
    .insert({
      contact_id: contactId,
      label: p.label,
      amount_cents: inv.grossCents,
      ...(credits && inv.creditAppliedCents > 0 ? { credit_applied_cents: inv.creditAppliedCents } : {}),
      issued_on: today,
      due_on: p.dueOn,
      created_by: creator,
      ...(extras
        ? {
            line_items: p.lines ? toStoredLines(p.lines) : null,
            accepted_methods: p.methods ?? null,
            pass_card_fee: p.passCardFee === true,
            note: p.note?.trim() || null,
            cc: p.cc ?? null,
            reminders: p.reminders ? [...new Set(p.reminders)].sort((a, b) => a - b) : null,
            style_snapshot: snapshotOf(extras.style),
          }
        : {}),
    })
    .select("*")
    .single();
  if (ins.error) {
    if (ins.error.code === "23514" && /credit/.test(ins.error.message)) throw new HttpError(409, "The family's credit changed", "credit_changed");
    throw new Error(`insert invoice failed (${ins.error.code ?? "unknown"})`);
  }
  const invoice = ins.data as Row;

  // Numbered: the draft is spent now, whatever the email does next.
  const done = await svc
    .from("pipeline_invoice_drafts")
    .update({ state: "sent", sent_invoice_id: String(invoice.id), sent_at: new Date().toISOString(), claimed_at: null, last_error: null })
    .eq("id", String(draft.id))
    .eq("state", "scheduled");
  if (done.error) log.error({ draft: String(draft.id), invoice: String(invoice.id) }, "invoice dispatch: could not mark the draft sent");

  // The contract / agreement, linked to the invoice, with a link the family can use.
  let agreement: Awaited<ReturnType<typeof issueInvoiceAgreement>> | null = null;
  let problem: string | null = null;
  if (p.agreement && resolved) {
    try {
      agreement = await issueInvoiceAgreement(svc, { contactId, counselorId: creator, input: p.agreement, resolved, service: true });
      await svc.from("pipeline_invoices").update({ agreement_id: agreement.id }).eq("id", String(invoice.id));
    } catch (err) {
      problem = err instanceof HttpError ? err.message : "the agreement couldn't be sent";
    }
  }

  const cardOk = takesCardMethod(p.methods ?? null);
  const card = cardOk ? await cardLink(svc, invoice, inv.amountDueCents, creator, log) : null;
  const view = !card && (composer || text) ? await viewLink(svc, invoice, creator, log) : null;
  const withView: InvoiceExtras | null = extras && view ? { ...extras, viewUrl: view } : extras;
  const practice = await practiceFor(svc, contact, sender, creator);
  const mail = invoiceEmail(contact, inv, String(invoice.number), sender.fullName, practice, draftStatus(inv), card, agreement ? { title: agreement.title, url: agreement.url } : null, withView);

  let sentOk = false;
  let sentTo: string | null = null;
  let deliveryId: string | null = null;
  if (text) {
    const sms = await sendSms({ to: phone, body: mail.sms, template: "pipeline-invoice-sms", recipient_kind: contact.parent_phone ? "guardian" : "student", counselorId: creator, logger: log });
    sentOk = sms.status === "sent";
    sentTo = phone;
    deliveryId = sms.deliveryId;
  } else {
    const attachments = await contractAttachment(agreement?.contract, svc);
    const sent = await sendEmail({
      ...(await senderFields(creator, contactId, contact.parent_email ? "parent" : "student", sender, log)),
      to,
      ...(mail.cc.length ? { cc: mail.cc } : {}),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.recordText !== undefined ? { recordText: mail.recordText } : {}),
      ...(attachments ? { attachments } : {}),
      // The draft's id keys the provider's idempotency, so a retried send of the same draft can't mail twice.
      idempotencyKey: `invoice-draft:${String(draft.id)}`,
      template: agreement ? "pipeline-invoice-agreement" : "pipeline-invoice",
      recipient_kind: mail.recipientKind,
      logger: log,
    });
    sentOk = sent.sent;
    sentTo = to;
    deliveryId = sent.deliveryId;
  }
  await svc
    .from("pipeline_invoices")
    .update({ sent_to: sentTo, sent_at: sentOk ? new Date().toISOString() : null, message_delivery_id: deliveryId })
    .eq("id", String(invoice.id));
  if (!sentOk || problem) {
    await svc
      .from("pipeline_invoice_drafts")
      .update({ last_error: (problem ?? "The message didn't go out. Send it again from the family's history.").slice(0, 300) })
      .eq("id", String(draft.id));
  }

  // A yearly invoice writes next year's.
  if (draft.repeat_yearly === true && draft.send_at) {
    const next = nextYearlyDraft({ sendAt: String(draft.send_at), dueOn: p.dueOn, tz: sender.timezone });
    const schedule = p.schedule?.mode === "date" ? { mode: "date" as const, date: nextYearlyDraft({ sendAt: `${p.schedule.date}T12:00:00.000Z`, dueOn: p.schedule.date, tz: sender.timezone }).dueOn } : p.schedule;
    const roll = await svc.from("pipeline_invoice_drafts").insert({
      contact_id: contactId,
      payload: { ...p, dueOn: next.dueOn, ...(schedule ? { schedule } : {}) },
      state: "scheduled",
      send_at: next.sendAt,
      repeat_yearly: true,
      created_by: creator,
    });
    if (roll.error) {
      log.error({ draft: String(draft.id), code: roll.error.code }, "invoice dispatch: could not write next year's invoice");
      return false;
    }
    return true;
  }
  return false;
}

// ---- Reminders --------------------------------------------------------------------------------------------

/** The subject prefix and a one-line reminder, from the offset the reminder is for. */
export function reminderWords(offset: number): { prefix: string; line: string } {
  if (offset < 0) return { prefix: "Reminder", line: `A reminder: this invoice is due in ${-offset} day${offset === -1 ? "" : "s"}.` };
  if (offset === 0) return { prefix: "Reminder", line: "A reminder: this invoice is due today." };
  return { prefix: "Past due", line: `This invoice is ${offset} day${offset === 1 ? "" : "s"} past due.` };
}

export async function dispatchInvoiceReminders(svc: SupabaseClient, log: Log, max = 300): Promise<ReminderTally & { ran: boolean }> {
  const tally: ReminderTally = { sent: 0, skipped: 0, held: 0, failed: 0 };
  const now = Date.now();
  const day = 86_400_000;
  const { data, error } = await svc
    .from("pipeline_invoices")
    .select("*")
    .not("reminders", "is", null)
    .is("voided_at", null)
    .gte("due_on", new Date(now - 36 * day).toISOString().slice(0, 10))
    .lte("due_on", new Date(now + 36 * day).toISOString().slice(0, 10))
    .order("due_on", { ascending: true })
    .limit(max);
  if (error && isResultsNotApplied(error)) return { ran: false, ...tally };
  if (error) throw new Error(`read invoices for reminders failed (${error.code ?? "unknown"})`);
  const invoices = (data ?? []) as Row[];
  if (invoices.length === 0) return { ran: true, ...tally };

  const creators = new Map<string, Sender>();
  const approvedAll = await approvedCounselorIds(svc, invoices.map((i) => String(i.created_by ?? "")).filter(Boolean));

  for (const invoice of invoices) {
    const creator = invoice.created_by ? String(invoice.created_by) : "";
    const offsets = ((invoice.reminders as number[] | null) ?? []).filter((n) => Number.isInteger(n));
    const sent = (invoice.reminders_sent as Record<string, unknown> | null) ?? {};
    if (!creator || offsets.length === 0) continue;
    if (!creators.has(creator)) creators.set(creator, await senderOf(svc, creator));
    const sender = creators.get(creator) as Sender;
    const dueNow = offsets.filter((o) => sent[String(o)] === undefined && reminderState(String(invoice.due_on), o, now, sender.timezone) === "due");
    if (dueNow.length === 0) continue;
    if (!approvedAll.has(creator)) {
      tally.held += 1;
      continue;
    }
    try {
      const contactRes = await svc.from("pipeline_contacts").select("*").eq("id", String(invoice.contact_id)).maybeSingle();
      const contact = contactRes.data as Row | null;
      if (contactRes.error || !contact) continue;
      const today = todayIn(sender.timezone);
      const account = await readAccount(svc, String(invoice.contact_id), today);
      if (!account) continue;
      const { state, owedCents, invoice: dto } = invoiceOwed(account, String(invoice.id));
      if (!dto || state === "void" || state === "paid" || owedCents <= 0) {
        tally.skipped += dueNow.length; // paid or voided: nothing to remind about
        continue;
      }
      // One reminder per run per invoice: if two offsets fell due together (the cron was down), the latest says it.
      const offset = Math.max(...dueNow);
      if (!(await consumeRateLimit(`invoice-reminder:${creator}`, INVOICE_DAILY_CAP, 86_400))) {
        tally.held += 1;
        continue;
      }
      const claim = await svc.rpc("claim_invoice_reminder", { p_invoice: String(invoice.id), p_offset: offset });
      if (claim.error || claim.data !== true) continue;
      for (const other of dueNow.filter((o) => o !== offset)) await svc.rpc("claim_invoice_reminder", { p_invoice: String(invoice.id), p_offset: other });

      const ok = await sendReminder(svc, invoice, contact, account, creator, sender, offset, log);
      if (ok) tally.sent += 1;
      else {
        await svc.rpc("release_invoice_reminder", { p_invoice: String(invoice.id), p_offset: offset });
        for (const other of dueNow.filter((o) => o !== offset)) await svc.rpc("release_invoice_reminder", { p_invoice: String(invoice.id), p_offset: other });
        tally.failed += 1;
      }
    } catch (err) {
      log.error({ err: serializeErr(err), invoice: String(invoice.id) }, "invoice dispatch: a reminder failed");
      tally.failed += 1;
    }
  }
  return { ran: true, ...tally };
}

async function sendReminder(
  svc: SupabaseClient,
  invoice: Row,
  contact: Row,
  account: NonNullable<Awaited<ReturnType<typeof readAccount>>>,
  creator: string,
  sender: Sender,
  offset: number,
  log: Log
): Promise<boolean> {
  const { state, owedCents, invoice: dto } = invoiceOwed(account, String(invoice.id));
  if (!dto) return false;
  const live = account.invoices.filter((i) => i.state !== "void").sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.number.localeCompare(b.number, undefined, { numeric: true }));
  const draft: InvoiceDraft = {
    label: dto.label,
    packageName: account.packageName,
    issuedOn: dto.issuedOn,
    grossCents: dto.amountCents,
    creditAppliedCents: dto.creditAppliedCents,
    alreadyPaidCents: dto.paidCents,
    amountDueCents: owedCents,
    dueOn: dto.dueOn,
    plan: planLine(account, live.findIndex((i) => i.id === dto.id) + 1),
  };
  let extras = await buildExtras(svc, practiceIdOf(contact), sourceFromInvoiceRow(invoice));
  const card = takesCardMethod(extras?.acceptedKeys) ? await cardLink(svc, invoice, owedCents, creator, log) : null;
  if (extras && !card) {
    const view = await viewLink(svc, invoice, creator, log);
    if (view) extras = { ...extras, viewUrl: view };
  }
  const practice = await practiceFor(svc, contact, sender, creator);
  const mail = invoiceEmail(contact, draft, dto.number, sender.fullName, practice, invoiceStatus(state ?? dto.state), card, null, extras);
  const words = reminderWords(offset);
  const sentTo = String(invoice.sent_to ?? "");
  const viaText = sentTo !== "" && !sentTo.includes("@");

  if (viaText) {
    const phone = sentTo;
    const link = card ?? extras?.viewUrl ?? "";
    const sms = await sendSms({
      to: phone,
      body: `${words.prefix}: ${practice.name} invoice ${dto.number}, ${formatUsd(owedCents)} due ${dto.dueOn}.${link ? ` ${link}` : ""}`,
      template: "pipeline-invoice-reminder",
      recipient_kind: contact.parent_phone ? "guardian" : "student",
      counselorId: creator,
      logger: log,
    });
    return sms.status === "sent";
  }
  const to = sentTo || String(contact.parent_email || contact.student_email || "");
  if (!to) return false;
  const sent = await sendEmail({
    ...(await senderFields(creator, String(contact.id), contact.parent_email ? "parent" : "student", sender, log)),
    to,
    ...(mail.cc.length ? { cc: mail.cc } : {}),
    subject: `${words.prefix}: ${mail.subject}`,
    html: mail.html,
    text: `${words.line}\n\n${mail.text}`,
    idempotencyKey: `invoice-reminder:${String(invoice.id)}:${offset}`,
    template: "pipeline-invoice-reminder",
    recipient_kind: mail.recipientKind,
    logger: log,
  });
  return sent.sent;
}

