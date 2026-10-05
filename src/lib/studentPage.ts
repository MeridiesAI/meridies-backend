/**
 * The student page (demo v8-v10): the info card's values, the stat polygon's
 * derived scores, and its freshman-to-now scrubber.
 *
 * Three rules carried over from elsewhere in this API:
 *  - the class rank is the school's or nothing (`lib/classRank.ts`): an
 *    entered rank is shown as typed, a derived one only where the school
 *    publishes bands that cover the GPA;
 *  - a polygon score is derived from what is on file, never from a default.
 *    No SAT and no ACT on file is "no testing score", not 45;
 *  - growth is what was recorded (`polygon_axis_history`), never modelled
 *    backwards from today's shape. A student with one term of history has one
 *    term of scrubber.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { rankPercentile, type RankRead } from "./classRank.js";
import { fromPostgrest } from "./errors.js";
import { toRankBand } from "./serialize.js";

type Row = Record<string, unknown>;

export const MAX_AXES = 10;

const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const n = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

// ---------------------------------------------------------------------------
// Info card
// ---------------------------------------------------------------------------

export type Gender = "female" | "male" | "non-binary" | "undisclosed";
export type Citizenship = "us-citizen" | "permanent-resident" | "international";
export type MaritalStatus = "single" | "married";

export type StudentInfo = {
  studentId: string;
  fullName: string;
  /** The address they sign in with. Not editable here. */
  loginEmail: string;
  /** Where the counselor writes to them; falls back to the login email. */
  email: string;
  contactEmailSet: boolean;
  phone: string | null;
  address: string | null;
  /** The primary guardian, or the first one on file. */
  guardianId: string | null;
  parentName: string | null;
  parentEmail: string | null;
  parentPhone: string | null;
  gender: Gender | null;
  birthday: string | null;
  citizenship: Citizenship | null;
  firstGen: boolean | null;
  livingWithParent: boolean | null;
  maritalStatus: MaritalStatus | null;
  highSchool: string | null;
  highSchoolId: string | null;
  gradYear: string | null;
  gpaWeighted: number | null;
  gpaUnweighted: number | null;
  /** As entered by the counselor or student, verbatim. */
  classRank: string | null;
  /** Read off the school's own bands; null with a reason when it can't be. */
  classRankDerived: RankRead | null;
  classRankUnavailableReason: string | null;
  sat: number | null;
  act: number | null;
  rigor: string | null;
  intendedMajors: string[];
  /** Schools on the college list (read-only beside Academics). */
  applications: number;
};

export async function loadStudentInfo(db: SupabaseClient, studentId: string): Promise<StudentInfo | null> {
  const [profile, details, academics, guardians, colleges] = await Promise.all([
    db
      .from("profiles")
      .select("id, full_name, email, phone, high_school, high_school_id, grad_year")
      .eq("id", studentId)
      .maybeSingle(),
    db.from("student_personal_details").select("*").eq("student_id", studentId).maybeSingle(),
    db.from("student_academics").select("*").eq("student_id", studentId).maybeSingle(),
    db
      .from("guardians")
      .select("id, full_name, email, phone, is_primary, created_at")
      .eq("student_id", studentId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1),
    db.from("student_colleges").select("id", { count: "exact", head: true }).eq("student_id", studentId),
  ]);

  if (profile.error) throw fromPostgrest(profile.error);
  if (!profile.data) return null;
  if (details.error) throw fromPostgrest(details.error);
  if (academics.error) throw fromPostgrest(academics.error);
  if (guardians.error) throw fromPostgrest(guardians.error);

  const p = profile.data as Row;
  const d = (details.data ?? {}) as Row;
  const a = (academics.data ?? {}) as Row;
  const g = ((guardians.data ?? [])[0] ?? null) as Row | null;

  const gpaWeighted = n(a.gpa_weighted);
  const rank = await deriveClassRank(db, s(p.high_school_id), gpaWeighted);

  const contact = s(d.contact_email);
  return {
    studentId,
    fullName: s(p.full_name) ?? "",
    loginEmail: s(p.email) ?? "",
    email: contact ?? s(p.email) ?? "",
    contactEmailSet: contact !== null,
    phone: s(p.phone),
    address: s(d.address),
    guardianId: g ? s(g.id) : null,
    parentName: g ? s(g.full_name) : null,
    parentEmail: g ? s(g.email) : null,
    parentPhone: g ? s(g.phone) : null,
    gender: s(d.gender) as Gender | null,
    birthday: s(d.birthday),
    citizenship: s(d.citizenship) as Citizenship | null,
    firstGen: typeof d.first_gen === "boolean" ? d.first_gen : null,
    livingWithParent: typeof d.living_with_parent === "boolean" ? d.living_with_parent : null,
    maritalStatus: s(d.marital_status) as MaritalStatus | null,
    highSchool: s(p.high_school),
    highSchoolId: s(p.high_school_id),
    gradYear: s(p.grad_year),
    gpaWeighted,
    gpaUnweighted: n(a.gpa_unweighted),
    classRank: s(a.class_rank),
    classRankDerived: rank.read,
    classRankUnavailableReason: rank.reason,
    sat: n(a.sat_superscore),
    act: n(a.act_composite),
    rigor: s(a.rigor_context),
    intendedMajors: Array.isArray(d.intended_majors) ? (d.intended_majors as unknown[]).map(String) : [],
    applications: colleges.count ?? 0,
  };
}

