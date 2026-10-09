/**
 * Roster and student detail.
 *
 * `GET /students/:id` assembles the `profile` object the frontend already
 * expects (activities, awards, essays, colleges, notes, flags, reports) from
 * the normalized tables, so meridies-app's existing types keep working while
 * the data underneath is properly relational.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromPostgrest, notFound } from "../lib/errors.js";
import { assertCanEditStudent, assertCanViewStudent, requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import {
  toActivity,
  toAward,
  toCollege,
  toDeadline,
  toEssay,
  toFamilyReport,
  toMeridiesUser,
  toNarrativeFlag,
  toNote,
  toPolygonAxis,
  toSchoolReframing,
  toStudentStatus,
} from "../lib/serialize.js";

const idParam = z.object({ id: z.string().uuid("Not a valid student id") });

const patchStudentSchema = z
  .object({
    headline: z.string().trim().max(300),
    hometown: z.string().trim().max(200),
    highSchool: z.string().trim().max(200),
    gradYear: z.string().trim().max(10),
    profile: z.record(z.unknown()),
    archived: z.boolean(),
  })
  .partial()
  .strict();

export default async function studentRoutes(app: FastifyInstance) {
  /** The counselor's roster, each with their next open deadline. */
  app.get("/", { preHandler: [app.authenticate, requireRole("counselor")] }, async (request) => {
    const { data: students, error } = await request.db
      .from("profiles")
      .select("*")
      .eq("counselor_id", request.auth.userId)
      .is("archived_at", null)
      .order("full_name");

    if (error) throw fromPostgrest(error);
    const rows = students ?? [];
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id as string);

    // One query for every roster member's open deadlines, then pick the
    // earliest per student in memory — N+1 across a 60-student roster is the
    // difference between a snappy dashboard and a spinner.
    const { data: deadlines } = await request.db
      .from("deadlines")
      .select("*")
      .in("student_id", ids)
      .eq("done", false)
      .order("due_date", { ascending: true, nullsFirst: false });

    const next = new Map<string, unknown>();
    for (const d of deadlines ?? []) {
      const sid = d.student_id as string;
      if (!next.has(sid)) next.set(sid, toDeadline(d as never));
    }

    // The counselor's own read on each student, where they have overruled what
    // the work implies. Fetched with the roster because the sidebar renders it.
    const { data: overrides } = await request.db
      .from("student_status_overrides")
      .select("*")
      .in("student_id", ids);

    const status = new Map<string, unknown>();
    for (const o of overrides ?? []) {
      status.set(o.student_id as string, toStudentStatus(o as never));
    }

    return rows.map((row) => ({
      ...toMeridiesUser(row as never, { counselorName: request.profile.full_name }),
      nextDeadline: next.get(row.id as string) ?? null,
      counselorStatus: status.get(row.id as string) ?? null,
    }));
  });

  app.get("/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = idParam.parse(request.params);
    await assertCanViewStudent(request, id);

    const db = request.db;
    const [
      profile,
      academics,
      activities,
      awards,
      essays,
      colleges,
      notes,
      flags,
      reports,
      reframing,
      axes,
      deadlines,
      override,
    ] = await Promise.all([
      db.from("profiles").select("*").eq("id", id).maybeSingle(),
      db.from("student_academics").select("*").eq("student_id", id).maybeSingle(),
      db.from("activities").select("*").eq("student_id", id).order("sort_order"),
      db.from("awards").select("*").eq("student_id", id).order("sort_order"),
      db.from("essays").select("*").eq("student_id", id).order("sort_order"),
      db.from("student_colleges").select("*").eq("student_id", id).order("sort_order"),
      db.from("meeting_notes").select("*").eq("student_id", id).order("meeting_date", { ascending: false }).limit(100),
      db.from("narrative_flags").select("*").eq("student_id", id).order("created_at", { ascending: false }),
      db.from("family_reports").select("*").eq("student_id", id).order("created_at", { ascending: false }).limit(50),
      db.from("school_reframing").select("*").eq("student_id", id).order("created_at", { ascending: false }).limit(50),
      db.from("student_polygon_axes").select("*").eq("student_id", id).order("sort_order"),
      db.from("deadlines").select("*").eq("student_id", id).order("due_date", { ascending: true, nullsFirst: false }),
      // RLS keeps this counselor-only, so a student reading their own record
      // gets null here rather than an assessment written about them.
      db.from("student_status_overrides").select("*").eq("student_id", id).maybeSingle(),
    ]);

    if (profile.error) throw fromPostgrest(profile.error);
    if (!profile.data) throw notFound("That student isn't on your roster");

    const a = academics.data as Record<string, unknown> | null;

    let counselorName: string | null = null;
    if (profile.data.counselor_id) {
      const { data } = await db
        .from("profiles")
        .select("full_name")
        .eq("id", profile.data.counselor_id)
        .maybeSingle();
      counselorName = data?.full_name ?? null;
    }

    const user = toMeridiesUser(profile.data as never, {
      counselorName,
      extraProfile: {
        gpaWeighted: a?.gpa_weighted ?? undefined,
        gpaUnweighted: a?.gpa_unweighted ?? undefined,
        gpaScale: a?.gpa_scale ?? undefined,
        rigor: a?.rigor_context ?? undefined,
        sat: a?.sat_superscore ?? undefined,
        act: a?.act_composite ?? undefined,
        testStatus: a?.test_status ?? undefined,
        activities: (activities.data ?? []).map((r) => toActivity(r as never)),
        awards: (awards.data ?? []).map((r) => toAward(r as never)),
        essays: (essays.data ?? []).map((r) => toEssay(r as never)),
        colleges: (colleges.data ?? []).map((r) => toCollege(r as never)),
        notes: (notes.data ?? []).map((r) => toNote(r as never)),
        narrativeFlags: (flags.data ?? []).map((r) => toNarrativeFlag(r as never)),
        familyReports: (reports.data ?? []).map((r) => toFamilyReport(r as never)),
        schoolReframing: (reframing.data ?? []).map((r) => toSchoolReframing(r as never)),
        polygon: (axes.data ?? []).map((r) => toPolygonAxis(r as never)),
      },
    });

    return {
      ...user,
      deadlines: (deadlines.data ?? []).map((r) => toDeadline(r as never)),
      counselorStatus: override.data ? toStudentStatus(override.data as never) : null,
    };
  });

  app.patch(
    "/:id",
    { preHandler: [app.authenticate, limit("students:patch", 120, 60)] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await assertCanEditStudent(request, id);
      const patch = patchStudentSchema.parse(request.body);

      const { data: current } = await request.db
        .from("profiles")
        .select("profile")
        .eq("id", id)
        .maybeSingle();

      const update: Record<string, unknown> = {};
      if (patch.headline !== undefined) update.headline = patch.headline;
      if (patch.hometown !== undefined) update.hometown = patch.hometown;
      if (patch.highSchool !== undefined) update.high_school = patch.highSchool;
      if (patch.gradYear !== undefined) update.grad_year = patch.gradYear;
      if (patch.archived !== undefined)
        update.archived_at = patch.archived ? new Date().toISOString() : null;
      if (patch.profile !== undefined) {
        update.profile = { ...((current?.profile as object) ?? {}), ...patch.profile };
      }

      const { data, error } = await request.db
        .from("profiles")
        .update(update)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) throw fromPostgrest(error);
      if (!data) throw notFound("That student isn't on your roster");
      return toMeridiesUser(data as never, { counselorName: request.profile.full_name });
    }
  );

  // ---- The counselor's status override -------------------------------------
  //
  // Counselor-only in both directions. "At risk" is a professional assessment
  // about a student rather than a record belonging to them, which is the same
  // reasoning that keeps `parent_alerts` away from the student they concern.

  app.put(
    "/:id/status",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("students:status", 120, 60)],
    },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          status: z.enum(["on-track", "at-risk", "ahead"]),
          note: z.string().trim().max(2000).nullable().optional(),
        })
        .strict()
        .parse(request.body);

      await assertCanEditStudent(request, id);

      const { data, error } = await request.db
        .from("student_status_overrides")
        .upsert(
          {
            student_id: id,
            status: body.status,
            note: body.note ?? null,
            set_by: request.auth.userId,
          },
          { onConflict: "student_id" }
        )
        .select("*")
        .single();
      if (error) throw fromPostgrest(error);
      return toStudentStatus(data as never);
    }
  );

  /** Drop the override and fall back to the status the work implies. */
  app.delete(
    "/:id/status",
    {
      preHandler: [app.authenticate, requireRole("counselor"), limit("students:status", 120, 60)],
    },
    async (request) => {
      const { id } = idParam.parse(request.params);
      await assertCanEditStudent(request, id);

      const { error } = await request.db
        .from("student_status_overrides")
        .delete()
        .eq("student_id", id);
      if (error) throw fromPostgrest(error);
      return { deleted: true };
    }
  );

  /** Archive rather than delete — the record is the counselor's work product. */
  app.delete("/:id", { preHandler: [app.authenticate, requireRole("counselor")] }, async (request) => {
    const { id } = idParam.parse(request.params);
    await assertCanEditStudent(request, id);

    const { error } = await request.db
      .from("profiles")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id);

    if (error) throw fromPostgrest(error);
    return { archived: true };
  });
}
