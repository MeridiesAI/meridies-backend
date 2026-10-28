/**
 * Contact Pipeline email sequences (migration 20261028000004): a counselor
 * writes a few emails once, enrolls contacts (now or from a future date), and
 * the `pipeline-sequences` cron sends each one when it falls due.
 *
 * Until the migration is applied the routes answer 503
 * `pipeline_sequences_unavailable` and the cron answers `ran: false`; nothing
 * 500s. Ready is remembered for the process, missing for 30 seconds (the same
 * shape as `lib/pipelineExtras.ts`).
 *
 * The dispatcher is the only writer of an enrollment's progress. Like
 * `dispatchDueMessages` it claims a row before sending (`claimed_at`, reclaimed
 * after ten minutes) and passes a stable Resend idempotency key, so a crash
 * between the send and the bookkeeping resends nothing. Who may be emailed is
 * decided again at send time, from the contact's row: still open, not
 * converted, not unsubscribed, an address on the card. The contact's own
 * counselor must still be approved (`approvedCounselorIds`).
 */

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import { approvedCounselorIds } from "./access.js";
import { fillTemplate, paragraphs, todayIn } from "./crm.js";
import { crmError } from "./crm.js";
import { brandedEmail, brandedText, sendEmail } from "./email.js";
import { zonedToUtc } from "./eventsHub.js";
import { HttpError, fromPostgrest } from "./errors.js";
import { hashToken, unsubscribeBaseUrl } from "./kpi/monthly.js";
import { consumeRateLimit } from "./limits.js";
import { isResultsNotApplied } from "./resultsAvailability.js";

