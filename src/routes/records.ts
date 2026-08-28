/**
 * The student record: activities, awards, courses, test scores, essays,
 * colleges, meeting notes, academics, and the stat polygon.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerCollection } from "../lib/collection.js";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  toActivity,
  toAward,
  toCollege,
  toEssay,
  toNote,
  toPolygonAxis,
} from "../lib/serialize.js";

const trimmed = (max: number) => z.string().trim().max(max);

const activityBody = z
  .object({
    name: trimmed(300).min(1),
    position: trimmed(200).optional(),
    organization: trimmed(200).optional(),
    category: trimmed(100).optional(),
    grade_levels: z.array(trimmed(20)).max(8).optional(),
    timing: z.array(trimmed(30)).max(8).optional(),
    hours_per_week: z.number().min(0).max(168).optional(),
    weeks_per_year: z.number().int().min(0).max(52).optional(),
    continuing: z.boolean().optional(),
    description: trimmed(2000).optional(),
    uc_description: trimmed(2000).optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
  })
  .partial({ name: true })
  .strict();

const awardBody = z
  .object({
    name: trimmed(300),
    level: trimmed(100).optional(),
    year: trimmed(20).optional(),
    uc_criteria: trimmed(500).optional(),
    uc_earned: trimmed(500).optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
  })
  .partial({ name: true })
  .strict();

const courseBody = z
  .object({
    name: trimmed(300),
    type: z.enum(["ap", "ib", "honors", "dual-enrollment", "college", "other"]).optional(),
    grade: trimmed(20).optional(),
    status: z.enum(["planned", "in-progress", "completed"]).optional(),
    school_year: trimmed(20).optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
  })
  .partial({ name: true })
  .strict();

const testScoreBody = z
  .object({
    exam: trimmed(200),
    kind: z.enum(["ap", "sat", "act", "ib", "toefl", "ielts", "other"]).optional(),
    score: trimmed(20).optional(),
    taken_on: z.string().date().optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
  })
  .partial({ exam: true })
  .strict();

const essayBody = z
  .object({
    title: trimmed(300),
    prompt: trimmed(2000).optional(),
    school: trimmed(200).optional(),
    body: z.string().max(60_000).optional(),
    word_count: z.number().int().min(0).max(100_000).optional(),
    word_limit: z.number().int().min(0).max(20_000).optional(),
    status: z.enum(["not-started", "drafting", "review", "final"]).optional(),
    due_date: z.string().date().optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
  })
  .partial({ title: true })
  .strict();

const collegeBody = z
  .object({
    name: trimmed(300),
    college_id: z.string().uuid().optional(),
    initials: trimmed(8).optional(),
    brand_color: trimmed(20).optional(),
    round: z.enum(["ED", "ED2", "EA", "REA", "RD", "rolling", "priority"]).optional(),
    fit: z.enum(["reach", "target", "likely"]).optional(),
    status: z
      .enum([
        "considering", "applying", "submitted", "accepted", "denied",
        "waitlisted", "deferred", "enrolled", "withdrawn",
      ])
      .optional(),
    binding: z.boolean().optional(),
    deadline: z.string().date().optional(),
    notes: trimmed(4000).optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
  })
  .partial({ name: true })
  .strict();

const noteBody = z
  .object({
    title: trimmed(300),
    meeting_date: z.string().date().optional(),
    summary: trimmed(4000).optional(),
    body: z.string().max(40_000).optional(),
    tags: z.array(trimmed(40)).max(20).optional(),
    visibility: z.enum(["private", "shared"]).optional(),
  })
  .partial({ title: true })
  .strict();

/**
 * Record that a draft moved. The accountability engine reads these rows to
 * decide whether a student has actually done anything since a red flag, so an
 * essay write that skips this is a student who looks stalled when they aren't.
 */
async function logEssayProgress(
  request: FastifyRequest,
  studentId: string,
  row: Record<string, unknown>,
  action: "insert" | "update"
) {
  const words = Number(row.word_count ?? 0);

  await request.db.from("progress_events").insert({
    student_id: studentId,
    entity_type: "essay",
    entity_id: row.id as string,
    event: action === "insert" ? "created" : "word-count-changed",
    word_count: words,
    actor_id: request.auth.userId,
  });

  await request.db
    .from("deliverables")
    .update({ current_words: words, last_activity_at: new Date().toISOString() })
    .eq("essay_id", row.id as string);
}

