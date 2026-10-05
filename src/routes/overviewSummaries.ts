/**
 * Overview card summaries (demo v6-v8 student cards, v7 alumni cards).
 *
 * One request for the whole roster: each card's polygon (stored axes plus the
 * counts the derived axes are computed from), GPA and test scores, class rank
 * as recorded, how many schools are on the list, and the next scheduled
 * meeting. Every table is read once with `.in("student_id", ids)`, so a
 * 60-student roster is nine queries, not 540. Roster-wide, so it carries the
 * DB-backed limiter (AGENTS.md read rule).
 */

import type { FastifyInstance } from "fastify";
import { fromPostgrest } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { toPolygonAxis } from "../lib/serialize.js";

type Row = Record<string, unknown>;

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

export default async function overviewSummaryRoutes(app: FastifyInstance) {
  app.get(
    "/student-summaries",
    { preHandler: [app.authenticate, requireRole("counselor"), limit("overview:summaries", 60, 60)] },
    async (request) => {
      const db = request.db;
      const { data: roster, error } = await db
        .from("profiles")
        .select("id")
        .eq("counselor_id", request.auth.userId)
        .eq("role", "student")
        .is("archived_at", null)
        .limit(2000);
      if (error) throw fromPostgrest(error);
      const ids = ((roster ?? []) as Row[]).map((r) => String(r.id));
      if (ids.length === 0) return [];

      const [academics, axes, activities, awards, essays, colleges, meetings] = await Promise.all([
        db
          .from("student_academics")
          .select(
            "student_id, gpa_weighted, gpa_unweighted, sat_superscore, act_composite, rigor_context, rigor_count, class_rank, class_rank_value"
          )
          .in("student_id", ids),
        db.from("student_polygon_axes").select("*").in("student_id", ids).order("sort_order"),
        db.from("activities").select("student_id").in("student_id", ids).limit(20_000),
        db.from("awards").select("student_id").in("student_id", ids).limit(20_000),
        db.from("essays").select("student_id, status").in("student_id", ids).limit(20_000),
        db.from("student_colleges").select("student_id").in("student_id", ids).limit(20_000),
        db
          .from("meetings")
          .select("id, student_id, title, starts_at, mode")
          .in("student_id", ids)
          .eq("status", "scheduled")
          .gte("starts_at", new Date().toISOString())
          .order("starts_at", { ascending: true })
          .limit(2000),
      ]);
      for (const r of [academics, axes, activities, awards, essays, colleges, meetings]) {
        if (r.error) throw fromPostgrest(r.error);
      }

      const count = (rows: unknown) => {
        const m = new Map<string, number>();
        for (const r of (rows ?? []) as Row[]) {
          const id = String(r.student_id);
          m.set(id, (m.get(id) ?? 0) + 1);
        }
        return m;
      };
      const activityCount = count(activities.data);
      const awardCount = count(awards.data);
      const applications = count(colleges.data);

      const academicsBy = new Map(((academics.data ?? []) as Row[]).map((r) => [String(r.student_id), r]));
      const axesBy = new Map<string, ReturnType<typeof toPolygonAxis>[]>();
      for (const r of (axes.data ?? []) as Row[]) {
        const id = String(r.student_id);
        axesBy.set(id, [...(axesBy.get(id) ?? []), toPolygonAxis(r as never)]);
      }
      const essaysBy = new Map<string, string[]>();
      for (const r of (essays.data ?? []) as Row[]) {
        const id = String(r.student_id);
        essaysBy.set(id, [...(essaysBy.get(id) ?? []), String(r.status)]);
      }
      const meetingBy = new Map<string, Row>();
      for (const r of (meetings.data ?? []) as Row[]) {
        const id = String(r.student_id);
        if (!meetingBy.has(id)) meetingBy.set(id, r);
      }

      return ids.map((id) => {
        const a = academicsBy.get(id);
        const m = meetingBy.get(id);
        return {
          studentId: id,
          gpaWeighted: num(a?.gpa_weighted),
          gpaUnweighted: num(a?.gpa_unweighted),
          sat: num(a?.sat_superscore),
          act: num(a?.act_composite),
          rigor: a?.rigor_context ? String(a.rigor_context) : null,
          apCount: num(a?.rigor_count),
          /** As recorded on the student's file; null when nothing is. */
          classRank: a?.class_rank_value
            ? String(a.class_rank_value)
            : a?.class_rank
              ? String(a.class_rank)
              : null,
          activityCount: activityCount.get(id) ?? 0,
          awardCount: awardCount.get(id) ?? 0,
          essayStatuses: essaysBy.get(id) ?? [],
          applications: applications.get(id) ?? 0,
          polygon: axesBy.get(id) ?? [],
          nextMeeting: m
            ? { id: String(m.id), title: String(m.title), startsAt: String(m.starts_at), mode: String(m.mode) }
            : null,
        };
      });
    }
  );
}
