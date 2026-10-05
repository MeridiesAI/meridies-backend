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
 *
 * Every route authorizes in code (resolveStudentId) and runs on the caller's
 * RLS-bound client, so RLS is the backstop. The student may read and edit
 * their own info card and polygon, as the standard student-scoped shape
 * already lets them; the status override is counselor-only and stays on
 * `PUT /students/:id/status`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, fromPostgrest, notFound } from "../lib/errors.js";
import { resolveStudentId } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  axisKeyFor,
  deriveAxisScores,
  loadStudentInfo,
  matchHighSchool,
  MAX_AXES,
  schoolYearHistory,
  toAxisDto,
  type PolygonAxisDto,
} from "../lib/studentPage.js";

type Row = Record<string, unknown>;

const idParam = z.object({ id: z.string().uuid("Not a valid student id") });
const axisParams = idParam.extend({ axisId: z.string().uuid() });

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .nullable()
    .transform((v) => (v === "" ? null : v));

const infoPatch = z
  .object({
    email: z.union([z.string().trim().email().max(320), z.literal("")]).nullable(),
    phone: optionalText(40),
    address: optionalText(400),
    parentName: optionalText(200),
    parentEmail: z.union([z.string().trim().email().max(254), z.literal("")]).nullable(),
    parentPhone: optionalText(40),
    gender: z.enum(["female", "male", "non-binary", "undisclosed"]).nullable(),
    birthday: z.string().date().nullable(),
    citizenship: z.enum(["us-citizen", "permanent-resident", "international"]).nullable(),
    firstGen: z.boolean().nullable(),
    livingWithParent: z.boolean().nullable(),
    maritalStatus: z.enum(["single", "married"]).nullable(),
    highSchool: optionalText(200),
    gradYear: z
      .string()
      .trim()
      .regex(/^(20\d\d)?$/, "Use a four-digit year")
      .nullable(),
    gpaWeighted: z.number().min(0).max(10).nullable(),
    gpaUnweighted: z.number().min(0).max(10).nullable(),
    classRank: optionalText(80),
    sat: z.number().int().min(400).max(1600).nullable(),
    act: z.number().int().min(1).max(36).nullable(),
    rigor: optionalText(300),
    intendedMajors: z.array(z.string().trim().min(1).max(80)).max(10),
  })
  .partial()
  .strict();

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
      const patch = infoPatch.parse(request.body);
      if (Object.keys(patch).length === 0) throw badRequest("Nothing to update");
      const student = await resolveStudentId(request, id, "edit");
      const db = request.db;

      // profiles: phone, high school (linked to the catalog when it matches), grad year.
      const profile: Row = {};
      if (patch.phone !== undefined) profile.phone = patch.phone;
      if (patch.gradYear !== undefined) profile.grad_year = patch.gradYear || null;
      if (patch.highSchool !== undefined) {
        profile.high_school = patch.highSchool;
        profile.high_school_id = patch.highSchool ? await matchHighSchool(db, patch.highSchool) : null;
      }
      if (Object.keys(profile).length > 0) {
        const { error } = await db.from("profiles").update(profile).eq("id", student);
        if (error) throw fromPostgrest(error);
      }

      // Personal details.
      const details: Row = {};
      if (patch.email !== undefined) details.contact_email = patch.email || null;
      if (patch.address !== undefined) details.address = patch.address;
      if (patch.gender !== undefined) details.gender = patch.gender;
      if (patch.birthday !== undefined) details.birthday = patch.birthday;
      if (patch.citizenship !== undefined) details.citizenship = patch.citizenship;
      if (patch.firstGen !== undefined) details.first_gen = patch.firstGen;
      if (patch.livingWithParent !== undefined) details.living_with_parent = patch.livingWithParent;
      if (patch.maritalStatus !== undefined) details.marital_status = patch.maritalStatus;
      if (patch.intendedMajors !== undefined) details.intended_majors = patch.intendedMajors;
      if (Object.keys(details).length > 0) {
        const { error } = await db
          .from("student_personal_details")
          .upsert(
            { ...details, student_id: student, updated_by: request.auth.userId },
            { onConflict: "student_id" }
          );
        if (error) throw fromPostgrest(error);
      }

      // Academics.
      const academics: Row = {};
      if (patch.gpaWeighted !== undefined) academics.gpa_weighted = patch.gpaWeighted;
      if (patch.gpaUnweighted !== undefined) academics.gpa_unweighted = patch.gpaUnweighted;
      if (patch.classRank !== undefined) academics.class_rank = patch.classRank;
      if (patch.sat !== undefined) academics.sat_superscore = patch.sat;
      if (patch.act !== undefined) academics.act_composite = patch.act;
      if (patch.rigor !== undefined) academics.rigor_context = patch.rigor;
      if (Object.keys(academics).length > 0) {
        const { error } = await db
          .from("student_academics")
          .upsert({ ...academics, student_id: student }, { onConflict: "student_id" });
        if (error) throw fromPostgrest(error);
      }

      // The parent: the primary guardian, or the first on file. A guardian
      // needs a way to be reached, so a new one needs an email or a phone.
      if (
        patch.parentName !== undefined ||
        patch.parentEmail !== undefined ||
        patch.parentPhone !== undefined
      ) {
        const { data: existing, error: readError } = await db
          .from("guardians")
          .select("id, email, phone")
          .eq("student_id", student)
          .order("is_primary", { ascending: false })
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (readError) throw fromPostgrest(readError);

        const values: Row = {};
        if (patch.parentName) values.full_name = patch.parentName;
        if (patch.parentEmail !== undefined) values.email = patch.parentEmail || null;
        if (patch.parentPhone !== undefined) values.phone = patch.parentPhone;

        if (existing) {
          const email = values.email !== undefined ? values.email : existing.email;
          const phone = values.phone !== undefined ? values.phone : existing.phone;
          if (!email && !phone) throw badRequest("Keep an email or a phone number for the parent");
          if (Object.keys(values).length > 0) {
            const { error } = await db.from("guardians").update(values).eq("id", existing.id as string);
            if (error) throw fromPostgrest(error);
          }
        } else {
          if (!values.email && !values.phone) {
            throw badRequest("Add the parent's email or phone number first");
          }
          const { error } = await db.from("guardians").insert({
            student_id: student,
            full_name: values.full_name ?? "Parent or guardian",
            email: values.email ?? null,
            phone: values.phone ?? null,
            is_primary: true,
          });
          if (error) throw fromPostgrest(error);
        }
      }

      const info = await loadStudentInfo(db, student);
      if (!info) throw notFound("That student isn't on your roster");
      return info;
    }
  );

  // ---- Stat polygon -----------------------------------------------------------

  /**
   * Seed the five defaults for a student with none, refresh the derived scores
   * from what is on file (the history trigger records only real movement), and
   * return every axis.
   */
  async function refreshAxes(
    db: SupabaseClient,
    studentId: string
  ): Promise<PolygonAxisDto[]> {
    const seeded = await db.rpc("ensure_default_polygon_axes", { p_student: studentId });
    if (seeded.error) throw fromPostgrest(seeded.error);

    const [{ data, error }, derived] = await Promise.all([
      db.from("student_polygon_axes").select("*").eq("student_id", studentId).order("sort_order"),
      deriveAxisScores(db, studentId),
    ]);
    if (error) throw fromPostgrest(error);
    const rows = (data ?? []) as Row[];

    for (const row of rows) {
      const key = String(row.key);
      if (row.source !== "default" || !(key in derived)) continue;
      const next = derived[key];
      const current = row.auto_score == null ? null : Number(row.auto_score);
      if (next === current) continue;
      const { error: updateError } = await db
        .from("student_polygon_axes")
        .update({ auto_score: next })
        .eq("id", row.id as string);
      if (updateError) throw fromPostgrest(updateError);
      row.auto_score = next;
    }

    return rows.map(toAxisDto);
  }

  function polygonResponse(axes: PolygonAxisDto[]) {
    const visible = axes.filter((a) => !a.hidden);
    return {
      axes: visible,
      hidden: axes.filter((a) => a.hidden),
      maxAxes: MAX_AXES,
      canAdd: visible.length < MAX_AXES,
    };
  }

  app.get(
    "/:id/polygon",
    { preHandler: [app.authenticate, limit("student-page:polygon", 240, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const student = await resolveStudentId(request, id, "view");
      return polygonResponse(await refreshAxes(request.db, student));
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
    { preHandler: [app.authenticate, limit("student-page:polygon-write", 120, 60)] },
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

      return reply.code(201).send(polygonResponse(await refreshAxes(db, student)));
    }
  );

  app.patch(
    "/:id/polygon/axes/:axisId",
    { preHandler: [app.authenticate, limit("student-page:polygon-write", 240, 60)] },
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
      return polygonResponse(await refreshAxes(db, student));
    }
  );

  /** A custom axis goes; a default one is hidden, so bringing it back restores it. */
  app.delete(
    "/:id/polygon/axes/:axisId",
    { preHandler: [app.authenticate, limit("student-page:polygon-write", 120, 60)] },
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
      return polygonResponse(await refreshAxes(db, student));
    }
  );

  /**
   * Back to the derived shape: hand-set scores cleared, defaults shown,
   * counselor-added axes removed. The history keeps every reading.
   */
  app.post(
    "/:id/polygon/reset",
    { preHandler: [app.authenticate, limit("student-page:polygon-write", 30, 60)] },
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

      return polygonResponse(await refreshAxes(db, student));
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
      const db = request.db;

      const [profile, axes, history] = await Promise.all([
        db.from("profiles").select("grad_year").eq("id", student).maybeSingle(),
        db
          .from("student_polygon_axes")
          .select("key, hidden, sort_order")
          .eq("student_id", student)
          .order("sort_order"),
        db
          .from("polygon_axis_history")
          .select("axis_key, label, score, recorded_at")
          .eq("student_id", student)
          .order("recorded_at", { ascending: true })
          .limit(2000),
      ]);
      if (profile.error) throw fromPostgrest(profile.error);
      if (axes.error) throw fromPostgrest(axes.error);
      if (history.error) throw fromPostgrest(history.error);

      const gradYear = Number.parseInt(String(profile.data?.grad_year ?? ""), 10);
      if (!Number.isFinite(gradYear)) {
        return { gradYear: null, years: [], unavailableReason: "No graduation year on file" };
      }

      const visibleKeys = ((axes.data ?? []) as Row[])
        .filter((r) => r.hidden !== true)
        .map((r) => String(r.key));

      const years = schoolYearHistory(
        ((history.data ?? []) as Row[]).map((r) => ({
          axisKey: String(r.axis_key),
          label: String(r.label),
          score: Number(r.score),
          recordedAt: String(r.recorded_at),
        })),
        gradYear,
        visibleKeys
      );

      return {
        gradYear,
        years,
        unavailableReason: years.length === 0 ? "No scores recorded yet" : null,
      };
    }
  );
}
