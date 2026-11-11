/**
 * Family reports and narrative flags — the review queue for the two things the
 * AI routes write as drafts.
 *
 * `/ai/family-report` and `/ai/narrative-coherence` create rows and stop. Until
 * now there was no way to resolve a flag, approve a report, or record that one
 * was sent, which meant the counselor's half of the workflow lived nowhere.
 *
 * Sending is always the counselor's explicit call, never a side effect:
 *  - `GET /reports/family/:id/recipients` shows who would receive a draft right
 *    now and the exact text each would read (lib/familyReportSend.ts), and who
 *    wouldn't and why.
 *  - `POST /reports/family/:id/approve-send` `{ confirm: true }` re-decides the
 *    recipients on the server, claims the draft (draft -> sent, once), and writes
 *    one scheduled `student_messages` row per channel (audience parent) for the
 *    dispatch cron, which re-checks roster, approval, alerts, addresses, quiet
 *    hours and the daily cap before anything goes out.
 *  - `POST /reports/family/:id/dismiss` discards a draft without sending.
 *  - `POST /reports/family/:id/sent` still only records a send that happened
 *    elsewhere.
 * The weekly digest job (lib/weeklyDigest.ts) writes drafts and never sends.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadAlertPrefs } from "../lib/accountability.js";
import {
  applyToWeeklyReport,
  FAMILY_LABELS,
  labelList,
  loadFamilyVisibility,
  type FamilyCategory,
} from "../lib/familyVisibility.js";
import { badRequest, conflict, forbidden, fromPostgrest, HttpError, notFound, tooManyRequests } from "../lib/errors.js";
import {
  emailBodyOf,
  planReportRecipients,
  reportMessages,
  smsTextOf,
  type GuardianRow,
  type RecipientPlan,
  type ReportChannel,
} from "../lib/familyReportSend.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { enforceQuota, limit } from "../lib/limits.js";
import { serviceClient } from "../lib/supabase.js";
import { loadPracticeSettings } from "../lib/practiceSettings.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { toFamilyReport, toNarrativeFlag } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid() });
const studentQuery = z.object({ studentId: z.string().uuid().optional() });

const flagPatch = z
  .object({
    status: z.enum(["open", "resolved", "dismissed"]).optional(),
    sharedWithStudent: z.boolean().optional(),
  })
  .strict();

const reportPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    body: z.string().trim().max(20_000).nullable().optional(),
    highlights: z.array(z.string().trim().max(240)).max(12).optional(),
    status: z.enum(["draft", "sent", "archived"]).optional(),
  })
  .strict();

export default async function reportRoutes(app: FastifyInstance) {
  // ---- Narrative flags ------------------------------------------------------

  // Roster-wide by default: a roster lookup plus up to 500 rows, so this one
  // carries the DB-backed limiter rather than leaning on the in-process cap.
  app.get(
    "/flags",
    { preHandler: [app.authenticate, limit("reports:flags", 120, 60)] },
    async (request) => {
      const q = studentQuery
        .extend({
          status: z.enum(["open", "resolved", "dismissed"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(request.query);

      const scope = await rosterScope(request, q.studentId);
      let builder = request.db.from("narrative_flags").select("*").in("student_id", scope);
      if (q.status) builder = builder.eq("status", q.status);

      const { data, error } = await builder
        .order("created_at", { ascending: false })
        .limit(q.limit ?? 200);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => toNarrativeFlag(r as Row));
    }
  );

  /**
   * Resolve, dismiss, or share a flag with the student. A counselor's call: a
   * flag is a reading of the application, and the student agreeing with it is
   * not what closes it.
   */
  app.patch(
    "/flags/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("flags:update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const patch = flagPatch.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");

      const owner = await ownerOf(request, "narrative_flags", id, "That flag doesn't exist");
      await resolveStudentId(request, owner, "edit");

      if (patch.sharedWithStudent === true) {
        const { settings } = await loadPracticeSettings(request);
        if (!settings.studentsSeeSharedReports) {
          throw forbidden("Sharing reports with students is turned off in Settings › Data & privacy.");
        }
      }

      const values: Record<string, unknown> = {};
      if (patch.sharedWithStudent !== undefined) values.shared_with_student = patch.sharedWithStudent;
      if (patch.status !== undefined) {
        values.status = patch.status;
        const closing = patch.status !== "open";
        values.resolved_by = closing ? request.auth.userId : null;
        values.resolved_at = closing ? new Date().toISOString() : null;
      }

      const { data, error } = await request.db
        .from("narrative_flags")
        .update(values)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toNarrativeFlag(data as Row);
    }
  );

  app.delete(
    "/flags/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("flags:delete", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "narrative_flags", id, "That flag doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const { error } = await request.db.from("narrative_flags").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  // ---- Family reports -------------------------------------------------------

  app.get(
    "/family",
    { preHandler: [app.authenticate, limit("reports:family", 120, 60)] },
    async (request) => {
      const q = studentQuery
        .extend({
          status: z.enum(["draft", "sent", "archived"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(request.query);

      const scope = await rosterScope(request, q.studentId);
      let builder = request.db.from("family_reports").select("*").in("student_id", scope);
      if (q.status) builder = builder.eq("status", q.status);

      const { data, error } = await builder
        .order("created_at", { ascending: false })
        .limit(q.limit ?? 200);
      if (error) throw fromPostgrest(error);
      return (data ?? []).map((r) => toFamilyReport(r as Row));
    }
  );

  /** Edit a draft before it goes anywhere. The counselor's words win. */
  app.patch(
    "/family/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:update", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const patch = reportPatch.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");

      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const values: Record<string, unknown> = {};
      if (patch.title !== undefined) values.title = patch.title;
      if (patch.summary !== undefined) values.summary = patch.summary;
      if (patch.body !== undefined) values.body = patch.body;
      if (patch.highlights !== undefined) values.highlights = patch.highlights;
      if (patch.status !== undefined) values.status = patch.status;

      const { data, error } = await request.db
        .from("family_reports")
        .update(values)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toFamilyReport(data as Row);
    }
  );

  /**
   * Record that a report was sent. Separate from the patch above on purpose:
   * "sent" is a fact about the world, and it should take a deliberate call to
   * assert one rather than falling out of a field update.
   */
  app.post(
    "/family/:id/sent",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:sent", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");

      const { data, error } = await request.db
        .from("family_reports")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toFamilyReport(data as Row);
    }
  );


  // ---- Approve and send -----------------------------------------------------

  /**
   * Who would receive this report right now, and the exact text each would
   * read; plus who wouldn't, and why. Read-only.
   */
  app.get(
    "/family/:id/recipients",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:recipients", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");
      const stored = await loadReport(request, id);
      const [{ plan, studentName }, sendable] = await Promise.all([recipientPlan(request, owner), asTheFamilyReceivesIt(request, stored)]);
      const report = sendable.report;
      const messages = sendable.nothingLeft
        ? []
        : reportMessages(report, plan.recipients, { counselorName: request.profile.full_name ?? null, studentName });
      return {
        reportId: id,
        status: report.status,
        canSend: report.status === "draft" && plan.recipients.length > 0 && !sendable.nothingLeft,
        recipients: plan.recipients,
        skipped: plan.skipped,
        skippedGuardians: plan.skippedGuardians,
        messages,
        // What the parents receive: the kinds left out of this report, and whether anything is left to send.
        familyVisibility: {
          available: sendable.available,
          leftOut: sendable.leftOut.map((c) => ({ category: c, label: FAMILY_LABELS[c] })),
          nothingLeft: sendable.nothingLeft,
        },
      };
    }
  );

  /**
   * Approve a draft and send it to the family. The recipients are decided here,
   * never by the client; the draft is claimed (draft -> sent) before any message
   * row is written, so a second call, or two at once, can never send twice. The
   * rows are scheduled for now: the dispatch cron sends them through the same
   * re-checks as any scheduled composer message.
   */
  app.post(
    "/family/:id/approve-send",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:approve-send", 30, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      z.object({ confirm: z.literal(true) }).strict().parse(request.body);
      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");
      const stored = await loadReport(request, id);
      if (stored.status !== "draft") throw notDraft(stored.status);
      // What the parents receive is decided now, from the switches as they are (a read error refuses the send).
      const sendable = await asTheFamilyReceivesIt(request, stored);
      if (sendable.nothingLeft) {
        throw new HttpError(
          409,
          `Everything in this report is switched off for the parents (${labelList(sendable.leftOut)}), so there is nothing to send`,
          "report_nothing_to_send"
        );
      }
      const report = sendable.report;

      // The dispatcher sends a message only for the student's own counselor, so only they may approve one.
      const { plan, counselorId } = await recipientPlan(request, owner);
      if (counselorId !== request.auth.userId) throw forbidden("Only the student's counselor can send a report to their family");
      if (plan.recipients.length === 0) {
        throw badRequest(
          plan.skipped.parentsOff > 0
            ? "Messages to the parents are switched off for this student"
            : "No parent or guardian on file receives reports at an address we have"
        );
      }
      await enforceQuota(request.auth.userId, "parent_alerts", "day", 100, "You've sent a lot of family messages today.");

      const sentAt = new Date().toISOString();
      const { data: claimed, error: claimError } = await request.db
        .from("family_reports")
        .update({ status: "sent", sent_at: sentAt })
        .eq("id", id)
        .eq("status", "draft")
        .select("*")
        .maybeSingle();
      if (claimError) throw fromPostgrest(claimError);
      if (!claimed) throw conflict("This report was already sent or dismissed");

      const rows = (["email", "sms"] as ReportChannel[])
        .map((channel) => ({
          channel,
          recipients: plan.recipients
            .filter((r) => r.channels.includes(channel))
            .map((r) => ({ kind: "guardian" as const, id: r.guardianId, name: r.name, email: r.email, phone: r.phone })),
        }))
        .filter((g) => g.recipients.length > 0)
        .map((g) => ({
          student_id: owner,
          counselor_id: request.auth.userId,
          audience: "parent",
          channel: g.channel,
          kind: "message",
          recipients: g.recipients,
          subject: g.channel === "email" ? report.title.slice(0, 300) : null,
          body: g.channel === "email" ? emailBodyOf(report) : smsTextOf(report),
          status: "scheduled",
          scheduled_for: sentAt,
          hold_reason: "Approved family report: it goes out with the next scheduled send",
          // Dispatch re-checks each guardian's receives_reports for a row that carries a report.
          family_report_id: id,
        }));
      const { data: written, error: insertError } = await request.db.from("student_messages").insert(rows).select("id, channel, scheduled_for");
      if (insertError) {
        // Nothing was queued: give the draft back, so the counselor can try again.
        const { error: undoError } = await request.db
          .from("family_reports")
          .update({ status: "draft", sent_at: null })
          .eq("id", id)
          .eq("status", "sent");
        if (undoError) request.log.error({ code: undoError.code }, "approve-send: draft restore failed");
        if (insertError.code === "54000") throw tooManyRequests("You've sent a lot of family messages today.");
        // Without 20261111000013 the send couldn't re-check receives_reports at dispatch: refuse rather than send.
        if (isResultsNotApplied(insertError)) {
          throw new HttpError(503, "Sending family reports isn't switched on yet", "family_report_send_unavailable");
        }
        throw fromPostgrest(insertError);
      }

      await closeWorkItems(request, id);
      // Who approved it and when, beside the message rows (counselor_id, created_at). Best effort.
      const svc = serviceClient();
      if (svc) {
        const { error: auditError } = await svc.from("audit_log").insert({
          actor_id: request.auth.userId,
          student_id: owner,
          action: "family_report.approve_send",
          entity_type: "family_report",
          entity_id: id,
          metadata: { messageIds: ((written ?? []) as Row[]).map((m) => String(m.id)), recipients: plan.recipients.length },
        });
        if (auditError) request.log.warn({ code: auditError.code }, "approve-send: audit insert failed");
      }

      return {
        report: toFamilyReport(claimed as Row),
        messages: ((written ?? []) as Row[]).map((m) => ({
          id: String(m.id),
          channel: m.channel as ReportChannel,
          scheduledFor: String(m.scheduled_for),
        })),
        recipients: plan.recipients.length,
        skipped: plan.skipped,
      };
    }
  );

  /** Discard a draft without sending it; its work item is done. */
  app.post(
    "/family/:id/dismiss",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:dismiss", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");
      const { data, error } = await request.db
        .from("family_reports")
        .update({ status: "archived" })
        .eq("id", id)
        .eq("status", "draft")
        .select("*")
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      if (!data) throw conflict("Only a draft can be dismissed");
      await closeWorkItems(request, id);
      return toFamilyReport(data as Row);
    }
  );

  app.delete(
    "/family/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("family-reports:delete", 60, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const owner = await ownerOf(request, "family_reports", id, "That report doesn't exist");
      await resolveStudentId(request, owner, "edit");

      // A weekly digest is archived, not deleted: its row is what stops the hourly job drafting that week again.
      const { data: kindRow, error: kindError } = await request.db.from("family_reports").select("kind").eq("id", id).maybeSingle();
      if (kindError) throw fromPostgrest(kindError);
      if (kindRow?.kind === "weekly") {
        const { error: archiveError } = await request.db.from("family_reports").update({ status: "archived" }).eq("id", id);
        if (archiveError) throw fromPostgrest(archiveError);
        await closeWorkItems(request, id);
        return { deleted: true, archived: true };
      }

      const { error } = await request.db.from("family_reports").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}

