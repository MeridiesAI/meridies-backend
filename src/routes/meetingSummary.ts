import type { FastifyInstance } from "fastify";
import { FAST_MODEL, runStructured } from "../lib/anthropic.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  cleanSummary,
  MEETING_SUMMARY_SYSTEM,
  MEETING_SUMMARY_TOOL,
  meetingSummaryBody,
  summaryPrompt,
} from "../lib/meetingSummary.js";

/**
 * POST /ai/meeting-summary: a draft only. It reads the text in the request and
 * nothing stored, and it writes nothing: the counselor files the summary
 * through /notes and turns action items into tasks through /tasks.
 */
export default async function meetingSummaryRoutes(app: FastifyInstance) {
  app.post(
    "/meeting-summary",
    {
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("ai:meeting-summary", 10, 60, "You're running AI tools very fast. Give it a minute."),
      ],
    },
    async (request) => {
      const b = meetingSummaryBody.parse(request.body);
      await resolveStudentId(request, b.studentId, "edit");

      const draft = await runStructured({
        request,
        module: "meeting-summary",
        studentId: b.studentId,
        model: FAST_MODEL,
        system: MEETING_SUMMARY_SYSTEM,
        prompt: summaryPrompt(b.rawNotes, b.meetingDate),
        toolName: "meeting_summary",
        schema: MEETING_SUMMARY_TOOL as unknown as Record<string, unknown>,
        maxTokens: 1200,
        validate: (value) => cleanSummary(value, b.rawNotes),
      });

      return { status: "draft" as const, ...draft };
    }
  );
}
