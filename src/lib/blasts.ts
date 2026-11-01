/**
 * Email blast: who a blast reaches, how it is sent, and the cron that sends the
 * scheduled ones (migration 20261030000001).
 *
 * `routes/blasts.ts` is the counselor's side (preview, send now, schedule,
 * queue). This file holds what the cron shares with it: resolving filters to
 * people, delivering, and the dispatcher.
 *
 * The dispatcher is the only thing that runs a scheduled blast. It claims the
 * row (`claimed_at`, reclaimed after ten minutes) before sending, gives Resend
 * a stable idempotency key per blast and recipient, and resolves who is
 * reached again at send time from the counselor's live roster: a stored row
 * says which filters and which ticked students, never who the people are.
 * A yearly blast writes each run as its own `email_blasts` row and moves its
 * own `scheduled_for` a year on.
 *
 * Until the migration is applied the routes answer 503
 * `blast_schedule_unavailable` for a scheduled blast, a blast sent now still
 * works (stored as a `selection`), and the cron answers `ran: false`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { approvedCounselorIds } from "./access.js";
import { fillTemplate, paragraphs } from "./crm.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { HttpError, badRequest, fromPostgrest } from "./errors.js";
import { zonedToUtc } from "./eventsHub.js";
import { consumeRateLimit } from "./limits.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

/** A blast is a broadcast, not a mail merge campaign: people reached, parents counted one by one. */
export const MAX_RECIPIENTS = 500;
/** Scheduled runs one counselor gets in 24 hours; over it the blast waits an hour. */
export const BLAST_DAILY_CAP = 10;
const CLAIM_MS = 10 * 60_000;
const RETRY_MS = 3_600_000;
const MAX_YEARS_AHEAD = 5;

// ---- The audience --------------------------------------------------------------

const list = (max: number, len: number) => z.array(z.string().trim().min(1).max(len)).max(max).default([]);

/** Class year, colleges applying to, application status; each narrows the one before. */
export const audienceInput = z
  .object({
    recipientType: z.enum(["students", "parents"]).default("students"),
    classYears: list(20, 10),
    colleges: list(50, 200),
    statuses: list(12, 40),
    /** The students left ticked inside the filters. Omitted: everyone the filters match. */
    studentIds: z.array(z.string().uuid()).max(MAX_RECIPIENTS).optional(),
  })
  .strict();

export type Audience = z.infer<typeof audienceInput>;
export type Filters = Pick<Audience, "classYears" | "colleges" | "statuses">;

export type Recipient = {
  studentId: string;
  /** Who the email is addressed to (the guardian's name for a parent). */
  fullName: string;
  email: string | null;
  skipReason: string | null;
  kind: "student" | "guardian";
};

export type MatchedStudent = { id: string; fullName: string; gradYear: string | null; reachable: boolean };

const norm = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** The counselor's live roster. `db` is their own client (RLS) or the service client; the filter makes the scope explicit. */
async function loadRoster(db: SupabaseClient, counselorId: string): Promise<Row[]> {
  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, email, grad_year")
    .eq("counselor_id", counselorId)
    .is("archived_at", null)
    .order("full_name");
  if (error) throw fromPostgrest(error);
  return (data ?? []) as Row[];
}

async function inChunks<T>(
  ids: string[],
  read: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { code?: string; message?: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await read(ids.slice(i, i + 200));
    if (error) throw fromPostgrest(error);
    out.push(...(data ?? []));
  }
  return out;
}

/**
 * The roster narrowed by the filters. Colleges and status are read from the
 * same list row, so "Brown" with "submitted" means submitted to Brown, not
 * submitted somewhere and listed Brown.
 */