type ReportRow = { id: string; student_id: string; status: string; kind: string | null; title: string; summary: string | null; body: string | null };

/**
 * The report as this family may receive it now. A weekly report is the digest's text with the kinds switched off in
 * what the parents receive left out (lib/familyVisibility.ts; every switch on: the text untouched). Any other
 * report was written or edited by the counselor, so it goes as written. Throws on a read error (fail closed).
 */
async function asTheFamilyReceivesIt(
  request: FastifyRequest,
  report: ReportRow
): Promise<{ report: ReportRow; leftOut: FamilyCategory[]; nothingLeft: boolean; available: boolean }> {
  if (report.kind !== "weekly") return { report, leftOut: [], nothingLeft: false, available: true };
  const state = await loadFamilyVisibility(request.db, report.student_id);
  return { ...applyToWeeklyReport(report, state.visibility), available: state.available };
}

async function loadReport(request: FastifyRequest, id: string): Promise<ReportRow> {
  const { data, error } = await request.db
    .from("family_reports")
    .select("id, student_id, status, kind, title, summary, body")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That report doesn't exist");
  return data as ReportRow;
}

function notDraft(status: string): HttpError {
  return new HttpError(
    409,
    status === "sent" ? "This report was already sent" : "This report was dismissed",
    "report_not_draft"
  );
}

