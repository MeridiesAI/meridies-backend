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
 *
 * Exports read through the caller's RLS-bound client, so each one contains
 * exactly what that person may already see (a student's export can't include
 * their counselor's private notes; the counselor's can). Operational logs
 * (ai_runs, audit_log) are not part of anyone's record.
 */

import { forgetUser } from "../lib/aiBudget.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, conflict, fromPostgrest, HttpError, unavailable } from "../lib/errors.js";
import { caseloadStudentIds, requireRole, resolveStudentId } from "../lib/guards.js";
import { forgetAxisTrash } from "../lib/axisTrash.js";
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
    const me = request.auth.userId;
    const svc = serviceClient();
    if (!svc) throw unavailable("Account deletion needs the service role key");

    if (request.profile.role === "counselor") {
      // In a firm, archived students count too: their meetings, notes and
      // documents would go with this account, and the firm can transfer them
      // (Management, caseload transfer). A solo counselor may still archive
      // and delete; that gap is known (caseload transfer spec §12).
      const inFirm = Boolean(request.profile.firm_id);
      let roster = svc.from("profiles").select("id", { count: "exact", head: true }).eq("counselor_id", me);
      if (!inFirm) roster = roster.is("archived_at", null);
      const { count, error } = await roster;
      if (error) throw fromPostgrest(error);
      if ((count ?? 0) > 0) {
        const students = `${count} student${count === 1 ? "" : "s"}`;
        throw conflict(
          inFirm
            ? `You still have ${students} on your caseload. Ask a firm owner or admin to transfer them (Management › Transfer caseload).`
            : `You still have ${students} on your roster. Archive them or hand them to a colleague first.`
        );
      }
      const { data: firm } = await svc.from("firms").select("id").eq("owner_id", me).maybeSingle();
      if (firm) throw conflict("You own a firm. Hand ownership to someone else before deleting your account.");
    }

    // The AxIS trash it made and the trash about it, with the files it kept (the cascade can't reach a row that
    // only names the account, or remove a Storage object). Refused rather than leave them behind.
    try {
      await forgetAxisTrash(me, request.log);
    } catch (err) {
      request.log.error({ err }, "account delete: axis trash cleanup failed");
      throw unavailable("Couldn't delete the account right now. Try again shortly.");
    }
    await svc.from("audit_log").insert({ actor_id: null, action: "account.deleted", entity_type: "profile", entity_id: me, metadata: { role: request.profile.role } });
    // The account's AI budget counters (numbers keyed by its id) go too. Best effort: never what stops a deletion.
    await forgetUser(me).catch((err) => request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "AI budget rows not removed"));
    const { error } = await svc.auth.admin.deleteUser(me);
    if (error) {
      request.log.error({ status: error.status }, "account delete failed");
      throw unavailable("Couldn't delete the account right now. Try again shortly.");
    }
    return reply.code(204).send();
  });
}
