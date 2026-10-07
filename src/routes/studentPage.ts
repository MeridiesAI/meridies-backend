/**
 * The student page (demo v8-v10), under `/student-page/:id`.
 *
 *   GET   /:id/info                 the info card: contact, personal details, academics
 *   PATCH /:id/info                 one or more values, saved where they live
 *   GET   /:id/polygon              the visible axes (derived scores refreshed) + hidden ones
 *   POST  /:id/polygon/axes         add a custom axis (max ten visible)
 *   PATCH /:id/polygon/axes/:axisId score, rename, hide/show
 *   DELETE /:id/polygon/axes/:axisId custom: delete; default: hide
 *   POST  /:id/polygon/reset        back to the derived shape
 *   GET   /:id/polygon/years        freshman-to-now, from recorded history
 *   GET   /:id/note                 the counselor's "Add notes" box (counselor-only)
 *   PUT   /:id/note                 save it as they type
 *
 * Every route authorizes in code (resolveStudentId) and runs on the caller's
 * RLS-bound client, so RLS is the backstop. The student may read and edit
 * their own info card (but not their parent's contact details). The polygon
 * is read-only for the student (SV Demo v2): they read it and its history,
 * and every axis write is counselor-only here and in RLS. The status
 * override is counselor-only and stays on `PUT /students/:id/status`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { assertCanEditStudent, assertCanViewStudent, requireRole, resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  applyInfoPatch,
  axisKeyFor,
  infoPatchSchema,
  loadPolygon,
  loadPolygonYears,
  loadStudentInfo,
  MAX_AXES,
} from "../lib/studentPage.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid("Not a valid student id") });
const axisParams = idParam.extend({ axisId: z.string().uuid() });

const noteBody = z.object({ body: z.string().max(4000) }).strict();

const addAxisBody = z
  .object({
    label: z.string().trim().min(1).max(60),
    score: z.number().min(0).max(100).optional(),
  })
  .strict();

const patchAxisBody = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    /** null clears the counselor's score and restores the derived one. */
    score: z.number().min(0).max(100).nullable().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