async function applyFilters(db: SupabaseClient, roster: Row[], f: Filters): Promise<Row[]> {
  let rows = roster;
  if (f.classYears.length) {
    const years = new Set(f.classYears.map((y) => y.trim()));
    rows = rows.filter((r) => years.has(String(r.grad_year ?? "").trim()));
  }
  if ((f.colleges.length || f.statuses.length) && rows.length) {
    const colleges = new Set(f.colleges.map(norm));
    const statuses = new Set(f.statuses.map((s) => s.trim()));
    const lists = await inChunks<Row>(
      rows.map((r) => String(r.id)),
      (chunk) => db.from("student_colleges").select("student_id, name, status").in("student_id", chunk).limit(5000)
    );
    const matched = new Set(
      lists
        .filter((l) => (!colleges.size || colleges.has(norm(l.name))) && (!statuses.size || statuses.has(String(l.status ?? "").trim())))
        .map((l) => String(l.student_id))
    );
    rows = rows.filter((r) => matched.has(String(r.id)));
  }
  return rows;
}

/** "Class of 2027 · Applying to Brown · Status: submitted (14 students)", frozen onto the blast. */
function labelFor(a: Audience, students: number): string {
  const parts = [
    a.classYears.length ? `Class of ${a.classYears.join(", ")}` : "",
    a.colleges.length ? `Applying to ${a.colleges.join(", ")}` : "",
    a.statuses.length ? `Status: ${a.statuses.join(", ")}` : "",
  ].filter(Boolean);
  const base = (parts.join(" · ") || "Entire roster").slice(0, 150);
  const who = a.recipientType === "parents" ? "Parents · " : "";
  return `${who}${base} (${students} student${students === 1 ? "" : "s"})`;
}

/**
 * Resolve an audience to people, right now.
 *
 * `students` is everyone the filters match (what the popup lists to tick);
 * `recipients` is who the email goes to: the ticked students, or their
 * guardians with an address and alerts on, one email per address however many
 * siblings share it. A student nobody can reach stays in `recipients` as a
 * skipped row, so the blast records who was missed.
 */
export async function resolveAudience(
  db: SupabaseClient,
  counselorId: string,
  audience: Audience
): Promise<{ label: string; students: MatchedStudent[]; selected: number; recipients: Recipient[] }> {
  const roster = await loadRoster(db, counselorId);
  const onRoster = new Set(roster.map((r) => String(r.id)));
  // Silently dropping an id would send to fewer people than the counselor chose without saying so.
  if ((audience.studentIds ?? []).some((id) => !onRoster.has(id))) {
    throw badRequest("One of those students isn't on your roster");
  }

  const matches = await applyFilters(db, roster, audience);
  const ticked = audience.studentIds ? new Set(audience.studentIds) : null;
  const selected = matches.filter((r) => !ticked || ticked.has(String(r.id)));

  const parents = audience.recipientType === "parents";
  const guardians = new Map<string, Row[]>();
  if (parents) {
    const rows = await inChunks<Row>(
      matches.map((r) => String(r.id)),
      (chunk) =>
        db
          .from("guardians")
          .select("student_id, full_name, email, alerts_enabled, is_primary")
          .in("student_id", chunk)
          .order("is_primary", { ascending: false })
          .limit(5000)
    );
    for (const g of rows) {
      // Opted out, or no address: listed on the file, never written to.
      if (g.alerts_enabled === false || !String(g.email ?? "").trim()) continue;
      const key = String(g.student_id);
      guardians.set(key, [...(guardians.get(key) ?? []), g]);
    }
  }

  const students: MatchedStudent[] = matches.map((r) => ({
    id: String(r.id),
    fullName: String(r.full_name ?? ""),
    gradYear: String(r.grad_year ?? "").trim() || null,
    reachable: parents ? (guardians.get(String(r.id))?.length ?? 0) > 0 : Boolean(String(r.email ?? "").trim()),
  }));

  const recipients: Recipient[] = [];
  const seen = new Set<string>();
  for (const r of selected) {
    const id = String(r.id);
    const name = String(r.full_name ?? "");
    if (!parents) {
      const email = String(r.email ?? "").trim() || null;
      recipients.push({
        studentId: id,
        fullName: name,
        email,
        skipReason: email ? null : "No email address on file",
        kind: "student",
      });
      continue;
    }
    const mine = guardians.get(id) ?? [];
    if (mine.length === 0) {
      recipients.push({ studentId: id, fullName: name, email: null, skipReason: "No parent email on file (or alerts are off)", kind: "student" });
      continue;
    }
    for (const g of mine) {
      const email = String(g.email).trim();
      if (seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      recipients.push({ studentId: id, fullName: String(g.full_name ?? ""), email, skipReason: null, kind: "guardian" });
    }
  }

  return { label: labelFor(audience, selected.length), students, selected: selected.length, recipients };
}

// ---- Writing the email ---------------------------------------------------------------

/** One recipient's copy: {first} and {me} filled in, greeted by name unless the body already greets. */
function blastTemplate(input: { subject: string; body: string; counselorName: string | null; first: string }) {
  const me = input.counselorName ?? "";
  const subject = fillTemplate(input.subject, { first: input.first, me });
  const body = fillTemplate(input.body, { first: input.first, me });
  const greets = /\{first\}/.test(input.body) || /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening))\b/i.test(input.body);
  return {
    subject,
    heading: subject,
    paragraphs: greets ? paragraphs(body) : [input.first ? `Hi ${input.first},` : "Hi,", ...paragraphs(body)],
    footnote: input.counselorName ? `Sent by ${input.counselorName} through Meridies.` : "Sent through Meridies.",
  };
}