/**
 * Who would receive a report about this student now: copy_parents (failing
 * closed, `loadAlertPrefs`), then each guardian's alerts, reports and preferred
 * channel (`planReportRecipients`). Read on the caller's own client.
 */
async function recipientPlan(
  request: FastifyRequest,
  studentId: string
): Promise<{ plan: RecipientPlan; studentName: string; counselorId: string | null }> {
  const [prefs, guardians, student] = await Promise.all([
    loadAlertPrefs(request, studentId),
    request.db
      .from("guardians")
      .select("id, full_name, email, phone, relationship, preferred_channel, alerts_enabled, receives_reports")
      .eq("student_id", studentId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true }),
    request.db.from("profiles").select("full_name, counselor_id").eq("id", studentId).maybeSingle(),
  ]);
  if (guardians.error) throw fromPostgrest(guardians.error);
  if (student.error) throw fromPostgrest(student.error);
  return {
    plan: planReportRecipients((guardians.data ?? []) as GuardianRow[], prefs),
    studentName: String(student.data?.full_name ?? ""),
    counselorId: (student.data?.counselor_id as string | null) ?? null,
  };
}

/** The report's Review Queue items are done. Never fatal: the report's own status is the record. */
async function closeWorkItems(request: FastifyRequest, reportId: string): Promise<void> {
  const { error } = await request.db
    .from("counselor_work_items")
    .update({ done: true, done_at: new Date().toISOString() })
    .eq("family_report_id", reportId)
    .eq("done", false);
  if (error) request.log.warn({ code: error.code }, "family report: work item update failed");
}

