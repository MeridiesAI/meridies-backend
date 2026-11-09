/**
 * Data export and account deletion (BACKEND_TODO §6).
 *
 *   GET    /account/export                  everything the caller can read about
 *                                           themselves (a student: their record;
 *                                           a counselor: their profile, roster and
 *                                           practice work)
 *   GET    /account/students/:id/export     one student's record, for their counselor
 *   POST   /account/export/students         up to 25 of the counselor's students at once: each one's
 *                                           JSON and a CSV per table (no file bytes; documents listed)
 *   POST   /account/export/drive            a roster summary as one Google Sheet in the caller's Drive
 *   DELETE /account                         delete the caller's own account
 *   GET    /account/closure                 Leave Meridies: { status: none|pending|on_hold, requestedAt, purgeAfter,
 *                                           daysLeft, purgeEnabled, blockedReason } (counselor)
 *   POST   /account/closure                 { confirm: "CLOSE" }: close after 30 days (201; 200 if already pending)
 *   DELETE /account/closure                 cancel it (the account stays open)
 *
 * Exports read through the caller's RLS-bound client, so each one contains
 * exactly what that person may already see (a student's export can't include
 * their counselor's private notes; the counselor's can). Operational logs
 * (ai_runs, audit_log) are not part of anyone's record.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { DeletionFailed, blockError, deleteAccount, deletionBlocker, type DeletionSubject } from "../lib/accountDeletion.js";
import { closureEmail, closureView, isActiveClosure, isClosureTableMissing, isStalePurging, purgeAfterFrom, purgeFlag, type ClosureRow } from "../lib/accountClosure.js";
import { sendEmail } from "../lib/email.js";
import { badRequest, fromPostgrest, HttpError, unavailable } from "../lib/errors.js";
import { caseloadStudentIds, requireRole, resolveStudentId } from "../lib/guards.js";
import { consumeUnits, limit } from "../lib/limits.js";
import { sheetClient, sheetTitle } from "../lib/driveExport.js";
import { ReadStopped, orderKeysFor, readPaged } from "../lib/pagedRead.js";
import {
  BATCH_EXPORT_UNITS_PER_HOUR,
  EXPORT_BATCH_MAX,
  ExportBudget,
  FILES_NOT_INCLUDED_NOTE,
  MAX_BATCH_BYTES,
  MAX_BATCH_ROWS,
  MAX_SUMMARY_STUDENTS,
  SUMMARY_COUNTS,
  assembleStudent,
  exportCost,
  pageGuard,
  rosterSummaryCsv,
  splitByCaseload,
  type BatchStudent,
  type SummaryRow,
} from "../lib/studentExport.js";
import { serviceClient } from "../lib/supabase.js";

type Row = Record<string, unknown>;

/** Every table keyed by student_id that belongs in a student's record. */
export const STUDENT_RECORD_TABLES = [
  "accountability_settings", "activities", "admission_outcomes", "alumni_records", "award_appeals",
  "award_letter_items", "award_letters", "awards", "calendar_events", "coherence_reports",
  "college_list_items", "college_list_variants", "courses", "deadlines", "deliverable_documents",
  "deliverable_stages", "deliverable_tracker_checks", "deliverables", "document_links", "documents",
  "draft_quality_checks", "essay_marks", "essay_versions", "essays", "family_reports", "folders",
  "guardians", "intake_responses", "library_resource_pins", "meeting_attendees", "meeting_notes",
  "meetings", "message_deliveries", "narrative_flags", "net_price_estimates", "notifications",
  "opportunity_matches", "opportunity_requests", "parent_alerts", "polygon_axis_history",
  "progress_events", "recommendations", "red_flags", "research_runs", "scholarship_match_prefs",
  "scholarship_matches", "school_reframing", "student_academics", "student_aid_checklist", "student_aid_profiles",
  "student_alert_prefs", "student_college_fit", "student_college_recommendations", "student_colleges",
  "student_messages", "student_personal_details", "student_polygon_axes", "student_preference_cards",
  "student_private_notes", "student_status_overrides", "supplement_docs", "test_scores",
] as const;

