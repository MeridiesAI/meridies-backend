/**
 * POST /me/intake/fill: AI help for the questionnaire's tables.
 *
 * The student (or their counselor, filling the questionnaire with them) types
 * what they took or adds a photo of a schedule or transcript; the answer is
 * proposed rows for one table, cleaned and mapped onto the table's own
 * options by lib/intakeFill.ts. Nothing is stored: the rows go into the table
 * for the student to check, and the questionnaire's normal save stores them.
 *
 * FAST_MODEL through runStructured (quota, the ai_runs audit, safe errors),
 * module `intake-fill` (20261105000005 adds the label; before it the audit
 * row is skipped and the request still works). 15 a minute per user on the
 * DB-backed limiter. The body may carry a picture, so this one route takes up
 * to 8 MB; the picture itself is capped at 5 MB decoded and checked by its
 * first bytes.
 */

import type { FastifyInstance } from "fastify";
import { hasAnthropic } from "../env.js";
import { FAST_MODEL, runStructured } from "../lib/anthropic.js";
import { badRequest, forbidden, unavailable } from "../lib/errors.js";
import { limit } from "../lib/limits.js";
import {
  FILL_SCHEMAS,
  checkFillImage,
  fillPrompt,
  fillSystem,
  intakeFillBody,
  normalizeFill,
  type FillRows,
} from "../lib/intakeFill.js";

const BODY_LIMIT = 8 * 1024 * 1024;

export default async function intakeFillRoutes(app: FastifyInstance) {
  app.post(
    "/me/intake/fill",
    {
      bodyLimit: BODY_LIMIT,
      preHandler: [app.authenticate, limit("ai:intake-fill", 15, 60, "That's a lot of requests. Give it a minute.")],
    },
    async (request) => {
      const role = request.profile.role;
      if (role !== "student" && role !== "counselor") throw forbidden();
      const parsed = intakeFillBody.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? "That request couldn't be read");
      }
      const body = parsed.data;
      if (!hasAnthropic) throw unavailable("AI help isn't switched on yet.");

      let image: ReturnType<typeof checkFillImage> | null = null;
      if (body.image) {
        try {
          image = checkFillImage(body.image);
        } catch (err) {
          throw badRequest(err instanceof Error ? err.message : "That picture couldn't be read.");
        }
      }

      const rows = await runStructured<FillRows>({
        request,
        module: "intake-fill",
        // Only a student's own help is about a known record; a counselor may be
        // filling a questionnaire for someone not yet on file.
        studentId: role === "student" ? request.auth.userId : null,
        model: FAST_MODEL,
        system: fillSystem(body.section),
        prompt: fillPrompt(body.section, body.text, Boolean(image)),
        attachments: image ? [{ mediaType: image.mediaType, data: image.data }] : undefined,
        schema: FILL_SCHEMAS[body.section],
        toolName: "fill_rows",
        maxTokens: 4000,
        validate: (value) => normalizeFill(body.section, value),
      });

      return { section: body.section, rows };
    }
  );
}
