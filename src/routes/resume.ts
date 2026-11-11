/**
 * Resume builder (migration 20261028000006), under /resume.
 *
 *   GET  /resume               the student's saved resume (a counselor reads one with ?studentId=)
 *   PUT  /resume               save it (student only)
 *   POST /resume/draft         bullets drafted from named activity entries (student only)
 *   POST /resume/adjust        suggested edits to the student's own resume file (lib/resumeAdjust.ts)
 *
 * The student builds and keeps their own resume; the counselor who can see
 * the student reads it. Drafting stores nothing: the student chooses what to
 * keep. See lib/resume.ts for what the model sees and what is checked.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasAnthropic } from "../env.js";
import { FAST_MODEL, runStructured } from "../lib/anthropic.js";
import { HttpError, badRequest, fromPostgrest, unavailable } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { assertAiAllowed } from "../lib/practiceSettings.js";
import {
  RESUME_DRAFT_SCHEMA,
  RESUME_DRAFT_SYSTEM,
  activityForPrompt,
  cleanDraft,
  draftBody,
  resumeBody,
} from "../lib/resume.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
import { canReadStoredText, readStoredText } from "../lib/applicationText.js";
import { documentReadableForTask, toAiDoc } from "../lib/context/documentAi.js";
import {
  MAX_RESUME_CHARS,
  RESUME_ADJUST_SCHEMA,
  RESUME_ADJUST_SYSTEM,
  adjustBody,
  adjustPrompt,
  cleanSuggestions,
  resumeLines,
  sheetFacts,
} from "../lib/resumeAdjust.js";

type Row = Record<string, unknown>;

const unavailableResume = () => new HttpError(503, "The resume builder isn't switched on yet", "resume_unavailable");

export default async function resumeRoutes(app: FastifyInstance) {
  const student = [app.authenticate, requireRole("student")];
  const aiLimit = limit("ai:resume", 20, 60, "You're drafting very fast. Give it a minute.");

  app.get(
    "/",
    { preHandler: [app.authenticate, limit("resume:read", 120, 60)] },
    async (request) => {
      const q = z.object({ studentId: z.string().uuid().optional() }).strict().parse(request.query);
      const studentId = await resolveStudentId(request, q.studentId, "view");
      const { data, error } = await request.db
        .from("student_resumes")
        .select("template, content, updated_at")
        .eq("student_id", studentId)
        .maybeSingle();
      if (error) {
        if (isResultsNotApplied(error)) throw unavailableResume();
        throw fromPostgrest(error);
      }
      if (!data) return { resume: null };
      const row = data as Row;
      return { resume: { template: String(row.template), content: row.content, updatedAt: String(row.updated_at) } };
    }
  );

  app.put("/", { preHandler: [...student, limit("resume:write", 120, 60)] }, async (request) => {
    const b = resumeBody.parse(request.body);
    const { data, error } = await request.db
      .from("student_resumes")
      .upsert({ student_id: request.auth.userId, template: b.template, content: b.content }, { onConflict: "student_id" })
      .select("template, content, updated_at")
      .single();
    if (error) {
      if (isResultsNotApplied(error)) throw unavailableResume();
      throw fromPostgrest(error);
    }
    const row = data as Row;
    return { resume: { template: String(row.template), content: row.content, updatedAt: String(row.updated_at) } };
  });

  app.post("/draft", { preHandler: [...student, aiLimit] }, async (request) => {
    const b = draftBody.parse(request.body);
    if (!hasAnthropic) throw unavailable("AI features aren't configured yet. Set ANTHROPIC_API_KEY.");
    const studentId = request.auth.userId;
    const ids = [...new Set(b.activityIds)];

    // The entries come from the student's own record, never from the request.
    const { data, error } = await request.db
      .from("activities")
      .select("id, organization, position, description, hours_per_week, weeks_per_year, grade_levels")
      .eq("student_id", studentId)
      .in("id", ids);
    if (error) throw fromPostgrest(error);
    const entries = (data ?? []) as Row[];
    if (entries.length === 0) throw badRequest("Pick activities from your list first");

    const out = await runStructured({
      request,
      module: "resume",
      studentId,
      model: FAST_MODEL,
      system: RESUME_DRAFT_SYSTEM,
      prompt: entries.map(activityForPrompt).join("\n\n"),
      toolName: "resume_bullets",
      schema: RESUME_DRAFT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 900,
      validate: (v) => ({ items: cleanDraft(v, entries) }),
    });
    return out;
  });

  /**
   * Resume adjuster: suggested edits to the resume the student already has
   * (a file in their documents). The student, or a counselor who can edit
   * them. Reads the file on the caller's client; stores nothing.
   */
  app.post("/adjust", { preHandler: [app.authenticate, limit("ai:resume-adjust", 10, 60, "Give it a minute before asking again.")] }, async (request) => {
    const b = adjustBody.parse(request.body);
    if (!hasAnthropic) throw new HttpError(503, "The Resume adjuster isn't switched on yet", "resume_adjust_unavailable");
    const studentId = await resolveStudentId(request, b.studentId, "edit");
    await assertAiAllowed(request, "resume-adjust");

    const { data: doc, error: docError } = await request.db.from("documents").select("*").eq("id", b.documentId).maybeSingle();
    if (docError) throw fromPostgrest(docError);
    if (!doc || doc.student_id !== studentId) throw badRequest("Pick a resume from this student's documents");
    const row = doc as Row;
    if (!canReadStoredText(String(row.filename ?? ""), (row.mime_type as string | null) ?? null)) {
      throw badRequest("Upload the resume as a PDF or Word (.docx) file.");
    }
    const rule = documentReadableForTask(toAiDoc(row), true);
    if (!rule.allowed) {
      throw new HttpError(409, rule.reason === "not-categorized" ? "Choose a type for this file first." : "This file is kept out of AI.", "resume_not_readable");
    }

    const text = await readStoredText(request, row);
    if (!text) throw badRequest("Couldn't read the text in that file. A scanned resume has no text to read; upload the original PDF or Word file.");
    if (text.length > MAX_RESUME_CHARS) throw badRequest("That file is too long to be a resume.");
    const lines = resumeLines(text);

    const [acts, hons] = await Promise.all([
      request.db.from("activities").select("organization, name, position, category, description, hours_per_week, weeks_per_year, grade_levels").eq("student_id", studentId).order("sort_order").limit(30),
      request.db.from("awards").select("name, recognition_levels, grade_levels").eq("student_id", studentId).order("sort_order").limit(30),
    ]);
    const facts = sheetFacts((acts.data ?? []) as Row[], (hons.data ?? []) as Row[]);

    const suggestions = await runStructured({
      request,
      module: "resume-adjust",
      studentId,
      model: FAST_MODEL,
      system: RESUME_ADJUST_SYSTEM,
      prompt: adjustPrompt(lines, facts),
      toolName: "resume_edits",
      schema: RESUME_ADJUST_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2500,
      validate: (v) => cleanSuggestions(v, lines, facts),
    });
    return { lines, suggestions };
  });
}
