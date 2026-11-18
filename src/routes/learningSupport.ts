/**
 * A student's private learning-support need (migration 20261127000003), under /students.
 *
 *   GET /students/:id/learning-support    { needLevel, notes }
 *   PUT /students/:id/learning-support    { needLevel, notes }
 *
 * SENSITIVE. Only the student's own Consultant reads or writes it. A student or a parent gets 403, never the data,
 * and the table has no policy for them either (RLS). It is not on the AI allowlist, so no AI feature reads it by
 * default, and it is in no data export. The list builder's Learning support filter uses `needLevel` only, and the
 * app sends it as a filter value: the notes never leave this route.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, fromPostgrest, notFound } from "../lib/errors.js";
import { assertCanEditStudent, requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";

type Row = Record<string, unknown>;

export const NEED_LEVELS = ["none", "standard", "enhanced", "comprehensive"] as const;
export const NOTES_MAX = 4000;

export const learningSupportBody = z
  .object({ needLevel: z.enum(NEED_LEVELS), notes: z.string().max(NOTES_MAX) })
  .strict();

const idParam = z.object({ id: z.string().uuid() }).strict();
const unavailableLearning = () => new HttpError(503, "Learning support isn't switched on yet", "learning_support_unavailable");

export default async function learningSupportRoutes(app: FastifyInstance) {
  const pre = [app.authenticate, requireRole("counselor")];

  /** The student must be on THIS Consultant's roster: the table's policy is the roster's, not a collaborator's. */
  async function ownStudent(request: FastifyRequest, studentId: string) {
    await assertCanEditStudent(request, studentId);
    const { data, error } = await request.db.from("profiles").select("counselor_id").eq("id", studentId).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data || (data as Row).counselor_id !== request.auth.userId) throw notFound("Student not found");
  }

  const dto = (row: Row | null) => ({
    needLevel: NEED_LEVELS.includes(row?.need_level as never) ? (row!.need_level as (typeof NEED_LEVELS)[number]) : "none",
    notes: typeof row?.notes === "string" ? row.notes : "",
  });

  app.get("/:id/learning-support", { preHandler: [...pre, limit("learning-support:read", 120, 60)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await ownStudent(request, id);
    const { data, error } = await request.db.from("student_learning_support").select("need_level, notes").eq("student_id", id).maybeSingle();
    if (error) {
      if (isResultsNotApplied(error)) throw unavailableLearning();
      throw fromPostgrest(error);
    }
    reply.header("Cache-Control", "no-store");
    return dto(data as Row | null);
  });

  app.put("/:id/learning-support", { preHandler: [...pre, limit("learning-support:write", 60, 60)] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = learningSupportBody.parse(request.body);
    await ownStudent(request, id);
    const { data, error } = await request.db
      .from("student_learning_support")
      .upsert({ student_id: id, need_level: b.needLevel, notes: b.notes.trim() || null, updated_by: request.auth.userId }, { onConflict: "student_id" })
      .select("need_level, notes")
      .single();
    if (error) {
      if (isResultsNotApplied(error)) throw unavailableLearning();
      throw fromPostgrest(error);
    }
    reply.header("Cache-Control", "no-store");
    return dto(data as Row);
  });
}