async function deriveClassRank(
  db: SupabaseClient,
  highSchoolId: string | null,
  weightedGpa: number | null
): Promise<{ read: RankRead | null; reason: string | null }> {
  if (!highSchoolId) return { read: null, reason: "The high school isn't linked to a published profile" };
  if (weightedGpa === null) return { read: null, reason: "No weighted GPA on file" };

  const { data, error } = await db
    .from("high_school_rank_bands")
    .select("*")
    .eq("high_school_id", highSchoolId)
    .order("min_weighted_gpa", { ascending: false });
  if (error) throw fromPostgrest(error);

  const bands = (data ?? []).map((r) => toRankBand(r as Row));
  const read = rankPercentile(bands, weightedGpa);
  if (read) return { read, reason: null };
  return {
    read: null,
    reason:
      bands.length === 0
        ? "This school publishes no GPA-to-rank bands"
        : "That GPA falls below every band this school publishes",
  };
}

/** Link a typed high school name to the catalog when exactly one row matches. */
export async function matchHighSchool(db: SupabaseClient, name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { data, error } = await db
    .from("high_schools")
    .select("id")
    .ilike("name", trimmed.replace(/[%_\\]/g, (c) => `\\${c}`))
    .limit(2);
  if (error) throw fromPostgrest(error);
  return data && data.length === 1 ? String((data[0] as Row).id) : null;
}

// ---------------------------------------------------------------------------
// Polygon: derived scores
// ---------------------------------------------------------------------------

const ESSAY_SCORE: Record<string, number> = {
  "not-started": 12,
  drafting: 48,
  review: 78,
  final: 100,
};

const clampPct = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

/**
 * The derived score for each axis key we know how to derive, from what is on
 * file. Null means "nothing on file to score", which the page shows as such.
 * Same formulas as the demo's `getStudentStats`, minus its fallbacks.
 */
export async function deriveAxisScores(
  db: SupabaseClient,
  studentId: string
): Promise<Record<string, number | null>> {
  const [academics, courses, activities, awards, essays] = await Promise.all([
    db
      .from("student_academics")
      .select("gpa_weighted, sat_superscore, act_composite, rigor_count")
      .eq("student_id", studentId)
      .maybeSingle(),
    db.from("courses").select("type").eq("student_id", studentId),
    db.from("activities").select("id", { count: "exact", head: true }).eq("student_id", studentId),
    db.from("awards").select("id", { count: "exact", head: true }).eq("student_id", studentId),
    db.from("essays").select("status").eq("student_id", studentId),
  ]);
  for (const r of [academics, courses, activities, awards, essays]) {
    if (r.error) throw fromPostgrest(r.error);
  }

  const a = (academics.data ?? {}) as Row;
  const gpa = n(a.gpa_weighted);
  const sat = n(a.sat_superscore);
  const act = n(a.act_composite);

  const courseRows = (courses.data ?? []) as Row[];
  const rigorous = courseRows.filter((c) =>
    ["ap", "ib", "college", "dual-enrollment"].includes(String(c.type))
  ).length;
  const rigorCount = courseRows.length > 0 ? rigorous : n(a.rigor_count);

  const activityCount = activities.count ?? 0;
  const awardCount = awards.count ?? 0;

  const essayRows = (essays.data ?? []) as Row[];

  const grades = gpa === null ? null : clampPct((gpa / 4.5) * 100);
  return {
    grades,
    academics: grades,
    testing:
      sat !== null ? clampPct((sat / 1600) * 100) : act !== null ? clampPct((act / 36) * 100) : null,
    rigor: rigorCount === null ? null : clampPct((rigorCount / 11) * 100),
    extracurriculars:
      activityCount + awardCount === 0
        ? null
        : clampPct(((activityCount / 5) * 0.65 + (awardCount / 4) * 0.35) * 100),
    essays:
      essayRows.length === 0
        ? null
        : clampPct(
            essayRows.reduce((sum, e) => sum + (ESSAY_SCORE[String(e.status)] ?? 0), 0) /
              essayRows.length
          ),
  };
}

