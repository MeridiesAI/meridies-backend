/**
 * The student record: activities, awards, courses, test scores, essays,
 * colleges, meeting notes, academics, and the stat polygon.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerCollection } from "../lib/collection.js";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { bucketHistory } from "../lib/polygonHistory.js";
import {
  toActivity,
  toAward,
  toCollege,
  toEssay,
  toEssayMark,
  toNote,
  toPolygonAxis,
  toPolygonHistoryPoint,
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
    // word_count is the database's (private.essays_set_word_count), never a client's.
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
    round: z.enum(["ED", "ED2", "EA", "REA", "SCEA", "RD", "rolling", "priority"]).optional(),
    fit: z.enum(["reach", "target", "likely"]).optional(),
    status: z
      .enum([
        "not-started", "in-progress", "submitted", "accepted", "denied",
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
      gpa_unweighted: z.number().min(0).max(110).nullable(),
      gpa_weighted: z.number().min(0).max(110).nullable(),
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

    // Seed the defaults on first read so a fresh student still has a shape.
    // Counselor only: the polygon is read-only for the student (RLS refuses it).
    if (request.profile.role === "counselor") {
      await request.db.rpc("ensure_default_polygon_axes", { p_student: student });
    }

    const { data, error } = await request.db
      .from("student_polygon_axes")
      .select("*")
      .eq("student_id", student)
      .order("sort_order");

    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toPolygonAxis(r as never));
  });

  /**
   * The growth history. Recorded by a trigger on the axes themselves, so it
   * reflects what actually moved rather than being modelled backwards from
   * today's shape — which means a new student legitimately has a short chart.
   */
  app.get(
    "/polygon/history",
    { preHandler: [app.authenticate, limit("polygon:history", 120, 60)] },
    async (request) => {
      const query = z
        .object({
          studentId: z.string().uuid().optional(),
          scale: z.enum(["weeks", "months", "years"]).optional(),
        })
        .parse(request.query);
      const student = await resolveStudentId(request, query.studentId, "view");
      const scale = query.scale ?? "months";

      const { data, error } = await request.db
        .from("polygon_axis_history")
        .select("*")
        .eq("student_id", student)
        .order("recorded_at", { ascending: true })
        .limit(2000);
      if (error) throw fromPostgrest(error);

      const points = (data ?? []).map((r) => toPolygonHistoryPoint(r as never));
      return {
        scale,
        points: bucketHistory(points, scale),
        // The raw readings too: a counselor asking "when did that change" wants
        // the reading, not the bucket it fell into.
        readings: points,
      };
    }
  );

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
    { preHandler: [app.authenticate, requireRole("counselor"), limit("polygon:put", 120, 60)] },
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
    { preHandler: [app.authenticate, requireRole("counselor"), limit("polygon:patch", 240, 60)] },
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
    { preHandler: [app.authenticate, requireRole("counselor"), limit("polygon:delete", 60, 60)] },
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

  // ---- Essay marks (two-dimensional review) --------------------------------
  //
  // Produced by POST /ai/essay-review, or written by hand. Commenting mode
  // reads them; editing mode accepts the ones that carry a replacement, and
  // only grammar marks ever do.

  app.get("/essays/:id/marks", { preHandler: app.authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = z
      .object({ status: z.enum(["open", "accepted", "rejected", "stale"]).optional() })
      .parse(request.query);

    const { data: essay } = await request.db
      .from("essays")
      .select("student_id")
      .eq("id", id)
      .maybeSingle();
    if (!essay) throw notFound("That essay isn't on file");
    await resolveStudentId(request, essay.student_id as string, "view");

    let builder = request.db.from("essay_marks").select("*").eq("essay_id", id);
    if (q.status) builder = builder.eq("status", q.status);

    const { data, error } = await builder.order("start_offset").limit(500);
    if (error) throw fromPostgrest(error);
    return (data ?? []).map((r) => toEssayMark(r as Record<string, unknown>));
  });

  /**
   * A counselor's own mark.
   *
   * The dimension rule still holds — a content mark carries no replacement —
   * because that is what keeps content edits out of the product. The tighter
   * filter applied to model output is not applied here: a counselor typing a
   * correction on their own student's draft is an editorial act, not the
   * product generating prose.
   */
  app.post(
    "/essays/:id/marks",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("marks:create", 240, 60)] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z
        .object({
          dimension: z.enum(["content", "grammar"]),
          severity: z.enum(["critical", "major", "minor", "suggestion"]).optional(),
          category: z.string().trim().max(60).optional(),
          startOffset: z.number().int().min(0),
          endOffset: z.number().int().min(0),
          comment: z.string().trim().min(1).max(240),
          suggestedReplacement: z.string().trim().max(200).nullable().optional(),
        })
        .strict()
        .parse(request.body);

      if (b.endOffset <= b.startOffset) throw badRequest("That selection is empty");

      const { data: essay } = await request.db
        .from("essays")
        .select("student_id, body")
        .eq("id", id)
        .maybeSingle();
      if (!essay) throw notFound("That essay isn't on file");
      await resolveStudentId(request, essay.student_id as string, "edit");

      const body = String(essay.body ?? "");
      const quoted = body.slice(b.startOffset, b.endOffset);
      if (!quoted.trim()) throw badRequest("That selection isn't in the draft");

      if (b.suggestedReplacement && b.dimension !== "grammar") {
        throw badRequest(
          "Replacement text is only for grammar and usage. Comment on content instead."
        );
      }

      const { data, error } = await request.db
        .from("essay_marks")
        .insert({
          student_id: essay.student_id,
          essay_id: id,
          dimension: b.dimension,
          severity: b.severity ?? "suggestion",
          category: b.category ?? null,
          start_offset: b.startOffset,
          end_offset: b.endOffset,
          quoted_text: quoted,
          comment: b.comment,
          suggested_replacement: b.suggestedReplacement ?? null,
          created_by: "counselor",
          author_id: request.auth.userId,
        })
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return reply.code(201).send(toEssayMark(data as Record<string, unknown>));
    }
  );

  /**
   * Accept or reject a mark. Accepting a grammar mark with a replacement is
   * editing mode: the span is spliced into the draft, and every other open mark
   * is re-anchored, because an applied edit moves every offset after it.
   *
   * If the draft has changed under the mark, nothing is written — the mark goes
   * 'stale' and the caller is told, rather than a correction landing in the
   * wrong place in a student's essay.
   */
  app.patch(
    "/essay-marks/:id",
    { preHandler: [app.authenticate, limit("marks:update", 240, 60)] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      // Only accept or reject: reopening an accepted mark would suggest the
      // applied edit could be taken back, and it can't be.
      const b = z
        .object({ status: z.enum(["accepted", "rejected"]) })
        .strict()
        .parse(request.body);

      const { data: mark } = await request.db
        .from("essay_marks")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (!mark) throw notFound("That mark isn't on file");
      await resolveStudentId(request, mark.student_id as string, "edit");

      const applies =
        b.status === "accepted" &&
        mark.dimension === "grammar" &&
        typeof mark.suggested_replacement === "string" &&
        mark.suggested_replacement.length > 0;

      if (!applies) {
        const { data, error } = await request.db
          .from("essay_marks")
          .update({ status: b.status })
          .eq("id", id)
          .select("*")
          .maybeSingle();
        if (error) throw fromPostgrest(error);
        if (!data) throw notFound();
        return toEssayMark(data as Record<string, unknown>);
      }

      const { data: essay } = await request.db
        .from("essays")
        .select("id, body, word_count")
        .eq("id", mark.essay_id as string)
        .maybeSingle();
      if (!essay) throw notFound("That essay isn't on file");

      const body = String(essay.body ?? "");
      const start = Number(mark.start_offset);
      const end = Number(mark.end_offset);
      const quoted = String(mark.quoted_text);

      if (body.slice(start, end) !== quoted) {
        await request.db.from("essay_marks").update({ status: "stale" }).eq("id", id);
        return reply
          .code(409)
          .send({ error: "The draft changed since this mark was made. Re-run the review." });
      }

      const replacement = String(mark.suggested_replacement);
      const next = body.slice(0, start) + replacement + body.slice(end);
      const delta = replacement.length - quoted.length;
      const wordCount = next.trim() ? next.trim().split(/\s+/).length : 0;

      const { error: essayError } = await request.db
        .from("essays")
        .update({ body: next, word_count: wordCount })
        .eq("id", essay.id as string);
      if (essayError) throw fromPostgrest(essayError);

      const { data: updated, error } = await request.db
        .from("essay_marks")
        .update({
          status: "accepted",
          applied_at: new Date().toISOString(),
          applied_by: request.auth.userId,
        })
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error) throw fromPostgrest(error);

      await reanchorMarks(request, essay.id as string, id, { start, end, delta });

      // Same bookkeeping an essay edit does, so accountability sees the change.
      await request.db.from("progress_events").insert({
        student_id: mark.student_id as string,
        entity_type: "essay",
        entity_id: essay.id as string,
        event: "edited",
        word_count: wordCount,
        actor_id: request.auth.userId,
        metadata: { appliedMark: id, dimension: "grammar" },
      });
      await request.db
        .from("deliverables")
        .update({ current_words: wordCount, last_activity_at: new Date().toISOString() })
        .eq("essay_id", essay.id as string);

      return toEssayMark(updated as Record<string, unknown>);
    }
  );

  app.delete(
    "/essay-marks/:id",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("marks:delete", 120, 60)] },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { data: mark } = await request.db
        .from("essay_marks")
        .select("student_id")
        .eq("id", id)
        .maybeSingle();
      if (!mark) throw notFound("That mark isn't on file");
      await resolveStudentId(request, mark.student_id as string, "edit");

      const { error } = await request.db.from("essay_marks").delete().eq("id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );
}

/**
 * An applied edit shifts every offset after it. Marks entirely past the edit
 * move by the delta; marks that overlap the edited span no longer describe what
 * they were written about, so they go 'stale' rather than pointing at text that
 * has changed underneath them.
 */
async function reanchorMarks(
  request: FastifyRequest,
  essayId: string,
  appliedMarkId: string,
  edit: { start: number; end: number; delta: number }
): Promise<void> {
  const { data: others } = await request.db
    .from("essay_marks")
    .select("id, start_offset, end_offset")
    .eq("essay_id", essayId)
    .eq("status", "open")
    .neq("id", appliedMarkId);

  for (const other of others ?? []) {
    const start = Number(other.start_offset);
    const end = Number(other.end_offset);

    if (start >= edit.end) {
      if (edit.delta === 0) continue;
      await request.db
        .from("essay_marks")
        .update({ start_offset: start + edit.delta, end_offset: end + edit.delta })
        .eq("id", other.id as string);
    } else if (end > edit.start) {
      await request.db.from("essay_marks").update({ status: "stale" }).eq("id", other.id as string);
    }
  }
}
