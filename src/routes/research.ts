import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCanViewStudent, requireRole } from "../lib/guards.js";
import { fromPostgrest } from "../lib/errors.js";
import { limit } from "../lib/limits.js";
import { acceptRecommendation, dismissRecommendation } from "../lib/research/accept.js";
import { REC_COLUMNS, runResearch, toDto, withRepeats } from "../lib/research/run.js";

const studentParam = z.object({ id: z.string().uuid() });
const researchParams = z.object({ id: z.string().uuid(), feature: z.enum(["college-list", "activities"]) });
const recParam = z.object({ id: z.string().uuid() });
const researchBody = z.object({ refresh: z.boolean().optional(), focus: z.string().max(2000).optional() }).strict();
const listQuery = z.object({ feature: z.enum(["college_list", "activities"]).optional() }).strict();

/** Research for a student's college list or activities, and the recommendations it leaves (counselor only). */
export default async function researchRoutes(app: FastifyInstance) {
  const counselor = [app.authenticate, requireRole("counselor")];

  app.post(
    "/students/:id/research/:feature",
    { preHandler: [...counselor, limit("research:run", 5, 60)] },
    async (request) => {
      const { id, feature } = researchParams.parse(request.params);
      const body = researchBody.parse(request.body ?? {});
      return runResearch(request, id, feature === "college-list" ? "college_list" : "activities", {
        refresh: body.refresh === true,
        focus: body.focus ?? null,
      });
    }
  );

  app.get(
    "/students/:id/recommendations",
    { preHandler: [...counselor, limit("recommendations", 120, 60)] },
    async (request) => {
      const { id } = studentParam.parse(request.params);
      const { feature } = listQuery.parse(request.query);
      await assertCanViewStudent(request, id);
      let q = request.db.from("recommendations").select(REC_COLUMNS).eq("student_id", id);
      if (feature) q = q.eq("feature", feature);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
      if (error) throw fromPostgrest(error);
      return withRepeats(request, id, (data ?? []).map((r) => toDto(r as Record<string, unknown>)));
    }
  );

  app.post(
    "/recommendations/:id/accept",
    { preHandler: [...counselor, limit("recommendations", 120, 60)] },
    async (request) => acceptRecommendation(request, recParam.parse(request.params).id)
  );

  app.post(
    "/recommendations/:id/dismiss",
    { preHandler: [...counselor, limit("recommendations", 120, 60)] },
    async (request) => dismissRecommendation(request, recParam.parse(request.params).id)
  );
}
