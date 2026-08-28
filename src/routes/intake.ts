/**
 * Intake: the counselor's schema overlay and the student's answers.
 *
 * The overlay used to live in localStorage, which meant it was per-browser and
 * invisible to the student filling the form out. It's a row now.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";

export default async function intakeRoutes(app: FastifyInstance) {
  /** A counselor gets their own overlay; a student gets their counselor's. */
  app.get("/config", { preHandler: app.authenticate }, async (request) => {
    const counselorId =
      request.profile.role === "counselor" ? request.auth.userId : request.profile.counselor_id;

    if (!counselorId) return { config: {}, name: "Default intake" };

    const { data, error } = await request.db
      .from("intake_configs")
      .select("id, name, config")
      .eq("counselor_id", counselorId)
      .eq("is_default", true)
      .maybeSingle();

    if (error) throw fromPostgrest(error);
    return data ?? { config: {}, name: "Default intake" };
  });

  app.put(
    "/config",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("intake:config", 60, 60)],
    },
    async (request) => {
      const b = z
        .object({
          name: z.string().trim().max(120).optional(),
          // Shape is validated on the client against the aggregator schema;
          // here we only bound the size so nobody parks a megabyte in a row.
          config: z.record(z.unknown()),
        })
        .strict()
        .parse(request.body);

      if (JSON.stringify(b.config).length > 200_000) {
        throw new Error("Intake configuration is too large");
      }

      const { data, error } = await request.db
        .from("intake_configs")
        .upsert(
          {
            counselor_id: request.auth.userId,
            name: b.name ?? "Default intake",
            is_default: true,
            config: b.config,
          },
          { onConflict: "counselor_id", ignoreDuplicates: false }
        )
        .select("id, name, config")
        .single();

      if (error) throw fromPostgrest(error);
      return data;
    }
  );

  app.get("/responses", { preHandler: app.authenticate }, async (request) => {
    const query = z.object({ studentId: z.string().uuid().optional() }).parse(request.query);
    const student = await resolveStudentId(request, query.studentId, "view");

    const { data, error } = await request.db
      .from("intake_responses")
      .select("*")
      .eq("student_id", student)
      .maybeSingle();

    if (error) throw fromPostgrest(error);
    return data ?? { student_id: student, answers: {}, completed_sections: [] };
  });

  /** Partial saves merge, so an autosave of one section can't drop the rest. */
  app.patch(
    "/responses",
    { preHandler: [app.authenticate, limit("intake:save", 240, 60)] },
    async (request) => {
      const b = z
        .object({
          studentId: z.string().uuid().optional(),
          answers: z.record(z.unknown()),
          completedSections: z.array(z.string().max(60)).max(50).optional(),
          submitted: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);

      const student = await resolveStudentId(request, b.studentId, "edit");

      const { data: existing } = await request.db
        .from("intake_responses")
        .select("answers, completed_sections")
        .eq("student_id", student)
        .maybeSingle();

      const merged = { ...((existing?.answers as object) ?? {}), ...b.answers };
      const sections = b.completedSections
        ? Array.from(new Set([...(existing?.completed_sections ?? []), ...b.completedSections]))
        : existing?.completed_sections;

      const { data, error } = await request.db
        .from("intake_responses")
        .upsert(
          {
            student_id: student,
            answers: merged,
            completed_sections: sections ?? [],
            submitted_at: b.submitted ? new Date().toISOString() : undefined,
          },
          { onConflict: "student_id" }
        )
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);

      await request.db.from("progress_events").insert({
        student_id: student,
        entity_type: "intake",
        event: "edited",
        actor_id: request.auth.userId,
      });

      return data;
    }
  );
}