export default async function recordRoutes(app: FastifyInstance) {
  registerCollection(app, {
    path: "activities", table: "activities", body: activityBody, toDto: toActivity,
  });
  registerCollection(app, {
    path: "awards", table: "awards", body: awardBody, toDto: toAward,
  });
  registerCollection(app, {
    path: "courses", table: "courses", body: courseBody, toDto: (r) => r,
  });
  registerCollection(app, {
    path: "test-scores", table: "test_scores", body: testScoreBody, toDto: (r) => r,
  });
  registerCollection(app, {
    path: "essays", table: "essays", body: essayBody, toDto: toEssay,
    afterWrite: logEssayProgress,
  });
  registerCollection(app, {
    path: "student-colleges", table: "student_colleges", body: collegeBody, toDto: toCollege,
  });
  registerCollection(app, {
    path: "notes", table: "meeting_notes", body: noteBody, toDto: toNote,
    orderBy: { column: "meeting_date", ascending: false },
  });

  // ---- Academics (one row per student, so upsert rather than insert) -------

  const academicsBody = z
    .object({
      gpa_unweighted: z.number().min(0).max(10).nullable(),
      gpa_weighted: z.number().min(0).max(10).nullable(),
      gpa_scale: trimmed(20).nullable(),
      gpa_band: trimmed(40).nullable(),
      class_rank: trimmed(40).nullable(),
      class_rank_value: trimmed(40).nullable(),
      rigor_count: z.number().int().min(0).max(60).nullable(),
      rigor_subjects: z.array(trimmed(60)).max(30),
      rigor_context: trimmed(2000).nullable(),
      test_status: z
        .enum(["not-started", "prepping", "scheduled", "taken", "retaking", "test-optional"])
        .nullable(),
      sat_ebrw: z.number().int().min(200).max(800).nullable(),
      sat_math: z.number().int().min(200).max(800).nullable(),
      sat_superscore: z.number().int().min(400).max(1600).nullable(),
      act_composite: z.number().int().min(1).max(36).nullable(),
      planned_test_date: z.string().date().nullable(),
      test_prep_status: trimmed(200).nullable(),
      strength_areas: z.array(trimmed(60)).max(30),
      strength_subjects: z.array(trimmed(60)).max(30),
    })
    .partial()
    .strict();

  app.get("/academics", { preHandler: app.authenticate }, async (request) => {
    const query = z.object({ studentId: z.string().uuid().optional() }).parse(request.query);
    const student = await resolveStudentId(request, query.studentId, "view");

    const { data, error } = await request.db
      .from("student_academics")
      .select("*")
      .eq("student_id", student)
      .maybeSingle();

    if (error) throw fromPostgrest(error);
    return data ?? { student_id: student };
  });

  app.put(
    "/academics",
    { preHandler: [app.authenticate, limit("academics:put", 120, 60)] },
    async (request) => {
      const raw = request.body as { studentId?: string } & Record<string, unknown>;
      const { studentId, ...rest } = raw ?? {};
      const patch = academicsBody.parse(rest);
      const student = await resolveStudentId(request, studentId, "edit");

      const { data, error } = await request.db
        .from("student_academics")
        .upsert({ ...patch, student_id: student }, { onConflict: "student_id" })
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return data;
    }
  );

  // ---- Stat polygon --------------------------------------------------------

  app.get("/polygon", { preHandler: app.authenticate }, async (request) => {
    const query = z.object({ studentId: z.string().uuid().optional() }).parse(request.query);
    const student = await resolveStudentId(request, query.studentId, "view");

    // Seed the six defaults on first read so a fresh student still has a shape.
    await request.db.rpc("ensure_default_polygon_axes", { p_student: student });

    const { data, error } = await request.db
      .from("student_polygon_axes")
      .select("*")
      .eq("student_id", student)
      .order("sort_order");

    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toPolygonAxis(r as never));
  });

  const axisBody = z
    .object({
      studentId: z.string().uuid().optional(),
      key: z
        .string()
        .trim()
        .regex(/^[a-z0-9-]{1,40}$/, "Use lowercase letters, numbers and dashes"),
      label: trimmed(60).min(1),
      description: trimmed(300).optional(),
      maxScore: z.number().int().min(1).max(1000).optional(),
      manualScore: z.number().min(0).max(1000).nullable().optional(),
      note: trimmed(500).optional(),
      sortOrder: z.number().int().min(0).max(99).optional(),
    })
    .strict();

  /** Add a custom axis, or overwrite an existing one by key. */
  app.put(
    "/polygon/axes",
    { preHandler: [app.authenticate, limit("polygon:put", 120, 60)] },
    async (request) => {
      const b = axisBody.parse(request.body);
      const student = await resolveStudentId(request, b.studentId, "edit");

      const { data, error } = await request.db
        .from("student_polygon_axes")
        .upsert(
          {
            student_id: student,
            key: b.key,
            label: b.label,
            description: b.description ?? null,
            max_score: b.maxScore ?? 100,
            manual_score: b.manualScore ?? null,
            note: b.note ?? null,
            sort_order: b.sortOrder ?? 99,
            source: "custom",
            updated_by: request.auth.userId,
          },
          { onConflict: "student_id,key" }
        )
        .select("*")
        .single();

      if (error) throw fromPostgrest(error);
      return toPolygonAxis(data as never);
    }
  );

  /** Set (or clear) the counselor's manual score for one axis. */
  app.patch(
    "/polygon/axes/:id",
    { preHandler: [app.authenticate, limit("polygon:patch", 240, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z
        .object({
          manualScore: z.number().min(0).max(1000).nullable().optional(),
          label: trimmed(60).optional(),
          note: trimmed(500).optional(),
          sortOrder: z.number().int().min(0).max(99).optional(),
        })
        .strict()
        .parse(request.body);

      const { data: existing, error: readError } = await request.db
        .from("student_polygon_axes")
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (readError) throw fromPostgrest(readError);
      if (!existing) throw notFound();
      await resolveStudentId(request, existing.student_id as string, "edit");

      const update: Record<string, unknown> = { updated_by: request.auth.userId };
      if (b.manualScore !== undefined) update.manual_score = b.manualScore;
      if (b.label !== undefined) update.label = b.label;
      if (b.note !== undefined) update.note = b.note;
      if (b.sortOrder !== undefined) update.sort_order = b.sortOrder;

      const { data, error } = await request.db
        .from("student_polygon_axes")
        .update(update)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound();
      return toPolygonAxis(data as never);
    }
  );

  /** Custom axes only — the six defaults stay put. */
  app.delete(
    "/polygon/axes/:id",
    { preHandler: [app.authenticate, limit("polygon:delete", 60, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const { data: existing } = await request.db
        .from("student_polygon_axes")
        .select("student_id, source")
        .eq("id", id)
        .maybeSingle();
      if (!existing) throw notFound();
      await resolveStudentId(request, existing.student_id as string, "edit");
      if (existing.source !== "custom") {
        throw notFound("Default axes can't be removed — clear the score instead");
      }

      const { error } = await request.db.from("student_polygon_axes").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}
