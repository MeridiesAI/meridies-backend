/**
 * Caseload transfer (spec docs/superpowers/specs/2026-10-15-caseload-transfer-design.md).
 *
 * A firm owner/admin moves a consultant's students, and the student's whole
 * record, to other approved consultants in the firm. The database decides and
 * does it (`caseload_transfer_preview`, `transfer_caseload`, both SECURITY
 * DEFINER, migrations 20261023030001-3) on the admin's own client, so this
 * module only shapes requests and answers, and sends the emails.
 *
 * The one elevated read: after a transfer commits, the addresses of exactly
 * the people the function returned (the from consultant, the receivers, the
 * moved students) are read on the service client to mail them. The SQL never
 * returns an address, and the route never echoes one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { crmError } from "./crm.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { HttpError } from "./errors.js";
import { serviceClient } from "./supabase.js";

type Row = Record<string, unknown>;
type PgError = { code?: string; message?: string; hint?: string; details?: string } | null;

export const MAX_STUDENTS_PER_TRANSFER = 500;
export const TRANSFER_MODES = ["one_person", "per_student"] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const common = {
  /** Email each moved student (never archived students or alumni). */
  notifyStudents: z.boolean().default(true),
  /** Transfer and remove: the removal runs in the transfer's own transaction. */
  removeAfter: z.boolean().default(false),
  /** Move invitations, imports, templates and the pipeline too (whole caseload only). */
  includePracticeItems: z.boolean().default(false),
};

