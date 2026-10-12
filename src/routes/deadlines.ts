/**
 * Deadline Command Center. A counselor's GET returns every deadline across
 * their whole roster in one call — the module renders all students at once, so
 * per-student fetching would be a request storm.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { toDeadline } from "../lib/serialize.js";

const deadlineBody = z
  .object({
    studentId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(300),
    school: z.string().trim().max(200).nullable().optional(),
    type: z.enum(["application", "essay", "test", "financial", "meeting", "document"]),
    dateLabel: z.string().trim().max(60).nullable().optional(),
    dueDate: z.string().date().nullable().optional(),
    level: z.enum(["overdue", "critical", "warning", "upcoming", "done"]).optional(),
    owner: z.enum(["counselor", "student"]).optional(),
    description: z.string().trim().max(2000).optional(),
    remindAt: z.string().datetime().nullable().optional(),
    studentCollegeId: z.string().uuid().nullable().optional(),
  })
  .strict();

const deadlinePatch = deadlineBody.partial().extend({ done: z.boolean().optional() }).strict();

function toRow(b: z.infer<typeof deadlinePatch>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (b.title !== undefined) row.title = b.title;
  if (b.school !== undefined) row.school = b.school;
  if (b.type !== undefined) row.type = b.type;
  if (b.dateLabel !== undefined) row.date_label = b.dateLabel;
  if (b.dueDate !== undefined) row.due_date = b.dueDate;
  if (b.level !== undefined) row.level = b.level;
  if (b.owner !== undefined) row.owner = b.owner;
  if (b.description !== undefined) row.description = b.description;
  if (b.remindAt !== undefined) row.remind_at = b.remindAt;
  if (b.studentCollegeId !== undefined) row.student_college_id = b.studentCollegeId;
  if (b.done !== undefined) {
    row.done = b.done;
    row.completed_at = b.done ? new Date().toISOString() : null;
    if (b.done) row.level = "done";
  }
  return row;
}

export default async function deadlineRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate, limit("deadlines:list", 240, 60)] }, async (request) => {
    const query = z
      .object({
        studentId: z.string().uuid().optional(),
        includeDone: z.enum(["true", "false"]).optional(),
      })
      .parse(request.query);

    let builder = request.db.from("deadlines").select("*");

    if (query.studentId || request.profile.role === "student") {
      const student = await resolveStudentId(request, query.studentId, "view");
      builder = builder.eq("student_id", student);
    }
    // Otherwise: no student filter. RLS already scopes a counselor to their own
    // roster, so this is the whole-roster view rather than an open query.

    if (query.includeDone !== "true") builder = builder.eq("done", false);

    const { data, error } = await builder
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(2000);

    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toDeadline(r as never));
  });

  app.post(
    "/",
    { preHandler: [app.authenticate, limit("deadlines:create", 120, 60)] },
    async (request, reply) => {
      const b = deadlineBody.parse(request.body);
      const student = await resolveStudentId(request, b.studentId, "edit");

      const { data, error } = await request.db
        .from("deadlines")
        .insert({ ...toRow(b), student_id: student, created_by: request.auth.userId })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return reply.code(201).send(toDeadline(data as never));
    }
  );

  app.patch(
    "/:id",
    { preHandler: [app.authenticate, limit("deadlines:update", 240, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = deadlinePatch.parse(request.body);

      const { data: existing } = await request.db
        .from("deadlines")
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound();
      await resolveStudentId(request, existing.student_id as string, "edit");

      const { data, error } = await request.db
        .from("deadlines")
        .update(toRow(b))
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound();
      return toDeadline(data as never);
    }
  );

  app.delete(
    "/:id",
    { preHandler: [app.authenticate, limit("deadlines:delete", 120, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const { data: existing } = await request.db
        .from("deadlines")
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound();
      await resolveStudentId(request, existing.student_id as string, "edit");

      const { error } = await request.db.from("deadlines").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}
