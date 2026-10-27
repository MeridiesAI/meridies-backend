/**
 * Time saved (monthly ROI report). Spec:
 * docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { fromPostgrest, unavailable, HttpError } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { serviceClient } from "../lib/supabase.js";
import { assertOwnsSubject } from "../lib/kpi/subjects.js";
import { KPI_SCHEMA_MISSING, TASK_TYPES } from "../lib/kpi/types.js";

const heartbeatBody = z.object({ taskType: z.enum(TASK_TYPES), subjectId: z.string().uuid() }).strict();

export const kpiUnavailable = () =>
  new HttpError(503, "Time saved isn't switched on yet", "kpi_unavailable");

export default async function kpiRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.post("/heartbeat", { preHandler: [...counselor, limit("kpi:heartbeat", 120, 60)] }, async (request, reply) => {
    const { taskType, subjectId } = heartbeatBody.parse(request.body);
    reply.code(202);
    if (env.KPI_TRACKING_ENABLED !== "true") return { tracked: false };
    await assertOwnsSubject(request, taskType, subjectId);
    const svc = serviceClient();
    if (!svc) throw unavailable("Time tracking needs the service role key");
    const { data, error } = await svc.rpc("kpi_heartbeat", {
      p_counselor: request.auth.userId,
      p_task_type: taskType,
      p_subject: subjectId,
    });
    if (error) {
      if (KPI_SCHEMA_MISSING.has(error.code ?? "")) throw kpiUnavailable();
      throw fromPostgrest(error);
    }
    return { tracked: true, result: String(data) };
  });
}