export const transferBody = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("one_person"),
        toId: uuid,
        practiceToId: uuid.optional(),
        ...common,
      })
      .strict(),
    z
      .object({
        mode: z.literal("per_student"),
        assignments: z
          .array(z.object({ studentId: uuid, toId: uuid }).strict())
          .min(1, "Assign at least one student")
          .max(MAX_STUDENTS_PER_TRANSFER, `Transfer at most ${MAX_STUDENTS_PER_TRANSFER} students at a time`),
        practiceToId: uuid.optional(),
        ...common,
      })
      .strict(),
  ])
  .superRefine((b, ctx) => {
    if (b.mode !== "per_student") return;
    const seen = new Set<string>();
    for (const a of b.assignments) {
      if (seen.has(a.studentId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A student is assigned twice", path: ["assignments"] });
        return;
      }
      seen.add(a.studentId);
    }
  });
export type TransferBody = z.infer<typeof transferBody>;

export const policyBody = z
  .object({
    mode: z.enum(TRANSFER_MODES).optional(),
    defaultReceiverId: uuid.nullable().optional(),
  })
  .strict();
export type PolicyBody = z.infer<typeof policyBody>;

/** The RPC arguments for a body. Practice items ride along with removeAfter. */
export function transferArgs(fromId: string, b: TransferBody): Record<string, unknown> {
  return {
    p_from: fromId,
    p_all_to: b.mode === "one_person" ? b.toId : null,
    p_assignments: b.mode === "per_student" ? b.assignments : null,
    p_practice_to: b.practiceToId ?? null,
    p_include_practice: b.includePracticeItems || b.removeAfter,
    p_remove_after: b.removeAfter,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * PostgREST's and Postgres's ways of saying "that function, table or column
 * isn't there" (PGRST200: an embedded table the schema cache doesn't know).
 */
const NOT_APPLIED = new Set(["PGRST200", "PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"]);

export const UNAVAILABLE_MESSAGE = "Caseload transfer isn't switched on yet";

export function isNotApplied(error: PgError): boolean {
  return !!error?.code && NOT_APPLIED.has(error.code);
}

/** 503 caseload_transfer_unavailable before the migrations are applied, else null. */
export function transferUnavailable(error: PgError): HttpError | null {
  return isNotApplied(error) ? new HttpError(503, UNAVAILABLE_MESSAGE, "caseload_transfer_unavailable") : null;
}

/** A transfer function's error, for the client. Our messages pass through (crmError). */
export function transferError(error: PgError): HttpError {
  return transferUnavailable(error) ?? crmError(error);
}

// ---------------------------------------------------------------------------
// Preview and transfer
// ---------------------------------------------------------------------------

export type CaseloadTransferPreview = {
  from: { id: string; name: string; approved: boolean; isOwner: boolean; isYou: boolean };
  students: {
    id: string;
    name: string;
    gradYear: string | null;
    archived: boolean;
    alumni: boolean;
    onboarding: boolean;
    upcomingMeetings: number;
  }[];
  receivers: { id: string; name: string; seatRole: string; studentCount: number; isYou: boolean }[];
  counts: Record<string, number>;
  attention: Record<string, number>;
  practiceItems: Record<string, number | boolean>;
  policy: { mode: TransferMode; defaultReceiverId: string | null };
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const rec = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

function numbers(v: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(rec(v)).map(([k, x]) => [k, num(x)]));
}

/** The preview DTO: every field named, so nothing the SQL adds later leaks through. */
export function toPreview(raw: unknown): CaseloadTransferPreview {
  const r = rec(raw);
  const from = rec(r.from);
  const policy = rec(r.policy);
  return {
    from: {
      id: str(from.id),
      name: str(from.name),
      approved: from.approved === true,
      isOwner: from.isOwner === true,
      isYou: from.isYou === true,
    },
    students: arr(r.students).map((s) => ({
      id: str(s.id),
      name: str(s.name),
      gradYear: s.gradYear === null || s.gradYear === undefined ? null : str(s.gradYear),
      archived: s.archived === true,
      alumni: s.alumni === true,
      onboarding: s.onboarding === true,
      upcomingMeetings: num(s.upcomingMeetings),
    })),
    receivers: arr(r.receivers).map((p) => ({
      id: str(p.id),
      name: str(p.name),
      seatRole: str(p.seatRole) || "counselor",
      studentCount: num(p.studentCount),
      isYou: p.isYou === true,
    })),
    counts: numbers(r.counts),
    attention: numbers(r.attention),
    practiceItems: Object.fromEntries(
      Object.entries(rec(r.practiceItems)).map(([k, x]) => [k, typeof x === "boolean" ? x : num(x)])
    ),
    policy: {
      mode: policy.mode === "one_person" ? "one_person" : "per_student",
      defaultReceiverId: typeof policy.defaultReceiverId === "string" ? policy.defaultReceiverId : null,
    },
  };
}

export async function loadPreview(request: FastifyRequest, fromId: string): Promise<CaseloadTransferPreview> {
  const { data, error } = await request.db.rpc("caseload_transfer_preview", { p_from: fromId });
  if (error) throw transferError(error);
  return toPreview(data);
}

export type TransferResult = {
  transferId: string;
  mode: TransferMode;
  studentCount: number;
  from: { id: string; name: string };
  firmId: string;
  practiceTo: string | null;
  practiceItemsMoved: boolean;
  removed: boolean;
  students: { id: string; name: string; toId: string; archived: boolean; alumni: boolean }[];
  receivers: { id: string; name: string; count: number }[];
  moved: Record<string, number>;
  practice: Record<string, number>;
  attention: {
    calendarMeetings: { id: string; title: string; startsAt: string; toId: string }[];
    groupMeetings: { id: string; title: string; startsAt: string }[];
    supplementDocs: { id: string; collegeName: string; title: string; studentId: string; toId: string }[];
    driveLinkedDocuments: number;
    cancelledMessages: number;
    cancelledAlerts: number;
  };
};

export function toTransferResult(raw: unknown): TransferResult {
  const r = rec(raw);
  const from = rec(r.from);
  const a = rec(r.attention);
  return {
    transferId: str(r.transferId),
    mode: r.mode === "one_person" ? "one_person" : "per_student",
    studentCount: num(r.studentCount),
    from: { id: str(from.id), name: str(from.name) },
    firmId: str(r.firmId),
    practiceTo: typeof r.practiceTo === "string" ? r.practiceTo : null,
    practiceItemsMoved: r.practiceItemsMoved === true,
    removed: r.removed === true,
    students: arr(r.students).map((s) => ({
      id: str(s.id),
      name: str(s.name),
      toId: str(s.toId),
      archived: s.archived === true,
      alumni: s.alumni === true,
    })),
    receivers: arr(r.receivers).map((p) => ({ id: str(p.id), name: str(p.name), count: num(p.count) })),
    moved: numbers(r.moved),
    practice: numbers(r.practice),
    attention: {
      calendarMeetings: arr(a.calendarMeetings).map((m) => ({
        id: str(m.id),
        title: str(m.title),
        startsAt: str(m.startsAt),
        toId: str(m.toId),
      })),
      groupMeetings: arr(a.groupMeetings).map((m) => ({ id: str(m.id), title: str(m.title), startsAt: str(m.startsAt) })),
      supplementDocs: arr(a.supplementDocs).map((d) => ({
        id: str(d.id),
        collegeName: str(d.collegeName),
        title: str(d.title),
        studentId: str(d.studentId),
        toId: str(d.toId),
      })),
      driveLinkedDocuments: num(a.driveLinkedDocuments),
      cancelledMessages: num(a.cancelledMessages),
      cancelledAlerts: num(a.cancelledAlerts),
    },
  };
}

export async function runTransfer(request: FastifyRequest, fromId: string, b: TransferBody): Promise<TransferResult> {
  const { data, error } = await request.db.rpc("transfer_caseload", transferArgs(fromId, b));
  if (error) throw transferError(error);
  return toTransferResult(data);
}

/**
 * What the route answers. Built field by field from the typed result, so no
 * address can ride along even if one were added to the SQL by mistake.
 */
export function toTransferResponse(r: TransferResult, emails: { planned: number }) {
  return {
    transferId: r.transferId,
    mode: r.mode,
    studentCount: r.studentCount,
    from: { id: r.from.id, name: r.from.name },
    practiceTo: r.practiceTo,
    practiceItemsMoved: r.practiceItemsMoved,
    removed: r.removed,
    receivers: r.receivers.map((p) => ({ id: p.id, name: p.name, count: p.count })),
    students: r.students.map((s) => ({ id: s.id, name: s.name, toId: s.toId })),
    moved: r.moved,
    practice: r.practice,
    attention: r.attention,
    emailsPlanned: emails.planned,
  };
}

// ---------------------------------------------------------------------------
// Emails (after the commit, best effort)
// ---------------------------------------------------------------------------

/** A name as one line of plain text: no control characters, bounded. Escaped by brandedEmail. */
export function cleanName(name: string | null | undefined, fallback: string): string {
  const s = (name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return s || fallback;
}

function when(iso: string, timezone: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return d.toLocaleString("en-US", { ...opts, timeZone: timezone?.trim() || "America/New_York" });
  } catch {
    return d.toLocaleString("en-US", { ...opts, timeZone: "America/New_York" });
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type ReceiverEmailInput = {
  receiverName: string;
  fromName: string;
  adminName: string;
  firmName: string;
  studentNames: string[];
  calendarMeetings: { title: string; startsAt: string }[];
  supplementDocs: number;
  driveLinkedDocuments: number;
  cancelledMessages: number;
  timezone: string | null;
  url: string;
};

export function receiverEmail(t: ReceiverEmailInput) {
  const n = t.studentNames.length;
  const shown = t.studentNames.slice(0, 50);
  const bullets = n > 50 ? [...shown, `and ${n - 50} more`] : shown;
  const paragraphs = [
    `${t.adminName} moved ${plural(n, "student", "students")} from ${t.fromName} to you at ${t.firmName}. Their records came with them: meetings, notes, messages, documents and open tasks.`,
  ];
  if (t.calendarMeetings.length) {
    const list = t.calendarMeetings
      .slice(0, 10)
      .map((m) => `${cleanName(m.title, "Meeting")} (${when(m.startsAt, t.timezone)})`)
      .join("; ");
    paragraphs.push(
      `These upcoming meetings were booked on ${t.fromName}'s calendar. Rebook them from your own calendar so the invitation comes from you: ${list}${t.calendarMeetings.length > 10 ? `; and ${t.calendarMeetings.length - 10} more` : ""}.`
    );
  }
  if (t.supplementDocs) {
    paragraphs.push(
      `${plural(t.supplementDocs, "supplement Doc is", "supplement Docs are")} still in ${t.fromName}'s Google Drive. Ask ${t.fromName} to share or transfer them before their account is closed.`
    );
  }
  if (t.driveLinkedDocuments) {
    paragraphs.push(
      `${plural(t.driveLinkedDocuments, "document was", "documents were")} linked to ${t.fromName}'s Google Drive or OneDrive. The copy in Meridies came over; the live link did not.`
    );
  }
  if (t.cancelledMessages) {
    paragraphs.push(
      `${plural(t.cancelledMessages, "scheduled message was", "scheduled messages were")} cancelled because the students moved before they went out. You can write them again from each student's Communication page.`
    );
  }
  const subject = `${plural(n, "student", "students")} from ${t.fromName} ${n === 1 ? "is" : "are"} now yours`;
  return {
    subject,
    template: {
      heading: subject,
      paragraphs,
      bullets,
      cta: { label: "Open Overview", url: t.url },
      footnote: "You're receiving this because a firm owner or admin transferred students to you in Meridies.",
    },
  };
}

export function studentEmail(t: { receiverName: string; firmName: string; url: string }) {
  const subject = `${t.receiverName} is now your counselor`;
  return {
    subject,
    template: {
      heading: subject,
      paragraphs: [
        `${t.receiverName} is now your counselor at ${t.firmName}.`,
        "Everything you have in Meridies stays where it is: your tasks, documents, college list and messages.",
      ],
      cta: { label: "Open Meridies", url: t.url },
      footnote: "You're receiving this because your counseling practice moved you to a new counselor.",
    },
  };
}

export function fromEmail(t: {
  fromName: string;
  adminName: string;
  firmName: string;
  receivers: { name: string; count: number }[];
  groupMeetings: { title: string; startsAt: string }[];
  supplementDocs: number;
  removed: boolean;
  timezone: string | null;
}) {
  const total = t.receivers.reduce((s, r) => s + r.count, 0);
  const paragraphs = [
    `${t.adminName} moved ${plural(total, "of your students", "of your students")} at ${t.firmName} to other consultants.`,
  ];
  if (t.groupMeetings.length) {
    const list = t.groupMeetings
      .slice(0, 10)
      .map((m) => `${cleanName(m.title, "Meeting")} (${when(m.startsAt, t.timezone)})`)
      .join("; ");
    paragraphs.push(`These group meetings stay on your calendar because their students now have different counselors: ${list}.`);
  }
  if (t.supplementDocs) {
    paragraphs.push(
      `${plural(t.supplementDocs, "supplement Doc for these students is", "supplement Docs for these students are")} in your Google Drive. Please share or transfer them to the new counselor.`
    );
  }
  if (t.removed) paragraphs.push(`You are no longer a member of ${t.firmName}.`);
  const subject = "Your students were transferred";
  return {
    subject,
    template: {
      heading: subject,
      paragraphs,
      bullets: t.receivers.map((r) => `${plural(r.count, "student", "students")} to ${r.name}`),
      footnote: "You're receiving this because a firm owner or admin transferred your students in Meridies.",
    },
  };
}

type Contact = { id: string; email: string | null; name: string; timezone: string | null };

async function contacts(svc: SupabaseClient, ids: string[]): Promise<Map<string, Contact>> {
  const out = new Map<string, Contact>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await svc
      .from("profiles")
      .select("id, email, full_name, timezone")
      .in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`contacts read failed: ${error.code ?? ""}`);
    for (const r of (data ?? []) as Row[]) {
      out.set(String(r.id), {
        id: String(r.id),
        email: typeof r.email === "string" && r.email.includes("@") ? r.email : null,
        name: cleanName(r.full_name as string | null, "A consultant"),
        timezone: (r.timezone as string | null) ?? null,
      });
    }
  }
  return out;
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await run(item);
      }
    })
  );
}

