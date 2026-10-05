/**
 * Pinned students (demo v7, `lib/pins.ts`): per consultant, not firm-wide.
 * Two consultants sharing a roster each keep their own short list.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest } from "../lib/errors.js";
import { assertCanViewStudent, requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

const studentParam = z.object({ studentId: z.string().uuid("Not a valid student id") });

export default async function pinRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.get("/", { preHandler: [...counselor, limit("pins:list", 240, 60)] }, async (request) => {
    const { data, error } = await request.db
      .from("consultant_student_pins")
      .select("student_id, pinned_at")
      .eq("consultant_id", request.auth.userId)
      .order("pinned_at", { ascending: false })
      .limit(500);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => ({ studentId: String(r.student_id), pinnedAt: String(r.pinned_at) }));
  });

  app.put("/:studentId", { preHandler: [...counselor, limit("pins:write", 240, 60)] }, async (request) => {
    const { studentId } = studentParam.parse(request.params);
    await assertCanViewStudent(request, studentId);
    const { data, error } = await request.db
      .from("consultant_student_pins")
      .upsert(
        { consultant_id: request.auth.userId, student_id: studentId },
        { onConflict: "consultant_id,student_id", ignoreDuplicates: true }
      )
      .select("student_id, pinned_at")
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    return { studentId, pinned: true, pinnedAt: data ? String(data.pinned_at) : null };
  });

  app.delete("/:studentId", { preHandler: [...counselor, limit("pins:write", 240, 60)] }, async (request) => {
    const { studentId } = studentParam.parse(request.params);
    const { error } = await request.db
      .from("consultant_student_pins")
      .delete()
      .eq("consultant_id", request.auth.userId)
      .eq("student_id", studentId);
    if (error) throw fromPostgrest(error);
    return { studentId, pinned: false };
  });
}
