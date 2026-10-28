/**
 * Overview card summaries (demo v6-v8 student cards, v7 alumni cards).
 *
 * One request for the whole roster: each card's polygon (stored axes plus the
 * counts the derived axes are computed from), GPA and test scores, class rank
 * as recorded, how many schools are on the list, and the next scheduled
 * meeting. Every table is read once with `.in("student_id", ids)`, so a
 * 60-student roster is nine queries, not 540. Roster-wide, so it carries the
 * DB-backed limiter (AGENTS.md read rule).
 *
 * Each card also carries its college results (accepted / waitlisted / denied,
 * the school the student is enrolling at), the number of colleges they say they
 * are applying to, the scholarship money won and the awards still open, and the
 * class year the Overview groups by. The columns behind the last three arrived
 * with migration 20261028000001, so those reads degrade to empty before it is
 * applied instead of failing the whole page.
 */

import type { FastifyInstance } from "fastify";
import { fromPostgrest } from "../lib/errors.js";
import { requireRole } from "../lib/guards.js";
import { limit } from "../lib/limits.js";
import { isResultsNotApplied } from "../lib/resultsAvailability.js";
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
        .select("id, grad_year")
        .eq("counselor_id", request.auth.userId)
        .eq("role", "student")
        .is("archived_at", null)
        .limit(2000);
      if (error) throw fromPostgrest(error);
      const ids = ((roster ?? []) as Row[]).map((r) => String(r.id));
      if (ids.length === 0) return [];
      const gradYearBy = new Map(((roster ?? []) as Row[]).map((r) => [String(r.id), r.grad_year ? String(r.grad_year) : null]));

      const [academics, axes, activities, awards, essays, colleges, meetings] = await Promise.all([
        db
          .from("student_academics")
          .select(
            "student_id, gpa_weighted, gpa_unweighted, gpa_scale, sat_superscore, act_composite, rigor_context, rigor_count, class_rank, class_rank_value"
          )
          .in("student_id", ids),
        db.from("student_polygon_axes").select("*").in("student_id", ids).order("sort_order"),
        db.from("activities").select("student_id").in("student_id", ids).limit(20_000),
        db.from("awards").select("student_id").in("student_id", ids).limit(20_000),
        db.from("essays").select("student_id, status").in("student_id", ids).limit(20_000),
        db.from("student_colleges").select("student_id, name, status").in("student_id", ids).limit(20_000),
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

      // Scholarship tracking and "applying to N" read columns the migration adds.
      const todayIso = new Date().toISOString().slice(0, 10);
      const scholarshipRows = await (async () => {
        const wide = await db
          .from("scholarship_matches")
          .select("student_id, status, amount_cents, awarded_cents, deadline")
          .in("student_id", ids)
          .limit(20_000);
        if (!wide.error) return (wide.data ?? []) as Row[];
        if (!isResultsNotApplied(wide.error)) throw fromPostgrest(wide.error);
        const narrow = await db
          .from("scholarship_matches")
          .select("student_id, status, amount_cents, deadline")
          .in("student_id", ids)
          .limit(20_000);
        if (narrow.error) throw fromPostgrest(narrow.error);
        return (narrow.data ?? []) as Row[];
      })();
      const plannedBy = new Map<string, number | null>();
      {
        const planned = await db.from("student_personal_details").select("student_id, colleges_planned").in("student_id", ids);
        if (planned.error) {
          if (!isResultsNotApplied(planned.error)) throw fromPostgrest(planned.error);
        } else {
          for (const r of (planned.data ?? []) as Row[]) plannedBy.set(String(r.student_id), num(r.colleges_planned));
        }
      }

      const resultsBy = new Map<
        string,
        { accepted: number; waitlisted: number; denied: number; deferred: number; withdrawn: number; waiting: number; enrolledName: string | null; inPlay: number }
      >();
      for (const r of (colleges.data ?? []) as Row[]) {
        const id = String(r.student_id);
        const cur = resultsBy.get(id) ?? { accepted: 0, waitlisted: 0, denied: 0, deferred: 0, withdrawn: 0, waiting: 0, enrolledName: null, inPlay: 0 };
        const status = String(r.status);
        // The final choice is an accepted school the student picked, so it counts as accepted too.
        if (status === "accepted" || status === "enrolled") cur.accepted += 1;
        else if (status === "waitlisted") cur.waitlisted += 1;
        else if (status === "denied") cur.denied += 1;
        else if (status === "deferred") cur.deferred += 1;
        else if (status === "withdrawn") cur.withdrawn += 1;
        else if (status === "submitted") cur.waiting += 1;
        if (status === "enrolled") cur.enrolledName = String(r.name);
        if (status !== "not-started") cur.inPlay += 1;
        resultsBy.set(id, cur);
      }
      const scholarshipsBy = new Map<string, { wonCents: number; openCount: number; nextDeadline: string | null }>();
      for (const r of scholarshipRows) {
        const id = String(r.student_id);
        const cur = scholarshipsBy.get(id) ?? { wonCents: 0, openCount: 0, nextDeadline: null };
        const status = String(r.status);
        if (status === "awarded") cur.wonCents += num(r.awarded_cents) ?? num(r.amount_cents) ?? 0;
        if (status === "saved" || status === "applying") {
          cur.openCount += 1;
          const d = r.deadline ? String(r.deadline) : null;
          if (d && d >= todayIso && (cur.nextDeadline === null || d < cur.nextDeadline)) cur.nextDeadline = d;
        }
        scholarshipsBy.set(id, cur);
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
          gpaScale: (a?.gpa_scale as string | null) ?? null,
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
          gradYear: gradYearBy.get(id) ?? null,
          /** What the student typed for "Applying to N"; null until they do. */
          collegesPlanned: plannedBy.get(id) ?? null,
          /** The number the Overview shows: what they typed, else the schools applied or being applied to. */
          applying: plannedBy.get(id) ?? resultsBy.get(id)?.inPlay ?? 0,
          results: {
            accepted: resultsBy.get(id)?.accepted ?? 0,
            waitlisted: resultsBy.get(id)?.waitlisted ?? 0,
            denied: resultsBy.get(id)?.denied ?? 0,
            deferred: resultsBy.get(id)?.deferred ?? 0,
            withdrawn: resultsBy.get(id)?.withdrawn ?? 0,
            waiting: resultsBy.get(id)?.waiting ?? 0,
            enrolledName: resultsBy.get(id)?.enrolledName ?? null,
          },
          scholarships: scholarshipsBy.get(id) ?? { wonCents: 0, openCount: 0, nextDeadline: null },
          polygon: axesBy.get(id) ?? [],
          nextMeeting: m
            ? { id: String(m.id), title: String(m.title), startsAt: String(m.starts_at), mode: String(m.mode) }
            : null,
        };
      });
    }
  );
}