/** Which students get "{receiver} is now your counselor": never archived students or alumni. */
export function studentsToEmail(r: TransferResult, notifyStudents: boolean) {
  return notifyStudents ? r.students.filter((s) => !s.archived && !s.alumni) : [];
}

export function plannedEmails(r: TransferResult, notifyStudents: boolean): number {
  return r.receivers.length + 1 + studentsToEmail(r, notifyStudents).length;
}

/**
 * Send the transfer's emails. Never throws and never fails the request: the
 * transfer has committed. Every send is a message_deliveries row.
 */
export async function notifyTransfer(
  log: FastifyBaseLogger,
  db: SupabaseClient,
  r: TransferResult,
  opts: { notifyStudents: boolean; adminId: string }
): Promise<{ sent: number; failed: number }> {
  const tally = { sent: 0, failed: 0 };
  const svc = serviceClient();
  if (!svc) {
    log.warn({ transferId: r.transferId }, "caseload transfer emails skipped: no service role key");
    return tally;
  }
  try {
    const { data: firm } = await db.from("firms").select("name").eq("id", r.firmId).maybeSingle();
    const firmName = cleanName((firm as Row | null)?.name as string | null, "your practice");
    const students = studentsToEmail(r, opts.notifyStudents);
    const people = await contacts(svc, [
      ...new Set([r.from.id, opts.adminId, ...r.receivers.map((p) => p.id), ...students.map((s) => s.id)]),
    ]);
    const nameOf = (id: string, fallback: string) => people.get(id)?.name ?? fallback;
    const fromName = nameOf(r.from.id, cleanName(r.from.name, "a colleague"));
    const adminName = nameOf(opts.adminId, "A firm admin");

    const send = async (
      to: Contact | undefined,
      m: { subject: string; template: Parameters<typeof brandedEmail>[0] },
      template: string,
      extra: { student_id?: string; recipient_kind: "student" | "counselor" }
    ) => {
      if (!to?.email) return;
      const result = await sendEmail({
        to: to.email,
        subject: m.subject,
        html: brandedEmail(m.template),
        text: brandedText(m.template),
        template,
        recipient_id: to.id,
        logger: log,
        ...extra,
      });
      if (result.sent) tally.sent++;
      else tally.failed++;
    };

    const base = env.APP_URL.replace(/\/+$/, "");
    for (const p of r.receivers) {
      const mine = r.students.filter((s) => s.toId === p.id);
      const receiver = people.get(p.id);
      await send(
        receiver,
        receiverEmail({
          receiverName: nameOf(p.id, cleanName(p.name, "there")),
          fromName,
          adminName,
          firmName,
          studentNames: mine.map((s) => cleanName(s.name, "A student")),
          calendarMeetings: r.attention.calendarMeetings.filter((m) => m.toId === p.id),
          supplementDocs: r.attention.supplementDocs.filter((d) => d.toId === p.id).length,
          driveLinkedDocuments: r.attention.driveLinkedDocuments,
          cancelledMessages: r.attention.cancelledMessages,
          timezone: receiver?.timezone ?? null,
          url: `${base}/dashboard/counselor`,
        }),
        "caseload-transfer-receiver",
        { recipient_kind: "counselor" }
      );
    }

    const from = people.get(r.from.id);
    await send(
      from,
      fromEmail({
        fromName,
        adminName,
        firmName,
        receivers: r.receivers.map((p) => ({ name: nameOf(p.id, cleanName(p.name, "a colleague")), count: p.count })),
        groupMeetings: r.attention.groupMeetings,
        supplementDocs: r.attention.supplementDocs.length,
        removed: r.removed,
        timezone: from?.timezone ?? null,
      }),
      "caseload-transfer-from",
      { recipient_kind: "counselor" }
    );

    await pool(students, 5, async (s) => {
      await send(
        people.get(s.id),
        studentEmail({
          receiverName: nameOf(s.toId, r.receivers.find((p) => p.id === s.toId)?.name ?? "Your new counselor"),
          firmName,
          url: `${base}/dashboard/student`,
        }),
        "caseload-transfer-student",
        { recipient_kind: "student", student_id: s.id }
      ).catch((err) => {
        tally.failed++;
        log.error({ err, transferId: r.transferId }, "caseload transfer student email failed");
      });
    });
  } catch (err) {
    log.error({ err, transferId: r.transferId }, "caseload transfer emails failed");
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Removing a member
// ---------------------------------------------------------------------------

export const ONE_ARG_TTL_MS = 5 * 60_000;
let oneArgUntil = 0;

/** For tests. */
export function resetRemoveMemberCache(): void {
  oneArgUntil = 0;
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: PgError }>;

/**
 * remove_firm_member, with the release flag. Before 20261023030003 is applied
 * the function has one argument: a call naming p_release_students is refused
 * (PGRST202), so retry once without it and remember that for five minutes per
 * process. Release is only meaningful on the new function, so a release call
 * against the old one still behaves as today (the old one never refused).
 */
export async function removeMember(
  rpc: Rpc,
  profileId: string,
  releaseStudents: boolean,
  now: number = Date.now()
): Promise<void> {
  let error: PgError;
  if (now < oneArgUntil) {
    ({ error } = await rpc("remove_firm_member", { p_profile: profileId }));
  } else {
    ({ error } = await rpc("remove_firm_member", { p_profile: profileId, p_release_students: releaseStudents }));
    if (error?.code === "PGRST202") {
      oneArgUntil = now + ONE_ARG_TTL_MS;
      ({ error } = await rpc("remove_firm_member", { p_profile: profileId }));
    }
  }
  if (error) throw removeError(error);
}

/** The refusal for an untransferred caseload carries a code the app branches on. */
export function removeError(error: PgError): HttpError {
  if (error?.hint === "caseload_not_transferred") {
    const message = error.message && error.message.length <= 200 ? error.message : "Transfer their students first";
    return new HttpError(409, message, "caseload_not_transferred");
  }
  return crmError(error);
}

// ---------------------------------------------------------------------------
// The firm's setting and the history
// ---------------------------------------------------------------------------

export type CaseloadPolicy = {
  firmId: string | null;
  mode: TransferMode;
  defaultReceiverId: string | null;
  canEdit: boolean;
};

export function toPolicy(row: Row | null, firmId: string | null, canEdit: boolean): CaseloadPolicy {
  return {
    firmId,
    mode: row?.caseload_transfer_mode === "one_person" ? "one_person" : "per_student",
    defaultReceiverId: typeof row?.caseload_default_receiver === "string" ? row.caseload_default_receiver : null,
    canEdit,
  };
}

export type TransferHistoryRow = {
  id: string;
  fromId: string | null;
  fromName: string | null;
  requestedByName: string | null;
  mode: TransferMode;
  studentCount: number;
  practiceItemsMoved: boolean;
  memberRemoved: boolean;
  createdAt: string;
  students: { id: string; name: string | null; toId: string | null; toName: string | null }[];
};

export async function listTransfers(db: SupabaseClient, firmId: string): Promise<TransferHistoryRow[]> {
  const { data, error } = await db
    .from("caseload_transfers")
    .select(
      "id, from_counselor_id, from_name, requested_by_name, mode, student_count, practice_items_moved, member_removed, created_at, caseload_transfer_students(student_id, student_name, to_counselor_id, to_name)"
    )
    .eq("firm_id", firmId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw transferError(error);
  return ((data ?? []) as Row[]).map((r) => ({
    id: str(r.id),
    fromId: (r.from_counselor_id as string | null) ?? null,
    fromName: (r.from_name as string | null) ?? null,
    requestedByName: (r.requested_by_name as string | null) ?? null,
    mode: r.mode === "one_person" ? "one_person" : "per_student",
    studentCount: num(r.student_count),
    practiceItemsMoved: r.practice_items_moved === true,
    memberRemoved: r.member_removed === true,
    createdAt: str(r.created_at),
    students: arr(r.caseload_transfer_students).map((s) => ({
      id: str(s.student_id),
      name: (s.student_name as string | null) ?? null,
      toId: (s.to_counselor_id as string | null) ?? null,
      toName: (s.to_name as string | null) ?? null,
    })),
  }));
}

/**
 * "Transferred from {name} on {date}" for the student page. Null when there is
 * none, when the caller may not see it, or when the tables aren't there yet
 * (read on every student page, so it never fails the page).
 */
export async function loadTransferredFrom(
  db: SupabaseClient,
  studentId: string,
  log?: FastifyBaseLogger
): Promise<{ name: string | null; at: string } | null> {
  const { data, error } = await db
    .from("caseload_transfer_students")
    .select("created_at, caseload_transfers(from_name)")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (!isNotApplied(error)) log?.warn({ code: error.code }, "transferredFrom read failed");
    return null;
  }
  if (!data) return null;
  const t = rec((data as Row).caseload_transfers);
  return { name: typeof t.from_name === "string" ? t.from_name : null, at: str((data as Row).created_at) };
}