/**
 * One table's rows where `column` = `value`, read in pages in a stable order (PostgREST's max_rows would
 * otherwise cut it at 1,000) up to TABLE_ROW_CAP; `truncated` only when rows were really left out.
 */
function readTable(
  request: FastifyRequest,
  table: string,
  column: string,
  value: string,
  onPage?: (rows: Row[]) => void,
  columns = "*"
) {
  return readPaged(
    (from, to) => {
      let q = request.db.from(table).select(columns).eq(column, value);
      for (const key of orderKeysFor(table)) q = q.order(key);
      return q.range(from, to);
    },
    { onPage }
  );
}

/**
 * A student's record as the caller sees it. `onPage` (the batch's `pageGuard`) sees every page and may stop
 * the read by throwing ReadStopped. `truncated` lists tables past the per-table cap, only when there are any.
 */
async function exportStudent(request: FastifyRequest, studentId: string, onPage?: (rows: Row[]) => void) {
  const [profile, ...tables] = await Promise.all([
    request.db.from("profiles").select("*").eq("id", studentId).maybeSingle(),
    ...STUDENT_RECORD_TABLES.map((t) => readTable(request, t, "student_id", studentId, onPage)),
  ]);
  if (profile.error) throw fromPostgrest(profile.error);
  const records: Record<string, Row[]> = {};
  const skipped: string[] = [];
  const truncated: string[] = [];
  tables.forEach((r, i) => {
    const name = STUDENT_RECORD_TABLES[i]!;
    // A table this caller can't read at all (RLS/grants) is left out, not an error.
    if (r.error) skipped.push(name);
    else if (r.rows.length) records[name] = r.rows;
    if (!r.error && r.truncated) truncated.push(name);
  });
  return { profile: profile.data, records, notIncluded: skipped, ...(truncated.length ? { truncated } : {}) };
}

/**
 * Which of `ids` the caller may see: `caseloadStudentIds` (roster with archived, shared students, and the
 * caller), or, past its 250-id cap, the same rule asked about these ids only. RLS applies on top either way.
 */
async function visibleAmong(request: FastifyRequest, ids: string[]): Promise<string[]> {
  const caseload = await caseloadStudentIds(request);
  if (caseload) return caseload;
  const me = request.auth.userId;
  const [own, shared] = await Promise.all([
    request.db.from("profiles").select("id").eq("counselor_id", me).in("id", ids),
    request.db.from("student_collaborators").select("student_id").eq("counselor_id", me).in("student_id", ids),
  ]);
  if (own.error) throw fromPostgrest(own.error);
  if (shared.error) throw fromPostgrest(shared.error);
  return [
    ...((own.data ?? []) as Array<{ id: string }>).map((r) => r.id),
    ...((shared.data ?? []) as Array<{ student_id: string }>).map((r) => r.student_id),
  ];
}

/** Runs `fn` over `items`, at most `width` at a time, results in input order. */
async function mapLimited<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

const studentIdsSchema = z.array(z.string().uuid()).min(1).max(EXPORT_BATCH_MAX);
const batchBody = z.object({ studentIds: studentIdsSchema }).strict();
const driveBody = z.union([
  z.object({ studentIds: studentIdsSchema }).strict(),
  z.object({ scope: z.literal("roster-summary") }).strict(),
]);

const rosterTooLarge = () =>
  new HttpError(
    413,
    `A roster summary covers up to ${MAX_SUMMARY_STUDENTS} students. Choose the students to include instead.`,
    "roster_too_large"
  );

const tooLarge = () =>
  new HttpError(413, "That batch is too large to export at once. Export fewer students at a time.", "export_too_large");

