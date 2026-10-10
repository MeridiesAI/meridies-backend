import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildStudentContext } from "../lib/context/index.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

const params = z.object({ id: z.string().uuid() });
const query = z.object({ feature: z.enum(["chat", "student-ai", "narrative-coherence", "college-list", "activities"]).default("chat") }).strict();

/** What AxIS would see for this student and feature — counselor transparency and tests. */
export default async function aiContextRoutes(app: FastifyInstance) {
  app.get("/:id/ai-context", { preHandler: [app.authenticate, requireRole("counselor"), limit("ai-context:read", 60, 60)] }, async (request) => {
    const { id } = params.parse(request.params);
    const { feature } = query.parse(request.query);
    const c = await buildStudentContext(request, id, feature);
    return { text: c.text, used: c.used, omitted: c.omitted };
  });
}