export type DeliverArgs = {
  /** Writes the blast's own rows: the counselor's client (RLS) or the service client. */
  db: SupabaseClient;
  blastId: string;
  subject: string;
  body: string;
  counselorName: string | null;
  replyTo?: string;
  recipients: Recipient[];
  logger: Log;
  /** Resend's idempotency key is `<prefix>:<address>`: stable across a retry, so nobody is emailed twice. */
  keyPrefix: string;
  /** A retry after a crash: drop what the first attempt wrote, Resend's idempotency key stops a second send. */
  reset?: boolean;
};

/**
 * Write the recipients BEFORE anything goes out, so a crash halfway leaves a
 * record of what was attempted. Each send then updates its own row and the
 * totals are reconciled at the end.
 */
export async function deliverBlast(a: DeliverArgs) {
  if (a.reset) await a.db.from("email_blast_recipients").delete().eq("blast_id", a.blastId);

  const { data: rows, error } = await a.db
    .from("email_blast_recipients")
    .insert(
      a.recipients.map((r) => ({
        blast_id: a.blastId,
        student_id: r.studentId,
        full_name: r.fullName,
        to_email: r.email,
        channel: "email",
        status: r.email ? "queued" : "skipped",
        skip_reason: r.skipReason,
      }))
    )
    .select("id, student_id, full_name, to_email, status");
  if (error) throw fromPostgrest(error);

  let delivered = 0;
  let failed = 0;
  const kinds = new Map(a.recipients.map((r) => [`${r.studentId}:${r.email ?? ""}`, r.kind]));

  for (const row of rows ?? []) {
    if (row.status === "skipped" || !row.to_email) continue;
    const kind = kinds.get(`${row.student_id}:${row.to_email}`) ?? "student";
    const template = blastTemplate({
      subject: a.subject,
      body: a.body,
      counselorName: a.counselorName,
      first: firstName(String(row.full_name ?? "")),
    });

    const result = await sendEmail({
      to: row.to_email as string,
      subject: template.subject,
      html: brandedEmail(template),
      text: brandedText(template),
      template: "blast",
      student_id: (row.student_id as string | null) ?? null,
      recipient_id: kind === "student" ? ((row.student_id as string | null) ?? null) : null,
      recipient_kind: kind,
      blast_id: a.blastId,
      replyTo: a.replyTo,
      idempotencyKey: `${a.keyPrefix}:${String(row.to_email).toLowerCase()}`,
      logger: a.logger as never,
    });

    if (result.sent) delivered += 1;
    else failed += 1;

    await a.db
      .from("email_blast_recipients")
      .update({
        status: result.sent ? "sent" : "failed",
        message_delivery_id: result.deliveryId,
        error: result.error,
        sent_at: result.sent ? new Date().toISOString() : null,
      })
      .eq("id", row.id as string);
  }

  const status = failed === 0 ? "sent" : delivered === 0 ? "failed" : "partial";
  return { delivered, failed, skipped: a.recipients.length - delivered - failed, status };
}

// ---- Scheduling ------------------------------------------------------------------------