export default async function accountRoutes(app: FastifyInstance) {
  app.get("/export", { preHandler: [app.authenticate, limit("account:export", 10, 3600)], config: { allowPending: true } }, async (request, reply) => {
    const me = request.auth.userId;
    reply.header("Content-Disposition", `attachment; filename="meridies-export-${new Date().toISOString().slice(0, 10)}.json"`);
    if (request.profile.role === "student") {
      return { exportedAt: new Date().toISOString(), kind: "student", ...(await exportStudent(request, me)) };
    }
    // Each list is paged (PostgREST's max_rows would cut it at 1,000) up to the per-table cap.
    const truncated: string[] = [];
    const own = async (table: string, label: string) => {
      const r = await readTable(request, table, "counselor_id", me);
      if (r.error) return null;
      if (r.truncated) truncated.push(label);
      return r.rows;
    };
    const [profile, roster, workItems, contacts, activities, followups, templates, resources, invitations] = await Promise.all([
      request.db.from("profiles").select("*").eq("id", me).maybeSingle(),
      readTable(request, "profiles", "counselor_id", me, undefined, "id, full_name, email, profile, archived_at, created_at"),
      own("counselor_work_items", "practice.workItems"),
      own("pipeline_contacts", "practice.contacts"),
      // The contacts' timeline and follow-ups (null before the history migration; RLS leaves out
      // billing entries the caller may not see).
      own("pipeline_activities", "practice.contactActivities"),
      own("pipeline_followups", "practice.contactFollowups"),
      own("email_templates", "practice.emailTemplates"),
      own("library_resources", "practice.resources"),
      own("invitations", "practice.invitations"),
    ]);
    if (profile.error) throw fromPostgrest(profile.error);
    if (roster.error) throw fromPostgrest(roster.error as { code?: string });
    if (roster.truncated) truncated.unshift("roster");
    return {
      exportedAt: new Date().toISOString(),
      kind: "counselor",
      profile: profile.data,
      roster: roster.rows,
      practice: {
        workItems,
        contacts,
        contactActivities: activities,
        contactFollowups: followups,
        emailTemplates: templates,
        resources,
        invitations,
      },
      ...(truncated.length ? { truncated } : {}),
      // A student's full record is its own export: GET /account/students/:id/export.
    };
  });

  app.get(
    "/students/:id/export",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("account:student-export", 60, 3600)] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const sid = await resolveStudentId(request, id, "view");
      reply.header("Content-Disposition", `attachment; filename="meridies-student-${sid}.json"`);
      return { exportedAt: new Date().toISOString(), kind: "student", ...(await exportStudent(request, sid)) };
    }
  );

  /**
   * Up to 25 students in one request, for a counselor taking their roster with them. Each id on the caller's
   * caseload gets the per-student export's JSON plus a CSV per table with rows (formula-guarded, lib/csv.ts) and
   * its documents listed by name; file bytes are never included. Any other id, someone else's student or a uuid
   * that doesn't exist, is `{ id, status: "not_found" }` and is never read. Cost-based limit: one unit per
   * distinct id from 1,000 an hour (`account:export-batch`), charged before anything is read and never from the
   * per-student export's bucket. Not open to a pending counselor (the per-student export isn't either).
   */
  app.post("/export/students", { preHandler: [app.authenticate, requireRole("counselor")] }, async (request, reply) => {
    const { studentIds } = batchBody.parse(request.body);
    const me = request.auth.userId;
    const within = await consumeUnits(`account:export-batch:${me}`, exportCost(studentIds), BATCH_EXPORT_UNITS_PER_HOUR, 3600, request.log);
    if (!within) {
      // A fixed one-hour window whose start isn't returned: an hour is the most it can take.
      return reply.code(429).header("Retry-After", "3600").send({
        error: `You can export up to ${BATCH_EXPORT_UNITS_PER_HOUR} students an hour. Try again within the hour.`,
        code: "export_rate_limited",
        retryAfterSeconds: 3600,
      });
    }
    const { allowed, notFound } = splitByCaseload(studentIds, await visibleAmong(request, studentIds), me);
    const exportedAt = new Date().toISOString();
    const budget = new ExportBudget();
    const done = new Map<string, BatchStudent>();
    // One student at a time, so a batch never holds more than the cap plus one record. A student over the
    // cap on their own stops reading early and is `too_large` (the app falls back to GET
    // /account/students/:id/export); students that fit alone but not together make the batch a 413.
    for (const id of allowed) {
      // Like the per-student export, a shared student's profile row may be null (profiles RLS lets only the
      // primary counselor read it); their records still come through the caller's RLS.
      let exported;
      try {
        exported = await exportStudent(request, id, pageGuard(MAX_BATCH_ROWS, MAX_BATCH_BYTES));
      } catch (err) {
        if (!(err instanceof ReadStopped)) throw err;
        done.set(id, { id, status: "too_large" });
        continue;
      }
      const student = assembleStudent(id, exported as Parameters<typeof assembleStudent>[1], exportedAt);
      if (student.rows > MAX_BATCH_ROWS || student.bytes > MAX_BATCH_BYTES) {
        done.set(id, { id, status: "too_large" });
        continue;
      }
      if (!budget.take(student.rows, student.bytes)) throw tooLarge();
      done.set(id, student);
    }
    const asked = new Set([...allowed, ...notFound]); // every id, lowercased, once
    const students = studentIds
      .map((raw) => raw.toLowerCase())
      .filter((id) => asked.delete(id))
      .map((id): BatchStudent => done.get(id) ?? { id, status: "not_found" });
    const truncated = students.flatMap((s) => (s.status === "ok" && s.truncated ? [{ id: s.id, tables: s.truncated }] : []));
    return {
      exportedAt,
      kind: "student-batch",
      filesIncluded: false,
      filesNote: FILES_NOT_INCLUDED_NOTE,
      students,
      ...(truncated.length ? { truncated } : {}),
    };
  });

  /**
   * A roster summary (name, email, grad year, status, counts) as one Google Sheet in the caller's own Drive,
   * under the drive.file scope they already granted. `{ studentIds }` (caseload ids only; others are skipped)
   * or `{ scope: "roster-summary" }` (the whole caseload, up to 250). 409 drive_not_granted, 502 drive_failed.
   * The CSV and tokens are never logged or returned.
   */
  app.post(
    "/export/drive",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("account:export-drive", 10, 3600)] },
    async (request) => {
      const body = driveBody.parse(request.body);
      const me = request.auth.userId;
      let ids: string[];
      if ("studentIds" in body) {
        ids = splitByCaseload(body.studentIds, await visibleAmong(request, body.studentIds), me).allowed;
      } else {
        const caseload = await caseloadStudentIds(request);
        ids = caseload ? caseload.filter((id) => id !== me) : [];
        if (!caseload || ids.length > MAX_SUMMARY_STUDENTS) throw rosterTooLarge();
      }

      let rows: SummaryRow[] = [];
      if (ids.length) {
        const { data, error } = await request.db
          .from("profiles")
          .select("id, full_name, email, grad_year, archived_at")
          .in("id", ids)
          .eq("role", "student");
        if (error) throw fromPostgrest(error);
        const people = (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null; grad_year: string | number | null; archived_at: string | null }>;
        people.sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""));
        rows = await mapLimited(people, 4, async (p) => {
          const counts = await Promise.all(
            SUMMARY_COUNTS.map(async ([, table]) => {
              const r = await request.db.from(table).select("id", { count: "exact", head: true }).eq("student_id", p.id);
              if (r.error) throw fromPostgrest(r.error);
              return r.count ?? 0;
            })
          );
          const byKey = Object.fromEntries(SUMMARY_COUNTS.map(([key], i) => [key, counts[i]!])) as Record<(typeof SUMMARY_COUNTS)[number][0], number>;
          return {
            name: p.full_name,
            email: p.email,
            gradYear: p.grad_year === null ? null : String(p.grad_year),
            status: p.archived_at ? "archived" : "active",
            ...byKey,
          } satisfies SummaryRow;
        });
      }

      const title = sheetTitle();
      const { webViewLink } = await sheetClient().createSheet(me, { title, csv: rosterSummaryCsv(rows) }, request.log);
      // A student whose profile row the caller can't read (a shared student: profiles RLS is the primary
      // counselor's) isn't on the Sheet; say how many, so the app can tell the counselor.
      return { webViewLink, title, rows: rows.length, skipped: ids.length - rows.length };
    }
  );

  /**
   * Delete the caller's own account. A student's record goes with them (every
   * student table cascades from the profile). A counselor with students still
   * on their roster is refused: archive or hand off the roster first, so no
   * family's record disappears as a side effect.
   */
  app.delete("/", { preHandler: [app.authenticate, limit("account:delete", 3, 3600)], config: { allowPending: true } }, async (request, reply) => {
    const { confirm } = z.object({ confirm: z.string() }).strict().parse(request.body);
    if (confirm !== "delete my account") throw badRequest('Type "delete my account" to confirm');
    const svc = serviceClient();
    if (!svc) throw unavailable("Account deletion needs the service role key");
    const who = subjectOf(request);

    // In a firm, archived students count too: their meetings, notes and documents would go with this account, and
    // the firm can transfer them (Management, caseload transfer). A solo counselor may still archive and delete;
    // that gap is known (caseload transfer spec §12). The same rules gate a closure and its purge (lib/accountDeletion.ts).
    const block = await checkedBlocker(svc, who, request);
    if (block) throw blockError(block);

    try {
      await deleteAccount(who, request.log, "request");
    } catch (err) {
      if (!(err instanceof DeletionFailed)) throw err;
      throw unavailable("Couldn't delete the account right now. Try again shortly.");
    }
    return reply.code(204).send();
  });

  // ---- Leave Meridies: closing with a 30-day grace period (lib/accountClosure.ts) ----
  //
  // Counselors only, open to a pending account (it may leave too). Nothing is deleted or disconnected here: the
  // account keeps working, read and write and with its Google/Microsoft connections, until the purge, which runs only
  // with ACCOUNT_PURGE_ENABLED=true (and revokes the connections then). The closure row is read and written with the
  // service role keyed by the caller's verified id (clients have no write grant, and the approval gate hides the row
  // from a pending counselor's own client). GET's statuses: see ClosureView.

  const closureOpts = (bucket: string, max: number) => ({
    preHandler: [app.authenticate, requireRole("counselor"), limit(bucket, max, 3600)],
    config: { allowPending: true },
  });

  app.get("/closure", { preHandler: [app.authenticate, requireRole("counselor")], config: { allowPending: true } }, async (request) => {
    const svc = closureService();
    const row = await readClosure(svc, request.auth.userId);
    return closureView(row, new Date(), purgeFlag(env.ACCOUNT_PURGE_ENABLED));
  });

  /**
   * Ask to close the account. Body `{ confirm: "CLOSE" }`. The DELETE /account preconditions first (409 with their
   * code). A second request while one is pending answers it again (200, no new email). Otherwise (none, cancelled,
   * or on hold after the purge found a blocker) it starts a fresh 30 days (201): the row, a confirmation email to the
   * counselor and an audit row.
   */
  app.post("/closure", closureOpts("account:closure", 10), async (request, reply) => {
    const { confirm } = z.object({ confirm: z.string().max(40) }).strict().parse(request.body);
    if (confirm !== "CLOSE") throw badRequest('Type "CLOSE" to confirm');
    const svc = closureService();
    const me = request.auth.userId;
    const now = new Date();
    const enabled = purgeFlag(env.ACCOUNT_PURGE_ENABLED);

    const existing = await readClosure(svc, me);
    if (isActiveClosure(existing)) {
      return reply.code(200).send(closureView(existing, now, enabled));
    }

    const block = await checkedBlocker(svc, subjectOf(request), request);
    if (block) throw blockError(block);

    const fresh = { requested_at: now.toISOString(), purge_after: purgeAfterFrom(now).toISOString(), status: "pending", cancelled_at: null, last_error: null };
    let row: ClosureRow | null;
    if (existing) {
      // Cancelled, on hold (failed) or finished: start again with new dates. Conditional, so a racing request can't do it twice.
      const { data, error } = await svc.from("account_closures").update(fresh).eq("counselor_id", me).eq("status", existing.status).select(CLOSURE_COLUMNS).maybeSingle();
      if (error) throw closureDbError(error);
      row = data as ClosureRow | null;
    } else {
      const { data, error } = await svc.from("account_closures").insert({ counselor_id: me, ...fresh }).select(CLOSURE_COLUMNS).maybeSingle();
      if (error && error.code !== "23505") throw closureDbError(error);
      row = (data as ClosureRow | null) ?? null;
    }
    // Lost a race with a second request: answer the closure that one opened.
    if (!row) return reply.code(200).send(closureView(await readClosure(svc, me), now, enabled));

    await audit(svc, me, existing?.status === "failed" ? "account.closure.reopened" : "account.closure.requested", { purgeAfter: row.purge_after });
    await sendClosureEmail("requested", request, row.purge_after);
    return reply.code(201).send(closureView(row, now, enabled));
  });

  /**
   * Cancel the closure: the account stays open. 404 `no_closure` when none is open; 409 `closure_in_progress` while it
   * is being deleted, unless that run has been stuck in `purging` for PURGE_RECLAIM_MS (a crash), which may be cancelled.
   */
  app.delete("/closure", closureOpts("account:closure-cancel", 10), async (request) => {
    const svc = closureService();
    const me = request.auth.userId;
    const now = new Date();
    const existing = await readClosure(svc, me);
    if (!existing || !["pending", "failed", "purging"].includes(existing.status)) {
      throw new HttpError(404, "There is no account closure to cancel.", "no_closure");
    }
    const inProgress = () => new HttpError(409, "Your account is being closed right now and can't be cancelled.", "closure_in_progress");
    if (existing.status === "purging" && !isStalePurging(existing, now)) throw inProgress();
    // Conditional on the row as read (status and updated_at), so a purge that claims it in between wins.
    let q = svc
      .from("account_closures")
      .update({ status: "cancelled", cancelled_at: now.toISOString(), last_error: null })
      .eq("counselor_id", me)
      .eq("status", existing.status);
    if (existing.updated_at) q = q.eq("updated_at", existing.updated_at);
    const { data, error } = await q.select("counselor_id");
    if (error) throw closureDbError(error);
    if (!data?.length) throw inProgress();
    await audit(svc, me, "account.closure.cancelled", {});
    await sendClosureEmail("cancelled", request, existing.status === "failed" ? null : existing.purge_after);
    return closureView(null, now, purgeFlag(env.ACCOUNT_PURGE_ENABLED));
  });
}

