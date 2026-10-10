/**
 * Data export and account deletion (BACKEND_TODO §6).
 *
 *   GET    /account/export                  everything the caller can read about
 *                                           themselves (a student: their record;
 *                                           a counselor: their profile, roster and
 *                                           practice work)
 *   GET    /account/students/:id/export     one student's record, for their counselor
 *   DELETE /account                         delete the caller's own account
 *
 * Exports read through the caller's RLS-bound client, so each one contains
 * exactly what that person may already see (a student's export can't include
 * their counselor's private notes; the counselor's can). Operational logs
 * (ai_runs, audit_log) are not part of anyone's record.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, conflict, fromPostgrest, unavailable } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
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

const MAX_ROWS_PER_TABLE = 5000;

async function exportStudent(request: FastifyRequest, studentId: string) {
  const [profile, ...tables] = await Promise.all([
    request.db.from("profiles").select("*").eq("id", studentId).maybeSingle(),
    ...STUDENT_RECORD_TABLES.map((t) => request.db.from(t).select("*").eq("student_id", studentId).limit(MAX_ROWS_PER_TABLE)),
  ]);
  if (profile.error) throw fromPostgrest(profile.error);
  const records: Record<string, Row[]> = {};
  const skipped: string[] = [];
  tables.forEach((r, i) => {
    const name = STUDENT_RECORD_TABLES[i]!;
    // A table this caller can't read at all (RLS/grants) is left out, not an error.
    if (r.error) skipped.push(name);
    else if (r.data?.length) records[name] = r.data as Row[];
  });
  return { profile: profile.data, records, notIncluded: skipped };
}

export default async function accountRoutes(app: FastifyInstance) {
  app.get("/export", { preHandler: [app.authenticate, limit("account:export", 10, 3600)], config: { allowPending: true } }, async (request, reply) => {
    const me = request.auth.userId;
    reply.header("Content-Disposition", `attachment; filename="meridies-export-${new Date().toISOString().slice(0, 10)}.json"`);
    if (request.profile.role === "student") {
      return { exportedAt: new Date().toISOString(), kind: "student", ...(await exportStudent(request, me)) };
    }
    const own = async (table: string, column = "counselor_id") => {
      const { data, error } = await request.db.from(table).select("*").eq(column, me).limit(MAX_ROWS_PER_TABLE);
      return error ? null : (data as Row[]);
    };
    const [profile, roster, workItems, contacts, templates, resources, invitations] = await Promise.all([
      request.db.from("profiles").select("*").eq("id", me).maybeSingle(),
      request.db.from("profiles").select("id, full_name, email, profile, archived_at, created_at").eq("counselor_id", me).limit(MAX_ROWS_PER_TABLE),
      own("counselor_work_items"),
      own("pipeline_contacts"),
      own("email_templates"),
      own("library_resources"),
      own("invitations"),
    ]);
    if (profile.error) throw fromPostgrest(profile.error);
    if (roster.error) throw fromPostgrest(roster.error);
    return {
      exportedAt: new Date().toISOString(),
      kind: "counselor",
      profile: profile.data,
      roster: roster.data,
      practice: { workItems, contacts, emailTemplates: templates, resources, invitations },
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
      const { count, error } = await svc
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("counselor_id", me)
        .is("archived_at", null);
      if (error) throw fromPostgrest(error);
      if ((count ?? 0) > 0) throw conflict(`You still have ${count} student${count === 1 ? "" : "s"} on your roster. Archive them or hand them to a colleague first.`);
      const { data: firm } = await svc.from("firms").select("id").eq("owner_id", me).maybeSingle();
      if (firm) throw conflict("You own a firm. Hand ownership to someone else before deleting your account.");
    }

    await svc.from("audit_log").insert({ actor_id: null, action: "account.deleted", entity_type: "profile", entity_id: me, metadata: { role: request.profile.role } });
    const { error } = await svc.auth.admin.deleteUser(me);
    if (error) {
      request.log.error({ status: error.status }, "account delete failed");
      throw unavailable("Couldn't delete the account right now. Try again shortly.");
    }
    return reply.code(204).send();
  });
}
