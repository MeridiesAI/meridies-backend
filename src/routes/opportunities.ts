/**
 * Program & Opportunity Concierge — the review-and-send workflow.
 *
 * A match the AI produced starts at `counselor-review`. Nothing reaches the
 * student until a counselor approves and sends it, at which point the deadline
 * lands in the student's tracker too.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { escapeIlike } from "../lib/collegesV10.js";
import { limit } from "../lib/limits.js";

export default async function opportunityRoutes(app: FastifyInstance) {
  /** Shared catalog browse. */
  app.get("/catalog", { preHandler: [app.authenticate, limit("opportunities:catalog", 120, 60)] }, async (request) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        category: z.string().trim().max(40).optional(),
        gradeLevel: z.string().trim().max(10).optional(),
      })
      .parse(request.query);

    let builder = request.db.from("opportunities").select("*").eq("is_active", true);
    if (q.category) builder = builder.eq("category", q.category);
    if (q.gradeLevel) builder = builder.contains("grade_levels", [q.gradeLevel]);
    if (q.search) builder = builder.ilike("name", `%${escapeIlike(q.search)}%`);

    const { data, error } = await builder
      .order("deadline", { ascending: true, nullsFirst: false })
      .limit(100);

    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  app.get("/matches", { preHandler: [app.authenticate, limit("opportunities:matches", 240, 60)] }, async (request) => {
    const q = z
      .object({
        studentId: z.string().uuid().optional(),
        status: z.string().trim().max(30).optional(),
      })
      .parse(request.query);

    const student = await resolveStudentId(request, q.studentId, "view");

    let builder = request.db.from("opportunity_matches").select("*").eq("student_id", student);
    if (q.status) builder = builder.eq("status", q.status);

    const { data, error } = await builder
      .order("score", { ascending: false, nullsFirst: false })
      .order("deadline", { ascending: true, nullsFirst: false })
      .limit(200);

    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  app.get("/requests", { preHandler: [app.authenticate, limit("opportunities:requests", 240, 60)] }, async (request) => {
    const q = z.object({ studentId: z.string().uuid().optional() }).parse(request.query);
    const student = await resolveStudentId(request, q.studentId, "view");

    const { data, error } = await request.db
      .from("opportunity_requests")
      .select("*")
      .eq("student_id", student)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw fromPostgrest(error);
    return data ?? [];
  });

  app.patch(
    "/matches/:id",
    { preHandler: [app.authenticate, limit("opportunities:update", 240, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z
        .object({
          status: z
            .enum(["suggested", "counselor-review", "approved", "sent", "saved", "applied", "dismissed"])
            .optional(),
          whyFit: z.string().trim().max(500).optional(),
          summary: z.string().trim().max(500).optional(),
          deadline: z.string().date().nullable().optional(),
        })
        .strict()
        .parse(request.body);

      const { data: existing } = await request.db
        .from("opportunity_matches")
        .select("student_id, status")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound();

      const isStudent = request.profile.role === "student";
      if (isStudent) {
        // A student may only act on what's already been sent to them.
        if (existing.student_id !== request.auth.userId) throw notFound();
        if (!["saved", "applied", "dismissed"].includes(b.status ?? "")) {
          throw notFound("You can save, apply, or dismiss a recommendation");
        }
      } else {
        await resolveStudentId(request, existing.student_id as string, "edit");
      }

      const update: Record<string, unknown> = {};
      if (b.status) update.status = b.status;
      if (b.whyFit !== undefined) update.why_fit = b.whyFit;
      if (b.summary !== undefined) update.summary = b.summary;
      if (b.deadline !== undefined) update.deadline = b.deadline;
      if (!isStudent && (b.status === "approved" || b.status === "counselor-review")) {
        update.reviewed_by = request.auth.userId;
        update.reviewed_at = new Date().toISOString();
      }

      const { data, error } = await request.db
        .from("opportunity_matches")
        .update(update)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound();
      return data;
    }
  );

  /**
   * Send approved recommendations to the student: one notification, and a
   * deadline per recommendation that has one, so it shows up in the tracker
   * rather than only inside the module.
   */
  app.post(
    "/matches/send",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("opportunities:send", 60, 3600)],
    },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid(),
          matchIds: z.array(z.string().uuid()).min(1).max(25),
          note: z.string().trim().max(1000).optional(),
        })
        .strict()
        .parse(request.body);

      await resolveStudentId(request, b.studentId, "edit");

      const { data: matches, error } = await request.db
        .from("opportunity_matches")
        .select("*")
        .in("id", b.matchIds)
        .eq("student_id", b.studentId);

      if (error) throw fromPostgrest(error);
      if (!matches || matches.length === 0) throw notFound("Nothing to send");

      const now = new Date().toISOString();
      const sentIds: string[] = [];

      for (const match of matches) {
        let deadlineId: string | null = null;

        if (match.deadline) {
          const { data: deadline } = await request.db
            .from("deadlines")
            .insert({
              student_id: b.studentId,
              title: `Apply: ${match.name}`,
              type: "application",
              school: match.org ?? null,
              due_date: match.deadline,
              level: "upcoming",
              owner: "student",
              description: String(match.summary ?? ""),
              created_by: request.auth.userId,
            })
            .select("id")
            .single();
          deadlineId = deadline?.id ?? null;
        }

        await request.db
          .from("opportunity_matches")
          .update({
            status: "sent",
            sent_at: now,
            reviewed_by: request.auth.userId,
            reviewed_at: now,
            deadline_id: deadlineId,
          })
          .eq("id", match.id as string);

        sentIds.push(match.id as string);
      }

      await request.db.from("notifications").insert({
        recipient_id: b.studentId,
        student_id: b.studentId,
        kind: "opportunity",
        urgency: "normal",
        title:
          matches.length === 1
            ? `Your counselor recommended ${matches[0].name}`
            : `Your counselor sent ${matches.length} program recommendations`,
        body: b.note ?? "Open your dashboard to see why each one fits and how to apply.",
        href: "/dashboard/student/updates",
        created_by: request.auth.userId,
      });

      return { sent: sentIds.length };
    }
  );
}