/** The row's real student_id — never one a client claimed. */
async function ownerOf(
  request: FastifyRequest,
  table: "narrative_flags" | "family_reports",
  id: string,
  missing: string
): Promise<string> {
  const { data, error } = await request.db
    .from(table)
    .select("student_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound(missing);
  return data.student_id as string;
}

/**
 * Scope a review-queue read to one student, or to the counselor's whole roster.
 *
 * A review queue is roster-wide by nature — the counselor is asking "what is
 * waiting on me", not "what is waiting on me for Sophia". Requiring `studentId`
 * the way `resolveStudentId` does forced the client into one request per
 * student, which is 2N requests for an N-student roster and does not survive a
 * real practice.
 *
 * Returns ids rather than taking the query builder: a PostgREST builder is
 * thenable, so handing one to an async function and awaiting the result runs
 * the query instead of returning the builder.
 *
 * RLS would scope this on its own, but the roster filter is applied as well: a
 * route that leans only on RLS leaks the shape of the answer, and AGENTS.md
 * asks for both layers.
 */
async function rosterScope(
  request: FastifyRequest,
  studentId: string | undefined
): Promise<string[]> {
  if (studentId || request.profile.role === "student") {
    return [await resolveStudentId(request, studentId, "view")];
  }

  const { data, error } = await request.db
    .from("profiles")
    .select("id")
    .eq("counselor_id", request.auth.userId)
    .is("archived_at", null);
  if (error) throw fromPostgrest(error);

  const ids = (data ?? []).map((r) => r.id as string);
  // An empty roster must match nothing, not everything. A uuid that is never a
  // real profile id keeps the `in` list non-empty without widening it.
  return ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"];
}
