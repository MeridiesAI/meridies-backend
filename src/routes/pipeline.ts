/**
 * Contact Pipeline (demo v7-v10) and its Payment Tracker (v8).
 *
 * Families from first inquiry to active student, as stage columns of cards.
 * Everything here is the practice's private CRM: counselor-only, scoped to the
 * caller's workspace (their firm's, or their own when solo) by RLS, with the
 * workspace read through `lib/crm.ts`. Students never reach any of it.
 *
 * Multi-row operations (seeding the default stages, deleting a stage and
 * moving its contacts, reordering, writing a dragged layout back) are single
 * database functions so a half-applied drag can't leave the board torn.
 *
 * A contact becomes a student through the normal email invitation
 * (`POST /pipeline/contacts/:id/invite`, via lib/invites.ts createInvitation);
 * the contact keeps the invitation, and a trigger fills `studentId` when it
 * is accepted, at which point the four sections open the real student.
 *
 * Money is integer cents. Balances and statuses are derived on every read by
 * lib/payments.ts and never stored.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { crmError, fillTemplate, loadWorkspace, paragraphs, todayIn, type Workspace } from "../lib/crm.js";
import { brandedEmail, brandedText, sendEmail } from "../lib/email.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { createInvitation } from "../lib/invites.js";
import { enforceQuota, limit } from "../lib/limits.js";
import { deriveAccount, formatUsd, PAYMENT_METHODS, planInvoice, planPayment, totals, type AccountDTO } from "../lib/payments.js";
import {
  CONTACT_EXTRA_COLUMNS,
  extrasUnavailable,
  FOLLOWUP_COLUMNS,
  NO_FOLLOWUPS,
  pipelineExtrasReady,
  summarizeFollowups,
  type FollowupSummary,
} from "../lib/pipelineExtras.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";

type Row = Record<string, unknown>;

export const LIFECYCLE_GROUPS = ["prospect", "lead", "client", "current"] as const;
export type LifecycleGroup = (typeof LIFECYCLE_GROUPS)[number];

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid }).strict();
const shortText = (max: number) => z.string().trim().max(max);
const optionalEmail = z.union([z.literal(""), z.string().trim().toLowerCase().email().max(320)]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

/** The info-card fields a contact carries before they are a student. */
const contactInfo = z
  .object({
    address: shortText(300),
    gender: shortText(60),
    birthday: shortText(20),
    citizenship: shortText(60),
    highSchool: shortText(200),
    firstGen: shortText(20),
    livingWithParent: shortText(20),
    maritalStatus: shortText(40),
    gpaWeighted: shortText(10),
    gpaUnweighted: shortText(10),
    classRank: shortText(40),
    sat: shortText(10),
    act: shortText(10),
    rigor: shortText(200),
    intendedMajors: shortText(300),
  })
  .partial()
  .strict();

/** "New contact" and friends are what an unsaved form says, not a family's name. */
const PLACEHOLDER_NAME = /^(new contact|new student|untitled( contact)?|unnamed|name|student name)$/i;
const contactName = shortText(200).refine((n) => n.length > 0 && !PLACEHOLDER_NAME.test(n), {
  message: "Give the contact a name first",
});

const contactFields = {
  studentName: contactName,
  gradYear: z.number().int().min(2000).max(2100).nullable(),
  studentEmail: optionalEmail,
  studentPhone: shortText(40),
  parentName: shortText(200),
  parentEmail: optionalEmail,
  parentPhone: shortText(40),
  nextStep: shortText(300),
  ownerId: uuid.nullable(),
  info: contactInfo,
  source: shortText(80),
};

/** Won, lost or still open; a reason goes with "lost" only. */
const CONTACT_STATUSES = ["open", "won", "lost"] as const;
type ContactStatus = (typeof CONTACT_STATUSES)[number];
const statusFields = {
  status: z.enum(CONTACT_STATUSES),
  lostReason: shortText(300),
};

const CONTACT_COLUMNS_BASE =
  "id, firm_id, counselor_id, stage_id, position, student_name, grad_year, student_email, student_phone, " +
  "parent_name, parent_email, parent_phone, next_step, owner_id, info, stage_entered_at, invitation_id, " +
  "invited_at, student_id, created_at, updated_at";

/** The extra columns only once the history migration is in (20261028000003). */
async function contactColumns(request: FastifyRequest): Promise<string> {
  return (await pipelineExtrasReady(request)) ? `${CONTACT_COLUMNS_BASE}, ${CONTACT_EXTRA_COLUMNS}` : CONTACT_COLUMNS_BASE;
}

const STAGE_COLUMNS = "id, name, position, lifecycle_group";

// ---- Serializers -----------------------------------------------------------

export function toStage(r: Row) {
  return {
    id: String(r.id),
    name: String(r.name),
    position: Number(r.position ?? 0),
    lifecycleGroup: String(r.lifecycle_group) as LifecycleGroup,
  };
}

export type ContactConversion = "not-invited" | "invited" | "joined";