const MISSING_RECHECK_MS = 30_000;
let ready = false;
let missingAt = 0;

export function scheduleUnavailable(): HttpError {
  return new HttpError(503, "Scheduled blasts aren't switched on yet", "blast_schedule_unavailable");
}

/** A zero-row read of every column the migration adds. */
export async function scheduleReady(db: SupabaseClient): Promise<boolean> {
  if (ready) return true;
  if (Date.now() - missingAt < MISSING_RECHECK_MS) return false;
  const { error } = await db
    .from("email_blasts")
    .select("recipient_type, filters, student_ids, scheduled_for, repeat_yearly, claimed_at")
    .limit(0);
  if (!error) {
    ready = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    missingAt = Date.now();
    return false;
  }
  throw fromPostgrest(error);
}

/** A scheduled time must be ahead of now and within a few years. */
export function validScheduleTime(iso: string, now = Date.now()): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > now + 60_000 && t < now + MAX_YEARS_AHEAD * 366 * 86_400_000;
}

/**
 * The same local date and time, one year on, in the counselor's time zone
 * (Feb 29 becomes Feb 28 in a common year).
 */
export function nextYear(iso: string, timezone: string | null | undefined): string {
  let zone = timezone?.trim() || "America/New_York";
  const at = new Date(iso);
  const read = (tz: string) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value])
    ) as Record<string, string>;
  let p: Record<string, string>;
  try {
    p = read(zone);
  } catch {
    zone = "UTC";
    p = read(zone);
  }
  const year = Number(p.year) + 1;
  const month = Number(p.month);
  let day = Number(p.day);
  if (new Date(Date.UTC(year, month - 1, day)).getUTCMonth() !== month - 1) day = 28;
  const pad = (n: number) => String(n).padStart(2, "0");
  return zonedToUtc(`${year}-${pad(month)}-${pad(day)}`, `${p.hour}:${p.minute}`, zone);
}

// ---- Dispatch ----------------------------------------------------------------------------

export type BlastTally = { sent: number; held: number; failed: number; skipped: number };

const filtersOf = (r: Row): Filters => {
  const f = (r.filters ?? {}) as Partial<Filters>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return { classYears: strings(f.classYears), colleges: strings(f.colleges), statuses: strings(f.statuses) };
};

/**
 * Send every scheduled blast whose time has come. Service-role client: who it
 * reaches is read from the counselor's live roster at this moment, and the
 * counselor must still be approved.
 */
