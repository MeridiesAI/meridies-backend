import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasAnthropic } from "../env.js";
import { FAST_MODEL, runStructured } from "../lib/anthropic.js";
import { estimatePromptTokens, reserve, settle } from "../lib/aiBudget.js";
import { readTranscriptFile } from "../lib/documentText.js";
import { HttpError, unavailable } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { enforceRateLimit, limit } from "../lib/limits.js";
import {
  cleanSummary,
  fakeSummaryCall,
  MEETING_SUMMARY_SYSTEM,
  MEETING_SUMMARY_TOOL,
  meetingSummaryFakeOn,
  parseSummaryBody,
  summarizeTranscript,
  summaryPrompt,
  type SummaryCall,
  type SummaryStep,
} from "../lib/meetingSummary.js";
import { assertAiAllowed } from "../lib/practiceSettings.js";
import { prepareTranscript, transcriptTooLong } from "../lib/transcript.js";

/**
 * A transcript (pasted, or a file as base64) needs more than the global 1 MB:
 * 600,000 characters of pasted text, or a 2 MB file. This route only.
 */
const BODY_LIMIT = 3 * 1024 * 1024;

/**
 * The test double stands in for the model call only. The AI budget gate still runs around it, as runStructured
 * does (reserve, then settle as unused: no model was reached), so the caps and the ceiling bite the same way.
 */
async function budgetedFake(request: FastifyRequest, step: SummaryStep): ReturnType<SummaryCall> {
  const hold = await reserve(
    { userId: request.auth.userId },
    {
      model: FAST_MODEL,
      maxOutputTokens: step.maxTokens,
      promptTokens: estimatePromptTokens({ system: step.system, messages: [{ role: "user", content: step.prompt }] }),
      module: "meeting-summary",
    },
    request.log
  );
  try {
    return await fakeSummaryCall(step);
  } finally {
    await settle(hold, "unused", request.log);
  }
}

/**
 * POST /ai/meeting-summary: a draft only. It reads the text in the request and
 * nothing stored, and it writes nothing: the counselor files the summary
 * through /notes and turns action items into tasks through /tasks.
 *
 * `kind: "transcript"` (optional; absent means notes, as before) takes a
 * meeting transcript, pasted in `rawNotes` or as `file`, cleans it
 * (lib/transcript.ts), and summarizes it in parts with one merge call. The
 * answer adds `transcript: { characters, parts, modelCalls, speakers }`.
 */
export default async function meetingSummaryRoutes(app: FastifyInstance) {
  app.post(
    "/meeting-summary",
    {
      bodyLimit: BODY_LIMIT,
      preHandler: [
        app.authenticate,
        requireRole("counselor"),
        limit("ai:meeting-summary", 10, 60, "You're running AI tools very fast. Give it a minute."),
      ],
    },
    async (request) => {
      const b = parseSummaryBody(request.body);
      await resolveStudentId(request, b.studentId, "edit");

      if (b.kind === "notes") {
        if (meetingSummaryFakeOn()) {
          await assertAiAllowed(request, "meeting-summary");
          const draft = await budgetedFake(request, {
            stage: "single",
            index: 1,
            total: 1,
            system: MEETING_SUMMARY_SYSTEM,
            prompt: summaryPrompt(b.rawNotes, b.meetingDate),
            maxTokens: 1200,
            source: b.rawNotes,
            validate: (value) => cleanSummary(value, b.rawNotes),
          });
          return { status: "draft" as const, ...draft };
        }
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

      let raw: string;
      if (b.file) {
        const read = readTranscriptFile(Buffer.from(b.file.data, "base64"), b.file.name, b.file.type ?? null);
        if (!read.ok) {
          if (read.reason === "too_large") throw transcriptTooLong();
          throw read.reason === "type"
            ? new HttpError(400, "Attach the meeting's transcript as a .vtt, .srt, .txt or .docx file.", "transcript_file_type")
            : new HttpError(400, "That file couldn't be read as a transcript. Try the .vtt or .txt export.", "transcript_unreadable");
        }
        raw = read.text;
      } else {
        raw = b.rawNotes ?? "";
      }
      const prepared = prepareTranscript(raw);

      // The practice's AI summaries switch, before any spend (runStructured checks it again on each call).
      await assertAiAllowed(request, "meeting-summary");
      const fake = meetingSummaryFakeOn();
      if (!fake && !hasAnthropic) throw unavailable("AI meeting summaries aren't switched on yet.");
      // A transcript is up to 16 model calls: at most 20 transcripts an hour per counselor.
      await enforceRateLimit(`ai:meeting-transcript:${request.auth.userId}`, 20, 3600, "That's a lot of transcripts in an hour. Give it a little while.");

      const call: SummaryCall = fake
        ? (step) => budgetedFake(request, step)
        : (step) =>
            runStructured({
              request,
              module: "meeting-summary",
              studentId: b.studentId,
              model: FAST_MODEL,
              system: step.system,
              prompt: step.prompt,
              toolName: "meeting_summary",
              schema: MEETING_SUMMARY_TOOL as unknown as Record<string, unknown>,
              maxTokens: step.maxTokens,
              validate: step.validate,
            });
      const { draft, calls } = await summarizeTranscript(prepared, { call, meetingDate: b.meetingDate });

      return {
        status: "draft" as const,
        ...draft,
        transcript: {
          characters: prepared.text.length,
          parts: prepared.chunks.length,
          modelCalls: calls,
          speakers: prepared.speakers,
        },
      };
    }
  );
}
