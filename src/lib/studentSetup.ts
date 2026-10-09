/**
 * What is left to set up for a student the counselor confirmed from New
 * student (20261015000001). Two lists, one per side: the counselor's become
 * derived rows in My Work Queue, the student's a "Getting started" group in
 * their To-Do.
 *
 * Nothing here is stored. Each step is a question about the record ("is
 * there a GPA?"), asked on every read, so a step clears itself whoever fills
 * the data: the counselor, the student, AxIS, or a practice import.
 */

import type { FastifyRequest } from "fastify";
import { fromPostgrest } from "./errors.js";

export type SetupLink = "overview" | "college-list" | "application" | "calendar" | "profile-updates";

export type SetupStep = { key: string; title: string; link: SetupLink };

export const COUNSELOR_STEPS: SetupStep[] = [
  { key: "academics", title: "Fill in GPA & test scores", link: "overview" },
  { key: "polygon", title: "Set the strength profile", link: "overview" },
  { key: "recommend", title: "Recommend colleges", link: "college-list" },
  { key: "activities", title: "Review activities & honors", link: "application" },
  { key: "guardian", title: "Add a parent or guardian", link: "overview" },
  { key: "meeting", title: "Book a first meeting", link: "calendar" },
];

export const STUDENT_STEPS: SetupStep[] = [
  { key: "activities", title: "Add your activities & honors", link: "profile-updates" },
  { key: "colleges", title: "Add colleges you're interested in", link: "college-list" },
  { key: "guardian", title: "Add a parent or guardian", link: "overview" },
  { key: "details", title: "Finish your details: high school, intended majors", link: "overview" },
];

/** What is on file for one student, as the steps ask it. */
export type SetupFacts = {
  academics: boolean;
  polygon: boolean;
  recommend: boolean;
  activities: boolean;
  guardian: boolean;
  meeting: boolean;
  colleges: boolean;
  details: boolean;
};

/** The steps still open, in order. Pure, so it is tested without a database. */
export function openSteps(steps: SetupStep[], facts: SetupFacts): SetupStep[] {
  return steps.filter((s) => !facts[s.key as keyof SetupFacts]);
}

/** Students this counselor confirmed from New student, by id with their name. */
export async function confirmedStudents(request: FastifyRequest): Promise<Map<string, string | null>> {
  const { data, error } = await request.db
    .from("invitations")
    .select("accepted_by, full_name")
    .eq("counselor_id", request.auth.userId)
    .eq("status", "accepted")
    .not("confirmed_at", "is", null)
    .not("accepted_by", "is", null)
    .limit(500);
  if (error) throw fromPostgrest(error);
  const out = new Map<string, string | null>();
  for (const r of data ?? []) out.set(String(r.accepted_by), (r.full_name as string | null) ?? null);
  return out;
}

/**
 * The facts for many students at once: one query per table, never per
 * student. Runs on the caller's client, so RLS limits it to what they may see.
 */
export async function setupFacts(request: FastifyRequest, studentIds: string[]): Promise<Map<string, SetupFacts>> {
  const out = new Map<string, SetupFacts>();
  if (studentIds.length === 0) return out;
  const ids = [...new Set(studentIds)];

  const has = async (table: string, extra?: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    let q = base(table);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw fromPostgrest(error);
    return new Set((data ?? []).map((r) => String((r as Record<string, unknown>).student_id)));
  };
  function base(table: string) {
    return request.db.from(table).select("student_id").in("student_id", ids).limit(5000);
  }

  const [academics, scores, polygon, recommend, activities, awards, guardians, meetings, colleges, personal, profiles] =
    await Promise.all([
      has("student_academics", (q) => q.or("gpa_weighted.not.is.null,gpa_unweighted.not.is.null")),
      has("test_scores"),
      has("polygon_axis_history", (q) => q.eq("is_manual", true)),
      has("student_college_recommendations"),
      has("activities"),
      has("awards"),
      has("guardians"),
      has("meetings"),
      has("student_colleges"),
      has("student_personal_details", (q) => q.neq("intended_majors", "{}")),
      request.db.from("profiles").select("id, high_school").in("id", ids),
    ]);
  if (profiles.error) throw fromPostgrest(profiles.error);
  const school = new Set(
    (profiles.data ?? []).filter((p) => String(p.high_school ?? "").trim()).map((p) => String(p.id))
  );

  for (const id of ids) {
    out.set(id, {
      academics: academics.has(id) || scores.has(id),
      polygon: polygon.has(id),
      recommend: recommend.has(id),
      activities: activities.has(id) || awards.has(id),
      guardian: guardians.has(id),
      meeting: meetings.has(id),
      colleges: colleges.has(id),
      details: school.has(id) && personal.has(id),
    });
  }
  return out;
}