export type PolygonAxisDto = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  /** The counselor's score where set, else the derived one; null when neither exists. */
  score: number | null;
  autoScore: number | null;
  manualScore: number | null;
  isManual: boolean;
  custom: boolean;
  hidden: boolean;
  sortOrder: number;
};

export function toAxisDto(r: Row): PolygonAxisDto {
  const manual = n(r.manual_score);
  const auto = n(r.auto_score);
  return {
    id: String(r.id),
    key: String(r.key),
    label: String(r.label),
    description: s(r.description),
    score: manual ?? auto,
    autoScore: auto,
    manualScore: manual,
    isManual: manual !== null,
    custom: r.source === "custom",
    hidden: r.hidden === true,
    sortOrder: n(r.sort_order) ?? 0,
  };
}

/** A key for a new custom axis, unique among the student's existing keys. */
export function axisKeyFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "axis";
  let key = base;
  for (let i = 2; taken.has(key); i += 1) key = `${base}-${i}`.slice(0, 40);
  return key;
}

// ---------------------------------------------------------------------------
// Polygon: the year scrubber
// ---------------------------------------------------------------------------

export const SCHOOL_YEARS = ["Freshman", "Sophomore", "Junior", "Senior"] as const;

export type YearPoint = {
  label: (typeof SCHOOL_YEARS)[number];
  /** "2024–25" */
  schoolYear: string;
  /** True for the year in progress; its shape is today's. */
  current: boolean;
  axes: { key: string; label: string; score: number }[];
};

/**
 * One point per high school year the student has lived through, from what was
 * recorded. A school year runs August to July; the class of Y are seniors from
 * August of Y-1. A year with no reading carries the last one before it (the
 * score did not move, which is a fact); years before the first reading are
 * left out rather than drawn as zero.
 */
export function schoolYearHistory(
  rows: { axisKey: string; label: string; score: number; recordedAt: string }[],
  gradYear: number,
  visibleKeys: string[],
  now: Date = new Date()
): YearPoint[] {
  const keep = new Set(visibleKeys);
  const dated = rows
    .filter((r) => keep.has(r.axisKey))
    .map((r) => ({ ...r, at: new Date(r.recordedAt) }))
    .filter((r) => !Number.isNaN(r.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const points: YearPoint[] = [];
  const latest = new Map<string, { label: string; score: number }>();
  let cursor = 0;

  for (let i = 0; i < SCHOOL_YEARS.length; i += 1) {
    const startYear = gradYear - 4 + i;
    const start = new Date(Date.UTC(startYear, 7, 1));
    const end = new Date(Date.UTC(startYear + 1, 7, 1));
    if (start > now) break;

    // Readings from before freshman year fold into freshman year.
    while (cursor < dated.length && dated[cursor].at < end) {
      latest.set(dated[cursor].axisKey, { label: dated[cursor].label, score: dated[cursor].score });
      cursor += 1;
    }
    if (latest.size === 0) continue;

    points.push({
      label: SCHOOL_YEARS[i],
      schoolYear: `${startYear}–${String((startYear + 1) % 100).padStart(2, "0")}`,
      current: now >= start && now < end,
      axes: visibleKeys
        .filter((k) => latest.has(k))
        .map((k) => ({ key: k, ...(latest.get(k) as { label: string; score: number }) })),
    });
  }
  return points;
}