function daysBetween(fromIso: string, today: string, timezone: string | null): number {
  const from = todayAt(new Date(fromIso), timezone);
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

function todayAt(d: Date, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone?.trim() || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function toContact(
  r: Row,
  ctx: {
    today: string;
    timezone: string | null;
    groups: Map<string, LifecycleGroup>;
    /** Open follow-ups per contact; absent before the history migration. */
    followups?: Map<string, FollowupSummary>;
  }
) {
  const stageId = String(r.stage_id);
  const studentId = (r.student_id as string | null) ?? null;
  const invitationId = (r.invitation_id as string | null) ?? null;
  const followups = ctx.followups?.get(String(r.id)) ?? NO_FOLLOWUPS;
  return {
    id: String(r.id),
    stageId,
    lifecycleGroup: ctx.groups.get(stageId) ?? "prospect",
    position: Number(r.position ?? 0),
    studentName: String(r.student_name ?? ""),
    gradYear: (r.grad_year as number | null) ?? null,
    studentEmail: String(r.student_email ?? ""),
    studentPhone: String(r.student_phone ?? ""),
    parentName: String(r.parent_name ?? ""),
    parentEmail: String(r.parent_email ?? ""),
    parentPhone: String(r.parent_phone ?? ""),
    nextStep: String(r.next_step ?? ""),
    ownerId: (r.owner_id as string | null) ?? null,
    info: (r.info as Record<string, string> | null) ?? {},
    stageEnteredAt: String(r.stage_entered_at),
    daysInStage: daysBetween(String(r.stage_entered_at), ctx.today, ctx.timezone),
    conversion: (studentId ? "joined" : invitationId ? "invited" : "not-invited") as ContactConversion,
    invitationId,
    invitedAt: (r.invited_at as string | null) ?? null,
    studentId,
    source: String(r.source ?? ""),
    status: ((r.status as ContactStatus | undefined) ?? "open") as ContactStatus,
    lostReason: String(r.lost_reason ?? ""),
    lastContactedAt: (r.last_contacted_at as string | null | undefined) ?? null,
    openFollowups: followups.openFollowups,
    nextFollowup: followups.nextFollowup,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export type ContactDTO = ReturnType<typeof toContact>;

// ---- Helpers ---------------------------------------------------------------

async function workspaceStages(request: FastifyRequest, ws: Workspace): Promise<Row[]> {
  let q = request.db.from("pipeline_stages").select(STAGE_COLUMNS);
  q = ws.firmId ? q.eq("firm_id", ws.firmId) : q.is("firm_id", null).eq("counselor_id", request.auth.userId);
  const { data, error } = await q.order("position").order("created_at").limit(200);
  if (error) throw crmError(error);
  return (data ?? []) as unknown as Row[];
}

async function loadContactRow(request: FastifyRequest, id: string): Promise<Row> {
  const { data, error } = await request.db
    .from("pipeline_contacts")
    .select(await contactColumns(request))
    .eq("id", id)
    .maybeSingle();
  if (error) throw crmError(error);
  if (!data) throw notFound("That contact isn't in your pipeline");
  return data as unknown as Row;
}

/**
 * Open follow-ups, summarised per contact: the whole workspace's for the board,
 * or one contact's after a single-card write. Empty before the migration.
 */
async function openFollowupSummaries(
  request: FastifyRequest,
  ws: Workspace,
  today: string,
  contactId?: string
): Promise<Map<string, FollowupSummary> | undefined> {
  if (!(await pipelineExtrasReady(request))) return undefined;
  let q = request.db.from("pipeline_followups").select(FOLLOWUP_COLUMNS).eq("done", false);
  if (contactId) q = q.eq("contact_id", contactId);
  else q = ws.firmId ? q.eq("firm_id", ws.firmId) : q.is("firm_id", null).eq("counselor_id", request.auth.userId);
  const { data, error } = await q.order("due_on", { ascending: true, nullsFirst: false }).limit(5000);
  if (error) throw crmError(error);
  return summarizeFollowups((data ?? []) as unknown as Row[], today);
}

async function contactContext(request: FastifyRequest, ws: Workspace, contactId?: string) {
  const today = todayIn(request.profile.timezone);
  const [stages, followups] = await Promise.all([
    workspaceStages(request, ws),
    openFollowupSummaries(request, ws, today, contactId),
  ]);
  return {
    today,
    timezone: request.profile.timezone,
    groups: new Map(stages.map((s) => [String(s.id), String(s.lifecycle_group) as LifecycleGroup])),
    followups,
  };
}

async function serializeOne(request: FastifyRequest, ws: Workspace, row: Row) {
  return toContact(row, await contactContext(request, ws, String(row.id)));
}

/** The workspace's consultants (for the Owner picker), names only. */
export async function consultants(request: FastifyRequest): Promise<{ id: string; name: string }[]> {
  const { data, error } = await request.db.rpc("firm_consultants");
  if (error) throw crmError(error);
  return ((data ?? []) as Row[]).map((r) => ({ id: String(r.profile_id), name: String(r.full_name ?? "") }));
}

function contactPatchToRow(
  b: Partial<z.infer<z.ZodObject<typeof contactFields>>> & { status?: ContactStatus; lostReason?: string }
): Row {
  const row: Row = {};
  if (b.source !== undefined) row.source = b.source;
  if (b.status !== undefined) row.status = b.status;
  if (b.lostReason !== undefined) row.lost_reason = b.lostReason;
  if (b.studentName !== undefined) row.student_name = b.studentName;
  if (b.gradYear !== undefined) row.grad_year = b.gradYear;
  if (b.studentEmail !== undefined) row.student_email = b.studentEmail;
  if (b.studentPhone !== undefined) row.student_phone = b.studentPhone;
  if (b.parentName !== undefined) row.parent_name = b.parentName;
  if (b.parentEmail !== undefined) row.parent_email = b.parentEmail;
  if (b.parentPhone !== undefined) row.parent_phone = b.parentPhone;
  if (b.nextStep !== undefined) row.next_step = b.nextStep;
  if (b.ownerId !== undefined) row.owner_id = b.ownerId;
  return row;
}

/**
 * A contact in the workspace (lost ones too) whose student or parent email is
 * one of these, other than `exceptId` (the card being edited).
 */
async function findContactByEmail(
  request: FastifyRequest,
  ws: Workspace,
  emails: string[],
  exceptId?: string
): Promise<Row | null> {
  for (const column of ["student_email", "parent_email"] as const) {
    let q = request.db.from("pipeline_contacts").select("id, student_name").in(column, emails);
    if (exceptId) q = q.neq("id", exceptId);
    q = ws.firmId ? q.eq("firm_id", ws.firmId) : q.is("firm_id", null).eq("counselor_id", request.auth.userId);
    const { data, error } = await q.limit(1);
    if (error) throw crmError(error);
    const hit = (data ?? [])[0] as Row | undefined;
    if (hit) return hit;
  }
  return null;
}

async function nextPosition(request: FastifyRequest, stageId: string): Promise<number> {
  const { data, error } = await request.db
    .from("pipeline_contacts")
    .select("position")
    .eq("stage_id", stageId)
    .order("position", { ascending: false })
    .limit(1);
  if (error) throw crmError(error);
  const top = (data ?? [])[0] as Row | undefined;
  return top ? Number(top.position) + 1 : 0;
}

/** Billing is for the firm's owners/admins and the contact's owner (RLS: crm_can_bill). */
// ---- Payment credits (20261028000004) ----------------------------------------
// A zero-row probe; ready is kept for the process, missing for 30 s. Until the
// migration is applied an overpayment and a refund are refused (409
// payment_credits_unavailable) and invoices apply no credit.

const CREDITS_RECHECK_MS = 30_000;
let creditsReady = false;
let creditsMissingAt = 0;

export async function paymentCreditsReady(request: FastifyRequest): Promise<boolean> {
  if (creditsReady) return true;
  if (Date.now() - creditsMissingAt < CREDITS_RECHECK_MS) return false;
  const [pay, inv, ref] = await Promise.all([
    request.db.from("pipeline_payments").select("credit_cents").limit(0),
    request.db.from("pipeline_invoices").select("credit_applied_cents").limit(0),
    request.db.from("pipeline_credit_refunds").select("id").limit(0),
  ]);
  const error = pay.error ?? inv.error ?? ref.error;
  if (!error) {
    creditsReady = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    creditsMissingAt = Date.now();
    return false;
  }
  throw crmError(error);
}

const creditsUnavailable = () =>
  new HttpError(409, "Recording credit isn't switched on yet. Record the payment for what's left on the package.", "payment_credits_unavailable");

/** The database refused spending more credit than the family holds (a race, or a forged row). */
function isCreditGuard(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "23514" && /credit than this family holds|pipeline_credit/.test(error.message ?? "");
}

async function loadAccount(request: FastifyRequest, contactId: string): Promise<AccountDTO | null> {
  const credits = await paymentCreditsReady(request);
  const [pkg, invoices, payments, refunds] = await Promise.all([
    request.db.from("pipeline_packages").select("*").eq("contact_id", contactId).maybeSingle(),
    request.db.from("pipeline_invoices").select("*").eq("contact_id", contactId).limit(500),
    request.db.from("pipeline_payments").select("*").eq("contact_id", contactId).limit(500),
    credits
      ? request.db.from("pipeline_credit_refunds").select("*").eq("contact_id", contactId).limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pkg.error) throw crmError(pkg.error);
  if (invoices.error) throw crmError(invoices.error);
  if (payments.error) throw crmError(payments.error);
  if (refunds.error) throw crmError(refunds.error);
  if (!pkg.data) return null;
  return deriveAccount(
    pkg.data as Row,
    (invoices.data ?? []) as Row[],
    (payments.data ?? []) as Row[],
    todayIn(request.profile.timezone),
    (refunds.data ?? []) as Row[]
  );
}

type InvoiceDraft = { label: string; grossCents: number; creditAppliedCents: number; alreadyPaidCents: number; amountDueCents: number; dueOn: string };

/** The invoice email, the same for the preview and the send. */
function invoiceEmail(contact: Row, draft: InvoiceDraft, number: string | null, senderName: string | null) {
  const to = String(contact.parent_email || contact.student_email || "");
  const name = String(contact.student_name ?? "").trim();
  const lines = [`${draft.label}${name ? ` for ${name}` : ""}: ${formatUsd(draft.grossCents)}.`];
  if (draft.creditAppliedCents > 0) lines.push(`Credit applied: −${formatUsd(draft.creditAppliedCents)}.`);
  if (draft.alreadyPaidCents > 0) lines.push(`Already paid: −${formatUsd(draft.alreadyPaidCents)}.`);
  lines.push(`Amount due: ${formatUsd(draft.amountDueCents)}, by ${draft.dueOn}.`);
  if (draft.amountDueCents === 0) lines.push("Your credit covers this invoice in full. There's nothing to pay.");
  lines.push("Reply to this email with any questions about the invoice.");
  const template = {
    heading: number ? `Invoice ${number}` : "Invoice",
    paragraphs: lines,
    footnote: senderName ? `Sent by ${senderName} through Meridies.` : "Sent through Meridies.",
  };
  return {
    to,
    recipientKind: contact.parent_email ? ("guardian" as const) : ("student" as const),
    subject: `Invoice${number ? ` ${number}` : ""}: ${formatUsd(draft.amountDueCents)} due ${draft.dueOn}`,
    html: brandedEmail(template),
    text: brandedText(template),
  };
}

/** Plan an invoice for this account, or the 409 that says why it can't be sent. */
function draftInvoice(account: AccountDTO, credits: boolean, b: { label: string; amountCents: number; dueOn: string }): InvoiceDraft {
  // Without the migration no credit can be recorded against an invoice.
  const plan = planInvoice(credits ? account : { ...account, creditCents: 0 }, b.amountCents);
  if (!plan.ok) throw new HttpError(409, plan.reason, plan.code);
  return {
    label: b.label,
    grossCents: plan.grossCents,
    creditAppliedCents: plan.creditAppliedCents,
    alreadyPaidCents: plan.alreadyPaidCents,
    amountDueCents: plan.amountDueCents,
    dueOn: b.dueOn,
  };
}

async function requireAccount(request: FastifyRequest, contactId: string): Promise<AccountDTO> {
  // Visible contact first, so "no package" and "not yours" read differently.
  await loadContactRow(request, contactId);
  const account = await loadAccount(request, contactId);
  if (!account) {
    throw notFound("Set up a package for this family first, or ask a firm admin to");
  }
  return account;
}

export default async function pipelineRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];
  const read = (name: string, max = 120) => [...counselor, limit(name, max, 60)];
  const write = (name: string, max = 120) => [...counselor, limit(name, max, 60)];

  // ---- Board -----------------------------------------------------------------

  /** The whole board: stages (seeded on first open), contacts, consultants. */
  app.get("/", { preHandler: read("pipeline:board") }, async (request) => {
    const ws = await loadWorkspace(request);
    const history = await pipelineExtrasReady(request);
    const today = todayIn(request.profile.timezone);
    // The stages wait for the seed; the contacts and the consultants don't, so
    // they go out alongside it. A lost contact leaves the board (GET /lost).
    let q = request.db.from("pipeline_contacts").select(await contactColumns(request));
    q = ws.firmId ? q.eq("firm_id", ws.firmId) : q.is("firm_id", null).eq("counselor_id", request.auth.userId);
    if (history) q = q.neq("status", "lost");
    const [stages, { data, error }, people, followups] = await Promise.all([
      (async () => {
        const seeded = await request.db.rpc("ensure_pipeline_stages");
        if (seeded.error) throw crmError(seeded.error);
        return workspaceStages(request, ws);
      })(),
      q.order("position").order("created_at").limit(2000),
      consultants(request),
      openFollowupSummaries(request, ws, today),
    ]);
    if (error) throw crmError(error);

    const ctx = {
      today,
      timezone: request.profile.timezone,
      groups: new Map(stages.map((s) => [String(s.id), String(s.lifecycle_group) as LifecycleGroup])),
      followups,
    };
    return {
      workspace: { firmId: ws.firmId, isAdmin: ws.isAdmin },
      // False until the history migration is applied; the app hides the timeline and follow-ups.
      historyEnabled: history,
      stages: stages.map(toStage),
      contacts: ((data ?? []) as unknown as Row[]).map((r) => toContact(r, ctx)),
      consultants: people,
    };
  });

  /** Contacts marked lost, newest first, so one can be reopened (`PATCH` status "open"). */
  app.get("/lost", { preHandler: read("pipeline:lost") }, async (request) => {
    if (!(await pipelineExtrasReady(request))) throw extrasUnavailable();
    const ws = await loadWorkspace(request);
    let q = request.db.from("pipeline_contacts").select(await contactColumns(request)).eq("status", "lost");
    q = ws.firmId ? q.eq("firm_id", ws.firmId) : q.is("firm_id", null).eq("counselor_id", request.auth.userId);
    const { data, error } = await q.order("updated_at", { ascending: false }).limit(500);
    if (error) throw crmError(error);
    const ctx = await contactContext(request, ws);
    return { contacts: ((data ?? []) as unknown as Row[]).map((r) => toContact(r, ctx)) };
  });

  /** Write a dragged layout back: { stageId: [contactId, ...] } in order. */
  app.put("/layout", { preHandler: write("pipeline:layout", 240) }, async (request) => {
    const b = z
      .object({ layout: z.record(uuid, z.array(uuid).max(2000)) })
      .strict()
      .parse(request.body);
    if (Object.keys(b.layout).length > 200) throw badRequest("Too many stages in one layout");
    const { error } = await request.db.rpc("apply_pipeline_layout", { p_layout: b.layout });
    if (error) throw crmError(error);
    return { ok: true };
  });

  // ---- Stages ----------------------------------------------------------------

  app.post("/stages", { preHandler: write("pipeline:stages") }, async (request, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(120).default("New stage"),
        lifecycleGroup: z.enum(LIFECYCLE_GROUPS).default("prospect"),
      })
      .strict()
      .parse(request.body ?? {});
    const ws = await loadWorkspace(request);
    const stages = await workspaceStages(request, ws);
    if (stages.length >= 40) throw badRequest("A pipeline can have at most 40 stages");

    const { data, error } = await request.db
      .from("pipeline_stages")
      .insert({
        firm_id: ws.firmId,
        counselor_id: request.auth.userId,
        name: b.name,
        lifecycle_group: b.lifecycleGroup,
        position: stages.length,
      })
      .select(STAGE_COLUMNS)
      .single();
    if (error) throw crmError(error);
    return reply.code(201).send(toStage(data as unknown as Row));
  });

  /** Rename in place, or move the stage to another lifecycle group. */
  app.patch("/stages/:id", { preHandler: write("pipeline:stages") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        lifecycleGroup: z.enum(LIFECYCLE_GROUPS).optional(),
      })
      .strict()
      .parse(request.body);
    const update: Row = {};
    if (b.name !== undefined) update.name = b.name;
    if (b.lifecycleGroup !== undefined) update.lifecycle_group = b.lifecycleGroup;
    if (Object.keys(update).length === 0) throw badRequest("Nothing to change");

    const { data, error } = await request.db
      .from("pipeline_stages")
      .update(update)
      .eq("id", id)
      .select(STAGE_COLUMNS)
      .maybeSingle();
    if (error) throw crmError(error);
    if (!data) throw notFound("That stage isn't in your pipeline");
    return toStage(data as unknown as Row);
  });

  /** Drag & drop to re-order: every stage id, in the new order. */
  app.put("/stages/order", { preHandler: write("pipeline:stages") }, async (request) => {
    const b = z.object({ ids: z.array(uuid).min(1).max(40) }).strict().parse(request.body);
    const { error } = await request.db.rpc("reorder_pipeline_stages", { p_ids: b.ids });
    if (error) throw crmError(error);
    const ws = await loadWorkspace(request);
    return (await workspaceStages(request, ws)).map(toStage);
  });

  /** Delete a stage; its contacts move to the stage before it (the first's go to the last). */
  app.delete("/stages/:id", { preHandler: write("pipeline:stages") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db.rpc("delete_pipeline_stage", { p_stage: id });
    if (error) throw crmError(error);
    return { movedTo: String(data) };
  });

  // ---- Contacts --------------------------------------------------------------

  app.post("/contacts", { preHandler: write("pipeline:contacts") }, async (request, reply) => {
    const b = z
      .object({ stageId: uuid, ...contactFields, allowDuplicate: z.boolean() })
      .partial()
      .required({ stageId: true, studentName: true })
      .strict()
      .parse(request.body);
    const ws = await loadWorkspace(request);

    // The same family twice is the usual way a pipeline goes wrong. The email
    // is the match; "Add anyway" sends allowDuplicate.
    const emails = [...new Set([b.studentEmail, b.parentEmail].filter((e): e is string => !!e))];
    if (emails.length > 0 && !b.allowDuplicate) {
      const existing = await findContactByEmail(request, ws, emails);
      if (existing) {
        throw new HttpError(
          409,
          `${String(existing.student_name) || "A contact"} is already in your pipeline with that email`,
          "duplicate_contact"
        );
      }
    }

    const row = contactPatchToRow(b);
    // A source can only be saved once the history migration is in.
    if (!(await pipelineExtrasReady(request))) delete row.source;

    const { data, error } = await request.db
      .from("pipeline_contacts")
      .insert({
        ...row,
        info: b.info ?? {},
        firm_id: ws.firmId,
        counselor_id: request.auth.userId,
        stage_id: b.stageId,
        position: await nextPosition(request, b.stageId),
      })
      .select(await contactColumns(request))
      .single();
    if (error) throw crmError(error);
    return reply.code(201).send(await serializeOne(request, ws, data as unknown as Row));
  });

  /**
   * Inline edits (autosaved), and a move to another stage (the card goes to
   * the bottom of that column and its days in stage restart). `info` merges
   * key by key; an empty string clears a key.
   */
  app.patch("/contacts/:id", { preHandler: write("pipeline:contacts", 240) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({ stageId: uuid, ...contactFields, ...statusFields, allowDuplicate: z.boolean() })
      .partial()
      .strict()
      .parse(request.body);
    const ws = await loadWorkspace(request);
    const current = await loadContactRow(request, id);

    // A new address that another card already has: say so, once. Re-saving the
    // address a card already holds never asks.
    const newEmails = [
      b.studentEmail && b.studentEmail !== String(current.student_email ?? "").toLowerCase() ? b.studentEmail : "",
      b.parentEmail && b.parentEmail !== String(current.parent_email ?? "").toLowerCase() ? b.parentEmail : "",
    ].filter(Boolean);
    if (newEmails.length > 0 && !b.allowDuplicate) {
      const existing = await findContactByEmail(request, ws, [...new Set(newEmails)], id);
      if (existing) {
        throw new HttpError(
          409,
          `${String(existing.student_name) || "A contact"} is already in your pipeline with that email`,
          "duplicate_contact"
        );
      }
    }

    const update = contactPatchToRow(b);
    if (
      (b.source !== undefined || b.status !== undefined || b.lostReason !== undefined) &&
      !(await pipelineExtrasReady(request))
    ) {
      throw extrasUnavailable();
    }
    if (b.info) {
      const merged: Record<string, string> = { ...((current.info as Record<string, string> | null) ?? {}) };
      for (const [k, v] of Object.entries(b.info)) {
        if (v === undefined) continue;
        if (v === "") delete merged[k];
        else merged[k] = v;
      }
      update.info = merged;
    }
    if (b.stageId !== undefined && b.stageId !== current.stage_id) {
      update.stage_id = b.stageId;
      update.position = await nextPosition(request, b.stageId);
    }
    // The invitation was sent to the old address; a new one has to be re-sent.
    if (
      b.studentEmail !== undefined &&
      b.studentEmail !== String(current.student_email ?? "").toLowerCase() &&
      current.invitation_id &&
      !current.student_id &&
      current.counselor_id === request.auth.userId
    ) {
      update.invitation_id = null;
    }
    if (Object.keys(update).length === 0) return serializeOne(request, ws, current);

    const { data, error } = await request.db
      .from("pipeline_contacts")
      .update(update)
      .eq("id", id)
      .select(await contactColumns(request))
      .maybeSingle();
    if (error) throw crmError(error);
    if (!data) throw notFound("That contact isn't in your pipeline");
    return serializeOne(request, ws, data as unknown as Row);
  });

  app.delete("/contacts/:id", { preHandler: write("pipeline:contacts") }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await loadContactRow(request, id);
    const { error } = await request.db.from("pipeline_contacts").delete().eq("id", id);
    if (error) {
      if (error.code === "23503") {
        throw conflict("This family has invoices or payments on file, so the contact stays.");
      }
      throw crmError(error);
    }
    return reply.code(204).send();
  });

  /**
   * Invite the contact's student to Meridies. The same invitation every other
   * path sends (lib/invites.ts), linked back to the contact; when it is
   * accepted the contact learns which student it became.
   */
  app.post(
    "/contacts/:id/invite",
    { preHandler: [...counselor, limit("invites:create", 30, 3600)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const ws = await loadWorkspace(request);
      const c = await loadContactRow(request, id);
      if (c.student_id) throw conflict("This contact has already joined as a student");
      const email = String(c.student_email ?? "").trim().toLowerCase();
      if (!email) throw badRequest("Add the student's email to the card first");

      await enforceQuota(
        request.auth.userId,
        "invites",
        "day",
        100,
        "You've sent a lot of invitations today. Try again tomorrow."
      );

      const { row, emailSent } = await createInvitation(request, {
        email,
        fullName: String(c.student_name ?? "").trim() || null,
        gradYear: (c.grad_year as number | null) ?? null,
        timezone: request.profile.timezone,
        source: "single",
      });

      const { data, error } = await request.db
        .from("pipeline_contacts")
        .update({ invitation_id: row.id })
        .eq("id", id)
        .select(await contactColumns(request))
        .maybeSingle();
      if (error) throw crmError(error);
      if (!data) throw notFound("That contact isn't in your pipeline");
      return { contact: await serializeOne(request, ws, data as unknown as Row), emailSent };
    }
  );

  /**
   * Email a contact: the Follow-up and Contract proposal templates (or
   * anything else the counselor wrote) to the student, the parent, or both.
   * Addresses come from the card, never from the request.
   */
  app.post(
    "/contacts/:id/email",
    {
      preHandler: [
        ...counselor,
        limit("pipeline:email", 30, 3600, "You've emailed a lot of families this hour. Give it a moment."),
      ],
    },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = z
        .object({
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(20_000),
          to: z.array(z.enum(["student", "parent"])).min(1).max(2),
          templateId: uuid.optional(),
        })
        .strict()
        .parse(request.body);
      const c = await loadContactRow(request, id);

      const studentName = String(c.student_name ?? "").trim();
      const last = studentName.split(/\s+/).slice(-1)[0] ?? "";
      const targets = [...new Set(b.to)].map((who) =>
        who === "student"
          ? { who, email: String(c.student_email ?? ""), first: studentName.split(/\s+/)[0] ?? "" }
          : {
              who,
              email: String(c.parent_email ?? ""),
              first: String(c.parent_name ?? "").trim().split(/\s+/)[0] || (last ? `${last} family` : ""),
            }
      );
      const missing = targets.filter((t) => !t.email).map((t) => t.who);
      if (missing.length === targets.length) {
        throw badRequest(`Add the ${missing.join(" and ")}'s email to the card first`);
      }

      const results = [];
      for (const t of targets) {
        if (!t.email) {
          results.push({ to: t.who, email: null, sent: false, error: "No email address on the card" });
          continue;
        }
        const body = fillTemplate(b.body, { first: t.first, me: request.profile.full_name });
        const subject = fillTemplate(b.subject, { first: t.first, me: request.profile.full_name });
        const template = {
          heading: subject,
          paragraphs: paragraphs(body),
          footnote: request.profile.full_name
            ? `Sent by ${request.profile.full_name} through Meridies.`
            : "Sent through Meridies.",
        };
        const sent = await sendEmail({
          to: t.email,
          subject,
          html: brandedEmail(template),
          text: brandedText(template),
          template: "pipeline-email",
          recipient_kind: t.who === "parent" ? "guardian" : "student",
          logger: request.log,
        });
        results.push({ to: t.who, email: t.email, sent: sent.sent, error: sent.sent ? null : "Not delivered" });
      }
      const delivered = results.filter((r) => r.sent);
      // The timeline records what went out. The email already left, so a
      // failure to log it is reported, never raised.
      if (delivered.length > 0 && (await pipelineExtrasReady(request))) {
        const { error: logError } = await request.db.from("pipeline_activities").insert({
          contact_id: id,
          kind: "email",
          body: `Emailed the ${delivered.map((r) => r.to).join(" and ")}: ${b.subject}`.slice(0, 4000),
        });
        if (logError) request.log.warn({ err: logError }, "pipeline: could not log the email to the timeline");
      }
      return { results, sentCount: delivered.length };
    }
  );

  // ---- Payment Tracker -------------------------------------------------------

  /**
   * Every family the caller may bill, with derived balances, plus the
   * workspace's contacts that have no package yet (for "set up a package").
   */
  app.get("/payments", { preHandler: read("pipeline:payments") }, async (request) => {
    const ws = await loadWorkspace(request);
    let cq = request.db.from("pipeline_contacts").select("id, student_name, owner_id");
    cq = ws.firmId ? cq.eq("firm_id", ws.firmId) : cq.is("firm_id", null).eq("counselor_id", request.auth.userId);
    const contacts = await cq.limit(2000);
    if (contacts.error) throw crmError(contacts.error);
    const ids = ((contacts.data ?? []) as Row[]).map((r) => String(r.id));
    if (ids.length === 0) {
      return { today: todayIn(request.profile.timezone), accounts: [], totals: totals([]), unbilled: [], canBillAll: ws.isAdmin };
    }

    const credits = await paymentCreditsReady(request);
    const [pkgs, invoices, payments, refunds] = await Promise.all([
      request.db.from("pipeline_packages").select("*").in("contact_id", ids).limit(2000),
      request.db.from("pipeline_invoices").select("*").in("contact_id", ids).limit(10000),
      request.db.from("pipeline_payments").select("*").in("contact_id", ids).limit(10000),
      credits
        ? request.db.from("pipeline_credit_refunds").select("*").in("contact_id", ids).limit(10000)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (pkgs.error) throw crmError(pkgs.error);
    if (invoices.error) throw crmError(invoices.error);
    if (payments.error) throw crmError(payments.error);
    if (refunds.error) throw crmError(refunds.error);

    const today = todayIn(request.profile.timezone);
    const group = (rows: Row[]) => {
      const m = new Map<string, Row[]>();
      for (const r of rows) {
        const k = String(r.contact_id);
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      return m;
    };
    const inv = group((invoices.data ?? []) as Row[]);
    const pay = group((payments.data ?? []) as Row[]);
    const ref = group((refunds.data ?? []) as Row[]);
    const accounts = ((pkgs.data ?? []) as Row[]).map((p) =>
      deriveAccount(p, inv.get(String(p.contact_id)) ?? [], pay.get(String(p.contact_id)) ?? [], today, ref.get(String(p.contact_id)) ?? [])
    );
    const billed = new Set(accounts.map((a) => a.contactId));
    const unbilled = ((contacts.data ?? []) as Row[])
      .filter((c) => !billed.has(String(c.id)) && (ws.isAdmin || c.owner_id === request.auth.userId))
      .map((c) => ({ contactId: String(c.id), studentName: String(c.student_name ?? "") }));

    return { today, accounts, totals: totals(accounts), unbilled, canBillAll: ws.isAdmin };
  });

  /** Set up (or change) a family's package. */
  app.put("/contacts/:id/package", { preHandler: write("pipeline:billing", 60) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({
        packageName: z.string().trim().min(1).max(200),
        totalCents: z.number().int().min(0).max(100_000_000),
        installments: z.number().int().min(1).max(60),
      })
      .strict()
      .parse(request.body);
    await loadContactRow(request, id);

    const existing = await request.db.from("pipeline_packages").select("contact_id").eq("contact_id", id).maybeSingle();
    if (existing.error) throw crmError(existing.error);
    const row = { package_name: b.packageName, total_cents: b.totalCents, installments: b.installments };
    const { error } = existing.data
      ? await request.db.from("pipeline_packages").update(row).eq("contact_id", id)
      : await request.db.from("pipeline_packages").insert({ ...row, contact_id: id, created_by: request.auth.userId });
    if (error) {
      if (error.code === "42501") throw forbidden("Only a firm admin or this family's owner can bill them");
      throw crmError(error);
    }
    const account = await loadAccount(request, id);
    if (!account) throw forbidden("Only a firm admin or this family's owner can bill them");
    return account;
  });

  const invoiceBody = z.object({
    label: z.string().trim().min(1).max(120),
    amountCents: z.number().int().min(1).max(100_000_000),
    dueOn: isoDate,
  });

  /**
   * What "Send to parent" would send, without sending it or numbering it: the
   * recipient, subject and text, and the amount, credit applied and amount due.
   * Refused the same way the send is (409 nothing_to_invoice / over_billable).
   */
  app.post(
    "/contacts/:id/invoices/preview",
    { preHandler: [...counselor, limit("pipeline:invoice-preview", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const b = invoiceBody.strict().parse(request.body);
      const contact = await loadContactRow(request, id);
      const account = await requireAccount(request, id);
      if (b.dueOn < todayIn(request.profile.timezone)) throw badRequest("The due date has already passed");
      const draft = draftInvoice(account, await paymentCreditsReady(request), b);
      const mail = invoiceEmail(contact, draft, null, request.profile.full_name ?? null);
      return {
        to: mail.to || null,
        subject: mail.subject,
        text: mail.text,
        grossCents: draft.grossCents,
        creditAppliedCents: draft.creditAppliedCents,
        alreadyPaidCents: draft.alreadyPaidCents,
        amountDueCents: draft.amountDueCents,
      };
    }
  );

  /**
   * Send an invoice. With `send`, it is emailed to the parent (or the student
   * when no parent address is on the card). There is no payment provider, so
   * the email states the amount and due date and carries no pay link.
   */
  app.post(
    "/contacts/:id/invoices",
    { preHandler: [...counselor, limit("pipeline:invoices", 30, 3600)] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const b = invoiceBody.extend({ send: z.boolean().default(true) }).strict().parse(request.body);
      const contact = await loadContactRow(request, id);
      const account = await requireAccount(request, id);
      const today = todayIn(request.profile.timezone);
      if (b.dueOn < today) throw badRequest("The due date has already passed");
      const credits = await paymentCreditsReady(request);
      const draft = draftInvoice(account, credits, b);

      const { data, error } = await request.db
        .from("pipeline_invoices")
        .insert({
          contact_id: id,
          label: b.label,
          amount_cents: draft.grossCents,
          ...(credits && draft.creditAppliedCents > 0 ? { credit_applied_cents: draft.creditAppliedCents } : {}),
          issued_on: today,
          due_on: b.dueOn,
          created_by: request.auth.userId,
        })
        .select("*")
        .single();
      if (isCreditGuard(error)) throw new HttpError(409, "The family's credit changed. Open the invoice again to see what's due.", "credit_changed");
      if (error) throw crmError(error);
      const invoice = data as Row;

      let emailSent = false;
      const mail = invoiceEmail(contact, draft, String(invoice.number), request.profile.full_name ?? null);
      const to = mail.to;
      if (b.send && to) {
        const sent = await sendEmail({
          to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          template: "pipeline-invoice",
          recipient_kind: mail.recipientKind,
          logger: request.log,
        });
        emailSent = sent.sent;
        await request.db
          .from("pipeline_invoices")
          .update({
            sent_to: to,
            sent_at: sent.sent ? new Date().toISOString() : null,
            message_delivery_id: sent.deliveryId,
          })
          .eq("id", String(invoice.id));
      }

      return reply.code(201).send({
        account: await requireAccount(request, id),
        invoiceNumber: String(invoice.number),
        sentTo: b.send && to ? to : null,
        emailSent,
      });
    }
  );

  /** Void an invoice sent in error. It stays on the record and stops counting. */
  app.post("/invoices/:id/void", { preHandler: write("pipeline:billing", 60) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { data, error } = await request.db
      .from("pipeline_invoices")
      .update({ voided_at: new Date().toISOString() })
      .eq("id", id)
      .is("voided_at", null)
      .select("contact_id")
      .maybeSingle();
    if (error) throw crmError(error);
    if (!data) throw notFound("No open invoice of yours matches that");
    return requireAccount(request, String((data as Row).contact_id));
  });

  app.post("/contacts/:id/payments", { preHandler: write("pipeline:billing", 60) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({
        amountCents: z.number().int().min(1).max(100_000_000),
        receivedOn: isoDate,
        method: z.enum(PAYMENT_METHODS as [string, ...string[]]),
        note: z.string().trim().max(300).optional(),
        // The counselor's answer to the overpayment warning: hold the extra as credit.
        overpayment: z.literal("credit").optional(),
      })
      .strict()
      .parse(request.body);
    const account = await requireAccount(request, id);
    if (b.receivedOn > todayIn(request.profile.timezone)) throw badRequest("That date is in the future");

    const { overpaymentCents } = planPayment(account, b.amountCents);
    if (overpaymentCents > 0 && b.overpayment !== "credit") {
      return reply.code(409).send({
        error: `That's ${formatUsd(overpaymentCents)} more than the ${formatUsd(account.remainingCents)} left on this package.`,
        code: "overpayment",
        remainingCents: account.remainingCents,
        overpaymentCents,
      });
    }
    const credits = await paymentCreditsReady(request);
    if (overpaymentCents > 0 && !credits) throw creditsUnavailable();

    const { error } = await request.db.from("pipeline_payments").insert({
      contact_id: id,
      amount_cents: b.amountCents,
      ...(overpaymentCents > 0 ? { credit_cents: overpaymentCents } : {}),
      received_on: b.receivedOn,
      method: b.method,
      note: b.note || null,
      created_by: request.auth.userId,
    });
    if (error) throw crmError(error);
    return reply.code(201).send(await requireAccount(request, id));
  });

  /**
   * "Mark refunded": the held credit went back to the family. Records all of
   * it; nothing is ever refunded automatically.
   */
  app.post("/contacts/:id/credit/refund", { preHandler: write("pipeline:billing", 60) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = z
      .object({ refundedOn: isoDate, note: z.string().trim().max(300).optional() })
      .strict()
      .parse(request.body);
    const account = await requireAccount(request, id);
    if (!(await paymentCreditsReady(request))) throw creditsUnavailable();
    if (b.refundedOn > todayIn(request.profile.timezone)) throw badRequest("That date is in the future");
    if (account.creditCents <= 0) throw new HttpError(409, "This family has no credit to refund", "no_credit");

    const { error } = await request.db.from("pipeline_credit_refunds").insert({
      contact_id: id,
      amount_cents: account.creditCents,
      refunded_on: b.refundedOn,
      note: b.note || null,
      created_by: request.auth.userId,
    });
    if (isCreditGuard(error)) throw new HttpError(409, "The family's credit changed. Check it and try again.", "credit_changed");
    if (error) {
      if (error.code === "42501") throw forbidden("Only a firm admin or this family's owner can bill them");
      throw crmError(error);
    }
    return reply.code(201).send(await requireAccount(request, id));
  });

  /** Remove a payment recorded by mistake. */
  app.delete("/payments/:id", { preHandler: write("pipeline:billing", 60) }, async (request) => {
    const { id } = idParam.parse(request.params);
    // A payment whose credit was applied to an invoice or refunded can't go
    // first: that would leave the family owing a credit they never had.
    if (await paymentCreditsReady(request)) {
      const held = await request.db.from("pipeline_payments").select("contact_id, credit_cents").eq("id", id).maybeSingle();
      if (held.error) throw crmError(held.error);
      const row = held.data as Row | null;
      if (row && Number(row.credit_cents ?? 0) > 0) {
        const account = await loadAccount(request, String(row.contact_id));
        if (account && account.creditCents < Number(row.credit_cents)) {
          throw new HttpError(409, "Part of this payment's credit is already on an invoice or refunded. Void that invoice first.", "credit_in_use");
        }
      }
    }
    const { data, error } = await request.db
      .from("pipeline_payments")
      .delete()
      .eq("id", id)
      .select("contact_id")
      .maybeSingle();
    if (error) throw crmError(error);
    if (!data) throw notFound("No payment of yours matches that");
    return requireAccount(request, String((data as Row).contact_id));
  });
}