const CLOSURE_COLUMNS = "status, requested_at, purge_after, last_error, updated_at";

const subjectOf = (request: FastifyRequest): DeletionSubject => ({
  id: request.auth.userId,
  role: request.profile.role,
  firm_id: (request.profile.firm_id as string | null | undefined) ?? null,
});

/** The shared preconditions; a read that fails is a 503, never a guess either way. */
async function checkedBlocker(svc: SupabaseClient, who: DeletionSubject, request: FastifyRequest) {
  try {
    return await deletionBlocker(svc, who);
  } catch (err) {
    request.log.error({ err: err instanceof Error ? err.message : String(err) }, "account deletion: precondition check failed");
    throw unavailable("Couldn't check your account right now. Try again shortly.");
  }
}

const closureUnavailable = () => new HttpError(503, "Closing an account isn't switched on yet.", "account_closure_unavailable");

function closureService(): SupabaseClient {
  const svc = serviceClient();
  if (!svc) throw closureUnavailable();
  return svc;
}

function closureDbError(error: { code?: string; message?: string }): HttpError {
  return isClosureTableMissing(error) ? closureUnavailable() : fromPostgrest(error);
}

async function readClosure(svc: SupabaseClient, me: string): Promise<ClosureRow | null> {
  const { data, error } = await svc.from("account_closures").select(CLOSURE_COLUMNS).eq("counselor_id", me).maybeSingle();
  if (error) throw closureDbError(error);
  return (data as ClosureRow | null) ?? null;
}

async function audit(svc: SupabaseClient, me: string, action: string, metadata: Record<string, unknown>) {
  await svc.from("audit_log").insert({ actor_id: me, action, entity_type: "profile", entity_id: me, metadata });
}

/** To the counselor's sign-in email only. Never fails the request: the delivery row records what happened. */
async function sendClosureEmail(kind: "requested" | "cancelled", request: FastifyRequest, purgeAfter: string | null) {
  const to = request.profile.email as string | null | undefined;
  if (!to) return;
  const m = closureEmail(kind, { purgeAfter, timeZone: (request.profile.timezone as string | null | undefined) ?? null, appUrl: env.APP_URL });
  await sendEmail({ to, subject: m.subject, html: m.html, text: m.text, template: m.template, recipient_kind: "counselor", recipient_id: request.auth.userId, logger: request.log }).catch(
    (err) => request.log.warn({ template: m.template, err: err instanceof Error ? err.message : String(err) }, "account closure email failed")
  );
}
