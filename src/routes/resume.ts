/**
 * Resume builder (migration 20261028000006), under /resume.
 *
 *   GET  /resume               the saved resume (a Consultant reads a student's with ?studentId=)
 *   PUT  /resume               save it: the student's own, or a Consultant who can edit the student (migration 20261127000002)

 *   POST /resume/import        an existing resume's lines sorted into the builder's document, nothing invented (lib/resumeImport.ts)
 *   POST /resume/polish        one entry's bullets rewritten, never adding a fact (lib/resumeDoc.ts)
 *   POST /resume/draft         bullets drafted from named activity entries (student only)
 *   POST /resume/adjust        suggested edits to the student's own resume file (lib/resumeAdjust.ts)
 *
 * The student and their Consultant build one resume together (last write wins: the app saves whole documents).
 * Drafting and Polish store nothing: the person chooses what to keep. See lib/resume.ts and lib/resumeDoc.ts for what
 * the model sees and what is checked.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasAnthropic } from "../env.js";
import { FAST_MODEL, runStructured } from "../lib/anthropic.js";
import { HttpError, badRequest, fromPostgrest, unavailable } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { assertAiAllowed, assertStudentAiTools } from "../lib/practiceSettings.js";
import { RESUME_DRAFT_SCHEMA, RESUME_DRAFT_SYSTEM, activityForPrompt, cleanDraft, draftBody } from "../lib/resume.js";
import { IMPORT_SCHEMA, IMPORT_SYSTEM, cleanImport, importBody, importPrompt } from "../lib/resumeImport.js";
import { POLISH_SCHEMA, POLISH_SYSTEM, cleanPolish, polishBody, polishPrompt, resumeSaveBody } from "../lib/resumeDoc.js";
import { serviceClient } from "../lib/supabase.js";
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

  /** The saved row as the app reads it. `updatedBy` is the editor's name (read after access was checked), else null. */
  async function savedResume(row: Row) {
    const updatedById = typeof row.updated_by === "string" ? row.updated_by : null;
    let updatedBy: { id: string; name: string } | null = null;
    if (updatedById) {
      const db = serviceClient();
      if (db) {
        const { data } = await db.from("profiles").select("full_name").eq("id", updatedById).maybeSingle();
        const name = typeof (data as Row | null)?.full_name === "string" ? String((data as Row).full_name).trim() : "";
        if (name) updatedBy = { id: updatedById, name };
      }
    }
    return {
      // A row saved before v2 has no format key: it opens as the general format, its old content left untouched.
      templateKey: typeof row.template_key === "string" ? row.template_key : "general",
      content: row.content,
      updatedAt: String(row.updated_at),
      updatedBy,
    };
  }

  const SAVED_COLUMNS = "template_key, content, updated_at, updated_by";

  app.get(
    "/",
    { preHandler: [app.authenticate, limit("resume:read", 120, 60)] },
    async (request) => {
      const q = z.object({ studentId: z.string().uuid().optional() }).strict().parse(request.query);
      const studentId = await resolveStudentId(request, q.studentId, "view");
      const { data, error } = await request.db
        .from("student_resumes")
        .select(SAVED_COLUMNS)
        .eq("student_id", studentId)
        .maybeSingle();
      if (error) {
        if (isResultsNotApplied(error)) throw unavailableResume();
        throw fromPostgrest(error);
      }
      if (!data) return { resume: null };
      return { resume: await savedResume(data as Row) };
    }
  );

  // The student saves their own; a Consultant who can edit the student saves theirs. RLS decides it again.
  app.put("/", { preHandler: [app.authenticate, limit("resume:write", 120, 60)] }, async (request) => {
    const q = z.object({ studentId: z.string().uuid().optional() }).strict().parse(request.query);
    const parsed = resumeSaveBody.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "That resume can't be saved");
    const studentId = await resolveStudentId(request, q.studentId, "edit");
    const { data, error } = await request.db
      .from("student_resumes")
      .upsert({ student_id: studentId, template_key: parsed.data.templateKey, content: parsed.data.content }, { onConflict: "student_id" })
      .select(SAVED_COLUMNS)
      .single();
    if (error) {
      if (isResultsNotApplied(error)) throw unavailableResume();
      throw fromPostgrest(error);
    }
    return { resume: await savedResume(data as Row) };
  });

  /**
   * Polish: one entry's bullets rewritten as action verb plus result. A student needs the practice's "Let students
   * use AI tools" switch (and the AI summaries one); a Consultant who can edit the student needs AI summaries.
   * Nothing private is sent: only the entry the caller typed, wrapped as untrusted data. Stores nothing.
   */
  app.post("/polish", { preHandler: [app.authenticate, limit("ai:resume-polish", 30, 60, "You're polishing very fast. Give it a minute.")] }, async (request) => {
    const q = z.object({ studentId: z.string().uuid().optional() }).strict().parse(request.query);
    const b = polishBody.parse(request.body);
    if (!hasAnthropic) throw unavailable("AI features aren't configured yet. Set ANTHROPIC_API_KEY.");
    const studentId = await resolveStudentId(request, q.studentId, "edit");
    await assertStudentAiTools(request);
    if (b.entry.bullets.every((x) => !x.trim())) throw badRequest("Add at least one bullet to polish first");

    const bullets = await runStructured({
      request,
      module: "resume",
      studentId,
      model: FAST_MODEL,
      system: POLISH_SYSTEM,
      prompt: polishPrompt(b.section, b.entry),
      toolName: "resume_polish",
      schema: POLISH_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 700,
      validate: (v) => cleanPolish(v, b.entry),
    });
    return { bullets };
  });

  /**
   * Import: the lines of the person's existing resume (with the edits they accepted in the Resume adjuster) sorted into
   * the builder's document. The model only sorts; every value it returns must be a piece of the resume's own text, and
   * a line it left out comes back in `unplaced` and in the document. Stores nothing: the app saves with PUT /resume.
   */
  app.post("/import", { preHandler: [app.authenticate, limit("ai:resume-import", 10, 3600, "Give it a minute before importing again.")] }, async (request) => {
    const q = z.object({ studentId: z.string().uuid().optional() }).strict().parse(request.query);
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "That resume can't be imported");
    if (!hasAnthropic) throw new HttpError(503, "Importing a resume isn't switched on yet", "resume_import_unavailable");
    const studentId = await resolveStudentId(request, q.studentId, "edit");
    await assertAiAllowed(request, "resume-adjust");
    const { lines } = parsed.data;
    const sorted = await runStructured({
      request,
      module: "resume-adjust",
      studentId,
      model: FAST_MODEL,
      system: IMPORT_SYSTEM,
      prompt: importPrompt(lines),
      toolName: "resume_import",
      schema: IMPORT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 6000,
      validate: (v) => cleanImport(v, lines),
    });
    return { templateKey: "general", content: sorted.content, unplaced: sorted.unplaced, dropped: sorted.dropped };
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
