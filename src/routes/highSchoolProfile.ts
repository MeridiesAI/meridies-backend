/**
 * POST /high-school-profile/find { studentId? }
 *
 * Finds the published school profile of a student's high school (the
 * student's own, or one a counselor can see). See lib/highSchoolProfile.ts.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { forbidden } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { findSchoolProfile } from "../lib/highSchoolProfile.js";

const body = z.object({ studentId: z.string().uuid().optional() }).strict();

export default async function highSchoolProfileRoutes(app: FastifyInstance) {
  app.post(
    "/find",
    {
      preHandler: [
        app.authenticate,
        limit("high-school-profile", 5, 3600, "That's a lot of lookups. Try again in an hour."),
      ],
    },
    async (request) => {
      const role = request.profile.role;
      if (role !== "student" && role !== "counselor") throw forbidden("Only counselors and students can do that");
      const b = body.parse(request.body ?? {});
      const studentId = await resolveStudentId(request, b.studentId, "view");
      return findSchoolProfile(request, studentId);
    }
  );
}