type Row = Record<string, unknown>;
type Log = { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

export const SEQUENCE_COLUMNS = "id, name, send_hour, created_at, updated_at";
export const STEP_COLUMNS = "id, sequence_id, position, offset_days, to_who, subject, body";
export const ENROLLMENT_COLUMNS =
  "id, contact_id, sequence_id, status, stop_reason, next_position, next_send_at, last_sent_at, created_at";

/** Emails one counselor's sequences send in 24 hours. */
export const SEQUENCE_DAILY_CAP = 100;
const CLAIM_MS = 10 * 60_000;
const MAX_FAILURES = 3;
const RETRY_MS = 3_600_000;

const MISSING_RECHECK_MS = 30_000;
let ready = false;
let missingAt = 0;

export function sequencesUnavailable(): HttpError {
  return new HttpError(503, "Email sequences aren't switched on yet", "pipeline_sequences_unavailable");
}

/** A zero-row read of everything the migration adds. */
export async function sequencesReady(request: FastifyRequest): Promise<boolean> {
  if (ready) return true;
  if (Date.now() - missingAt < MISSING_RECHECK_MS) return false;
  const [seq, steps, enr, contacts] = await Promise.all([
    request.db.from("pipeline_sequences").select("id").limit(0),
    request.db.from("pipeline_sequence_steps").select("id").limit(0),
    request.db.from("pipeline_sequence_enrollments").select("id").limit(0),
    request.db.from("pipeline_contacts").select("email_opted_out_at").limit(0),
  ]);
  const error = seq.error ?? steps.error ?? enr.error ?? contacts.error;
  if (!error) {
    ready = true;
    return true;
  }
  if (isResultsNotApplied(error)) {
    missingAt = Date.now();
    return false;
  }
  throw crmError(error);
}

export async function requireSequences(request: FastifyRequest): Promise<void> {
  if (!(await sequencesReady(request))) throw sequencesUnavailable();
}

// ---- Serializers -------------------------------------------------------------

export function toStep(r: Row) {
  return {
    id: String(r.id),
    position: Number(r.position),
    offsetDays: Number(r.offset_days),
    to: String(r.to_who) as "student" | "parent" | "both",
    subject: String(r.subject),
    body: String(r.body),
  };
}

export function toSequence(r: Row, steps: Row[], active = 0) {
  return {
    id: String(r.id),
    name: String(r.name),
    sendHour: Number(r.send_hour),
    steps: steps.map(toStep).sort((a, b) => a.position - b.position),
    activeEnrollments: active,
    createdAt: String(r.created_at),
  };
}

export function toEnrollment(r: Row, sequenceName: string, totalSteps: number) {
  return {
    id: String(r.id),
    contactId: String(r.contact_id),
    sequenceId: String(r.sequence_id),
    sequenceName,
    status: String(r.status) as "active" | "paused" | "completed" | "stopped",
    stopReason: String(r.stop_reason ?? ""),
    nextPosition: Number(r.next_position),
    totalSteps,
    nextSendAt: String(r.next_send_at),
    lastSentAt: (r.last_sent_at as string | null) ?? null,
  };
}

// ---- When an email goes out ----------------------------------------------------

/** `date` (YYYY-MM-DD) plus whole days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A local date and hour in the counselor's time zone, as a UTC instant. */
export function sendAt(date: string, hour: number, timezone: string | null | undefined): string {
  const tz = timezone?.trim() || "America/New_York";
  return zonedToUtc(date, `${String(hour).padStart(2, "0")}:00`, tz);
}

/** The first email: `startOn` (or today) plus the first step's offset. */
export function firstSendAt(
  startOn: string | undefined,
  offsetDays: number,
  hour: number,
  timezone: string | null | undefined
): string {
  return sendAt(addDays(startOn ?? todayIn(timezone), offsetDays), hour, timezone);
}

// ---- Unsubscribe -----------------------------------------------------------------

/** A fresh unsubscribe link for one email; only the token's sha256 is stored. */
async function unsubscribeUrl(svc: SupabaseClient, contactId: string): Promise<string> {
  const base = unsubscribeBaseUrl(env.PUBLIC_API_URL);
  const token = randomBytes(32).toString("base64url");
  const { error } = await svc.from("pipeline_unsubscribe_tokens").insert({ token_hash: hashToken(token), contact_id: contactId });
  if (error) throw new Error(`unsubscribe token: ${error.code}`);
  return `${base}/pipeline/unsubscribe/${token}`;
}

// ---- Dispatch ----------------------------------------------------------------------

export type SequenceTally = { sent: number; completed: number; stopped: number; held: number; failed: number };

type Target = { who: "student" | "parent"; email: string; first: string };

function targetsFor(contact: Row, to: string): Target[] {
  const studentName = String(contact.student_name ?? "").trim();
  const last = studentName.split(/\s+/).slice(-1)[0] ?? "";
  const student: Target = {
    who: "student",
    email: String(contact.student_email ?? "").trim(),
    first: studentName.split(/\s+/)[0] ?? "",
  };
  const parent: Target = {
    who: "parent",
    email: String(contact.parent_email ?? "").trim(),
    first: String(contact.parent_name ?? "").trim().split(/\s+/)[0] || (last ? `${last} family` : ""),
  };
  const wanted = to === "student" ? [student] : to === "parent" ? [parent] : [student, parent];
  const seen = new Set<string>();
  return wanted.filter((t) => {
    const key = t.email.toLowerCase();
    if (!t.email || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Send every sequence email whose time has come. Service-role client: the
 * recipients come from the contact's card at send time, never from the
 * enrollment, and the counselor must still be approved.
 */
export async function dispatchDueSequences(svc: SupabaseClient, logger: Log, max = 100): Promise<SequenceTally> {
  const now = new Date();
  const stale = new Date(now.getTime() - CLAIM_MS).toISOString();
  const { data, error } = await svc
    .from("pipeline_sequence_enrollments")
    .select("*")
    .eq("status", "active")
    .lte("next_send_at", now.toISOString())
    .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
    .order("next_send_at", { ascending: true })
    .limit(max);
  const tally: SequenceTally = { sent: 0, completed: 0, stopped: 0, held: 0, failed: 0 };
  // Before the migration is applied there is nothing to send, and that is not a failure.
  if (error && isResultsNotApplied(error)) return tally;
  if (error) throw fromPostgrest(error);
  const due = (data ?? []) as Row[];
  if (due.length === 0) return tally;

  const approved = await approvedCounselorIds(svc, [...new Set(due.map((r) => String(r.counselor_id)))]);
  const stepsBySequence = new Map<string, Row[]>();
  const sequences = new Map<string, Row | null>();
  const profiles = new Map<string, Row | null>();

  const stop = async (id: string, reason: string) => {
    await svc
      .from("pipeline_sequence_enrollments")
      .update({ status: "stopped", stop_reason: reason, claimed_at: null })
      .eq("id", id)
      .eq("status", "active");
    tally.stopped += 1;
  };

  for (const row of due) {
    const id = String(row.id);
    const counselorId = String(row.counselor_id);
    if (!approved.has(counselorId)) {
      tally.held += 1; // fail closed: a pending or revoked counselor sends nothing
      continue;
    }

    try {
      const { data: c, error: cErr } = await svc
        .from("pipeline_contacts")
        .select("id, student_name, student_email, parent_name, parent_email, status, student_id, email_opted_out_at")
        .eq("id", String(row.contact_id))
        .maybeSingle();
      if (cErr) throw fromPostgrest(cErr);
      if (!c) continue;
      const contact = c as unknown as Row;
      if (contact.email_opted_out_at) {
        await stop(id, "unsubscribed");
        continue;
      }
      if (contact.status !== "open" || contact.student_id) {
        await stop(id, contact.status === "lost" ? "lost" : "won");
        continue;
      }

      const seqId = String(row.sequence_id);
      if (!sequences.has(seqId)) {
        const { data: s } = await svc.from("pipeline_sequences").select("id, name, send_hour").eq("id", seqId).maybeSingle();
        sequences.set(seqId, (s as unknown as Row | null) ?? null);
        const { data: st } = await svc.from("pipeline_sequence_steps").select(STEP_COLUMNS).eq("sequence_id", seqId);
        stepsBySequence.set(seqId, (st ?? []) as unknown as Row[]);
      }
      const sequence = sequences.get(seqId);
      const steps = (stepsBySequence.get(seqId) ?? []).slice().sort((a, b) => Number(a.position) - Number(b.position));
      const step = steps.find((s) => Number(s.position) === Number(row.next_position));
      if (!sequence || !step) {
        // The sequence was edited shorter than this contact's place in it.
        await svc
          .from("pipeline_sequence_enrollments")
          .update({ status: "completed", claimed_at: null })
          .eq("id", id)
          .eq("status", "active");
        tally.completed += 1;
        continue;
      }

      const targets = targetsFor(contact, String(step.to_who));
      if (targets.length === 0) {
        await stop(id, "no-address");
        continue;
      }

      if (!profiles.has(counselorId)) {
        const { data: p } = await svc.from("profiles").select("full_name, timezone, email").eq("id", counselorId).maybeSingle();
        profiles.set(counselorId, (p as unknown as Row | null) ?? null);
      }
      const counselor = profiles.get(counselorId);
      const timezone = (counselor?.timezone as string | null) ?? null;
      const counselorName = String(counselor?.full_name ?? "").trim();
      const replyTo = String(counselor?.email ?? "").trim() || undefined;

      if (!(await consumeRateLimit(`pipeline-seq:${counselorId}`, SEQUENCE_DAILY_CAP, 86_400))) {
        await svc
          .from("pipeline_sequence_enrollments")
          .update({ next_send_at: new Date(now.getTime() + RETRY_MS).toISOString() })
          .eq("id", id)
          .eq("status", "active");
        tally.held += 1;
        continue;
      }

      // Claim it. Two overlapping runs cannot both win this update.
      const claim = await svc
        .from("pipeline_sequence_enrollments")
        .update({ claimed_at: now.toISOString() })
        .eq("id", id)
        .eq("status", "active")
        .eq("next_send_at", String(row.next_send_at))
        .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
        .select("id")
        .maybeSingle();
      if (claim.error || !claim.data) continue;

      let delivered = 0;
      for (const t of targets) {
        const vars = { first: t.first, me: counselorName };
        const subject = fillTemplate(String(step.subject), vars);
        const url = await unsubscribeUrl(svc, String(contact.id));
        const template = {
          heading: subject,
          paragraphs: paragraphs(fillTemplate(String(step.body), vars)),
          footnote: counselorName ? `Sent by ${counselorName} through Meridies.` : "Sent through Meridies.",
          footnoteLink: { label: "Unsubscribe from these emails", url },
        };
        const sent = await sendEmail({
          to: t.email,
          subject,
          html: brandedEmail(template),
          text: brandedText(template),
          template: "pipeline-sequence",
          recipient_kind: t.who === "parent" ? "guardian" : "student",
          idempotencyKey: `pseq:${id}:${step.position}:${t.who}`,
          replyTo,
          headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
          logger: logger as never,
        });
        if (sent.sent) delivered += 1;
      }

      if (delivered === 0) {
        const failures = Number(row.failures ?? 0) + 1;
        if (failures >= MAX_FAILURES) {
          await stop(id, "send-failed");
        } else {
          await svc
            .from("pipeline_sequence_enrollments")
            .update({ failures, claimed_at: null, next_send_at: new Date(now.getTime() + RETRY_MS).toISOString() })
            .eq("id", id);
        }
        tally.failed += 1;
        continue;
      }

      // The email left; the timeline entry is best effort.
      const { error: logError } = await svc.from("pipeline_activities").insert({
        contact_id: String(contact.id),
        kind: "email",
        body: `Sequence "${String(sequence.name)}" (email ${String(step.position)}): ${String(step.subject)}`.slice(0, 4000),
        meta: { sequenceId: seqId, step: Number(step.position) },
      });
      if (logError) logger.warn({ code: logError.code }, "pipeline sequence: could not log the email to the timeline");

      const next = steps.find((s) => Number(s.position) === Number(step.position) + 1);
      const sentAtIso = new Date().toISOString();
      if (next) {
        await svc
          .from("pipeline_sequence_enrollments")
          .update({
            next_position: Number(next.position),
            next_send_at: sendAt(addDays(todayIn(timezone), Number(next.offset_days)), Number(sequence.send_hour), timezone),
            last_sent_at: sentAtIso,
            claimed_at: null,
            failures: 0,
          })
          .eq("id", id);
      } else {
        await svc
          .from("pipeline_sequence_enrollments")
          .update({ status: "completed", last_sent_at: sentAtIso, claimed_at: null, failures: 0 })
          .eq("id", id);
        tally.completed += 1;
      }
      tally.sent += 1;
    } catch (err) {
      logger.error({ err, enrollment: id }, "pipeline sequence: step failed");
      tally.failed += 1;
    }
  }
  return tally;
}
