/**
 * What a heartbeat is about must belong to the signed-in consultant.
 * Student-keyed tasks need edit access to the student; an essay needs edit
 * access to its student; a meeting must be the caller's own.
 */
import type { FastifyRequest } from "fastify";
import { forbidden, fromPostgrest, notFound } from "../errors.js";
import { resolveStudentId } from "../guards.js";
import type { TaskType } from "./types.js";

export async function assertOwnsSubject(
  request: FastifyRequest,
  taskType: TaskType,
  subjectId: string
): Promise<{ studentId: string }> {
  if (taskType === "essay_feedback") {
    const { data, error } = await request.db.from("essays").select("student_id").eq("id", subjectId).maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That essay doesn't exist");
    return { studentId: await resolveStudentId(request, String(data.student_id), "edit") };
  }
  if (taskType === "meeting") {
    const { data, error } = await request.db
      .from("meetings")
      .select("student_id, counselor_id")
      .eq("id", subjectId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That meeting doesn't exist");
    if (data.counselor_id !== request.auth.userId) throw forbidden("That meeting isn't yours");
    return { studentId: String(data.student_id) };
  }
  const { data, error } = await request.db.from("profiles").select("id").eq("id", subjectId).maybeSingle();
  if (error) throw fromPostgrest(error);
  if (!data) throw notFound("That student doesn't exist");
  return { studentId: await resolveStudentId(request, subjectId, "edit") };
}