export default async function studentPageRoutes(app: FastifyInstance) {
  // ---- Info card ------------------------------------------------------------

  app.get("/:id/info", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);
    const student = await resolveStudentId(request, id, "view");
    const info = await loadStudentInfo(request.db, student);
    if (!info) throw notFound("That student isn't on your roster");
    return info;
  });

  app.patch(
    "/:id/info",
    { preHandler: [app.authenticate, limit("student-page:info", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const patch = infoPatchSchema.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
      const student = await resolveStudentId(request, id, "edit");
      return applyInfoPatch(request, student, patch);
    }
  );

  // ---- The counselor's note ------------------------------------------------------
  // Counselor-only both ways (student_private_notes RLS): it is the counselor's
  // own working note about the student, not a record the student owns.

  app.get(
    "/:id/note",
    { preHandler: [app.authenticate, requireRole("counselor")] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await assertCanViewStudent(request, id);
      const { data, error } = await request.db
        .from("student_private_notes")
        .select("body, updated_at")
        .eq("student_id", id)
        .maybeSingle();
      if (error) throw fromPostgrest(error);
      return { body: (data?.body as string | undefined) ?? "", updatedAt: (data?.updated_at as string | undefined) ?? null };
    }
  );

  app.put(
    "/:id/note",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("student-page:note", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { body } = noteBody.parse(request.body);
      await assertCanEditStudent(request, id);
      const { data, error } = await request.db
        .from("student_private_notes")
        .upsert({ student_id: id, body, updated_by: request.auth.userId }, { onConflict: "student_id" })
        .select("body, updated_at")
        .single();
      if (error) throw fromPostgrest(error);
      return { body: data.body as string, updatedAt: data.updated_at as string };
    }
  );

  // ---- Stat polygon -----------------------------------------------------------

  /** Every polygon write: refreshed and returned the way GET returns it. */
  const refreshed = (db: SupabaseClient, studentId: string) =>
    loadPolygon(db, studentId, { persist: true });

  app.get(
    "/:id/polygon",
    { preHandler: [app.authenticate, limit("student-page:polygon", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      // The student reads their own strength profile and never writes it
      // (RLS refuses a student's axis writes since 20261010000002), so their
      // read derives today's scores in memory instead of storing them.
      return loadPolygon(request.db, student, { persist: request.profile.role === "counselor" });
    }
  );

  async function axisFor(db: SupabaseClient, studentId: string, axisId: string) {
    const { data, error } = await db
      .from("student_polygon_axes")
      .select("*")
      .eq("id", axisId)
      .eq("student_id", studentId)
      .maybeSingle();
    if (error) throw fromPostgrest(error);
    if (!data) throw notFound("That axis isn't on this student's polygon");
    return data as Row;
  }

  async function allAxes(db: SupabaseClient, studentId: string) {
    const { data, error } = await db
      .from("student_polygon_axes")
      .select("*")
      .eq("student_id", studentId)
      .order("sort_order");
    if (error) throw fromPostgrest(error);
    return (data ?? []) as Row[];
  }

  /**
   * Add a custom axis. A name the polygon already has (case-insensitive) is
   * read as "score the axis I already have", as the demo does: the counselor
   * typed a name and a number, and the number lands where they meant it.
   */
  app.post(
    "/:id/polygon/axes",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("student-page:polygon-write", 120, 60)] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const b = addAxisBody.parse(request.body);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const rows = await allAxes(db, student);
      const same = rows.find((r) => String(r.label).toLowerCase() === b.label.toLowerCase());

      if (same) {
        const update: Row = { updated_by: request.auth.userId };
        if (same.hidden === true) {
          if (rows.filter((r) => r.hidden !== true).length >= MAX_AXES) {
            throw badRequest(`A polygon holds at most ${MAX_AXES} axes`);
          }
          update.hidden = false;
        }
        if (b.score !== undefined) update.manual_score = b.score;
        const { error } = await db.from("student_polygon_axes").update(update).eq("id", same.id as string);
        if (error) throw fromPostgrest(error);
      } else {
        if (rows.filter((r) => r.hidden !== true).length >= MAX_AXES) {
          throw badRequest(`A polygon holds at most ${MAX_AXES} axes`);
        }
        const taken = new Set(rows.map((r) => String(r.key)));
        const order = rows.reduce((m, r) => Math.max(m, Number(r.sort_order ?? 0)), 0) + 1;
        const { error } = await db.from("student_polygon_axes").insert({
          student_id: student,
          key: axisKeyFor(b.label, taken),
          label: b.label,
          manual_score: b.score ?? 50,
          source: "custom",
          sort_order: Math.min(order, 99),
          updated_by: request.auth.userId,
        });
        if (error) throw fromPostgrest(error);
      }

      return reply.code(201).send(await refreshed(db, student));
    }
  );

  app.patch(
    "/:id/polygon/axes/:axisId",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("student-page:polygon-write", 240, 60)] },
    async (request) => {
      const { id, axisId } = axisParams.parse(request.params);
      const b = patchAxisBody.parse(request.body);
      if (Object.keys(b).length === 0) throw badRequest("Nothing to update");
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const axis = await axisFor(db, student, axisId);
      const update: Row = { updated_by: request.auth.userId };

      if (b.label !== undefined && b.label !== axis.label) {
        // A label is what the chart and the counselor key by; two axes sharing
        // one would read as one. Refuse rather than fuse them.
        const rows = await allAxes(db, student);
        const clash = rows.some(
          (r) => r.id !== axisId && String(r.label).toLowerCase() === b.label!.toLowerCase()
        );
        if (clash) throw badRequest("The polygon already has an axis with that name");
        update.label = b.label;
      }
      if (b.score !== undefined) update.manual_score = b.score;
      if (b.hidden !== undefined && b.hidden !== (axis.hidden === true)) {
        if (!b.hidden) {
          const rows = await allAxes(db, student);
          if (rows.filter((r) => r.hidden !== true).length >= MAX_AXES) {
            throw badRequest(`A polygon holds at most ${MAX_AXES} axes`);
          }
        }
        update.hidden = b.hidden;
      }

      const { error } = await db.from("student_polygon_axes").update(update).eq("id", axisId);
      if (error) throw fromPostgrest(error);
      return await refreshed(db, student);
    }
  );

  /** A custom axis goes; a default one is hidden, so bringing it back restores it. */
  app.delete(
    "/:id/polygon/axes/:axisId",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("student-page:polygon-write", 120, 60)] },
    async (request) => {
      const { id, axisId } = axisParams.parse(request.params);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const axis = await axisFor(db, student, axisId);
      const { error } =
        axis.source === "custom"
          ? await db.from("student_polygon_axes").delete().eq("id", axisId)
          : await db
              .from("student_polygon_axes")
              .update({ hidden: true, manual_score: null, updated_by: request.auth.userId })
              .eq("id", axisId);
      if (error) throw fromPostgrest(error);
      return await refreshed(db, student);
    }
  );

  /**
   * Back to the derived shape: hand-set scores cleared, defaults shown,
   * counselor-added axes removed. The history keeps every reading.
   */
  app.post(
    "/:id/polygon/reset",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("student-page:polygon-write", 30, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      const removed = await db
        .from("student_polygon_axes")
        .delete()
        .eq("student_id", student)
        .eq("source", "custom");
      if (removed.error) throw fromPostgrest(removed.error);

      const restored = await db
        .from("student_polygon_axes")
        .update({ manual_score: null, hidden: false, updated_by: request.auth.userId })
        .eq("student_id", student);
      if (restored.error) throw fromPostgrest(restored.error);

      return await refreshed(db, student);
    }
  );

  /**
   * The scrubber under the polygon: one shape per high school year so far,
   * from recorded history only. No grad year means no school years to place
   * readings in; the response says so rather than guessing a class.
   */
  app.get(
    "/:id/polygon/years",
    { preHandler: [app.authenticate, limit("student-page:polygon-years", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      return loadPolygonYears(request.db, student);
    }
  );
}