export async function dispatchDueBlasts(svc: SupabaseClient, logger: Log, max = 20): Promise<BlastTally> {
  const tally: BlastTally = { sent: 0, held: 0, failed: 0, skipped: 0 };
  const now = new Date();
  const stale = new Date(now.getTime() - CLAIM_MS).toISOString();
  const { data, error } = await svc
    .from("email_blasts")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_for", now.toISOString())
    .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
    .order("scheduled_for", { ascending: true })
    .limit(max);
  // Before the migration is applied there is nothing to send, and that is not a failure.
  if (error && isResultsNotApplied(error)) return tally;
  if (error) throw fromPostgrest(error);
  const due = (data ?? []) as Row[];
  if (due.length === 0) return tally;

  const approved = await approvedCounselorIds(svc, [...new Set(due.map((r) => String(r.counselor_id)))]);
  const profiles = new Map<string, Row | null>();

  for (const blast of due) {
    const id = String(blast.id);
    const counselorId = String(blast.counselor_id);
    if (!approved.has(counselorId)) {
      tally.held += 1; // fail closed: a pending or revoked counselor sends nothing
      continue;
    }

    try {
      if (!profiles.has(counselorId)) {
        const { data: p } = await svc.from("profiles").select("full_name, email, timezone").eq("id", counselorId).maybeSingle();
        profiles.set(counselorId, (p as unknown as Row | null) ?? null);
      }
      const counselor = profiles.get(counselorId);
      const timezone = (counselor?.timezone as string | null) ?? null;
      const yearly = blast.repeat_yearly === true;
      const scheduledFor = String(blast.scheduled_for);

      if (!(await consumeRateLimit(`blast-run:${counselorId}`, BLAST_DAILY_CAP, 86_400))) {
        await svc
          .from("email_blasts")
          .update({ scheduled_for: new Date(now.getTime() + RETRY_MS).toISOString() })
          .eq("id", id)
          .eq("status", "scheduled");
        tally.held += 1;
        continue;
      }

      // Claim it. Two overlapping runs cannot both win this update.
      const claim = await svc
        .from("email_blasts")
        .update({ claimed_at: now.toISOString() })
        .eq("id", id)
        .eq("status", "scheduled")
        .eq("scheduled_for", scheduledFor)
        .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
        .select("id")
        .maybeSingle();
      if (claim.error || !claim.data) continue;

      const { recipients } = await resolveAudience(svc, counselorId, {
        recipientType: blast.recipient_type === "parents" ? "parents" : "students",
        ...filtersOf(blast),
        studentIds: Array.isArray(blast.student_ids) && blast.student_ids.length ? (blast.student_ids as string[]) : undefined,
      });
      const reached = recipients.filter((r) => r.email);

      // A year where nobody can be reached is skipped, not an error; a one-off ends as failed so the counselor sees it.
      if (reached.length === 0 || recipients.length > MAX_RECIPIENTS) {
        if (yearly) {
          await advance(svc, id, scheduledFor, timezone, now, null);
        } else {
          await svc
            .from("email_blasts")
            .update({ status: "failed", claimed_at: null, recipient_count: recipients.length, sent_at: now.toISOString() })
            .eq("id", id);
        }
        tally.skipped += 1;
        continue;
      }

      // A yearly blast keeps its own row to run again; each run is a row of its own.
      let runId = id;
      if (yearly) {
        const { data: run, error: runError } = await svc
          .from("email_blasts")
          .insert({
            counselor_id: counselorId,
            firm_id: blast.firm_id ?? null,
            subject: blast.subject,
            body: blast.body,
            audience_kind: "filters",
            audience_label: blast.audience_label,
            channel: "email",
            status: "sending",
            recipient_type: blast.recipient_type,
            filters: blast.filters,
            student_ids: blast.student_ids,
            recipient_count: recipients.length,
          })
          .select("id")
          .single();
        if (runError) throw fromPostgrest(runError);
        runId = String(run.id);
      } else {
        await svc.from("email_blasts").update({ recipient_count: recipients.length }).eq("id", id);
      }

      const result = await deliverBlast({
        db: svc,
        blastId: runId,
        subject: String(blast.subject),
        body: String(blast.body),
        counselorName: (counselor?.full_name as string | null) ?? null,
        replyTo: String(counselor?.email ?? "").trim() || undefined,
        recipients,
        logger,
        // A yearly run is a new row each time, so its key names the template and the time it fell due.
        keyPrefix: yearly ? `blast:${id}:${scheduledFor}` : `blast:${id}`,
        reset: !yearly,
      });

      const sentAt = new Date().toISOString();
      const totals = { delivered_count: result.delivered, failed_count: result.failed, sent_at: sentAt };
      if (yearly) {
        await svc.from("email_blasts").update({ status: result.status, ...totals }).eq("id", runId);
        await advance(svc, id, scheduledFor, timezone, now, sentAt);
      } else {
        await svc.from("email_blasts").update({ status: result.status, claimed_at: null, ...totals }).eq("id", id);
      }
      tally.sent += 1;
    } catch (err) {
      logger.error({ err, blast: id }, "email blast: run failed");
      tally.failed += 1;
    }
  }
  return tally;
}

/** A yearly blast's next run: a year on from the one that just fell due, and always in the future. */
async function advance(svc: SupabaseClient, id: string, scheduledFor: string, timezone: string | null, now: Date, sentAt: string | null) {
  let next = nextYear(scheduledFor, timezone);
  for (let i = 0; i < MAX_YEARS_AHEAD && Date.parse(next) <= now.getTime(); i += 1) next = nextYear(next, timezone);
  await svc
    .from("email_blasts")
    .update({ scheduled_for: next, claimed_at: null, ...(sentAt ? { sent_at: sentAt } : {}) })
    .eq("id", id)
    .eq("status", "scheduled");
}
