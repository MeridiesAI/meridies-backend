/**
 * The admission outcomes database (demo v7), read the way AxIS and the next
 * cycle's list building read it: per high school and college, the practice's
 * own history rather than a national average.
 *
 * Two rules carried over from the demo, both about honesty:
 *  - a deferral that later resolves is one application, not two;
 *  - a high school's admits are flagged against a college's CDS middle 50%
 *    only with two or more admits that carry an SAT, and only when the CDS
 *    range is actually on file (college_admission_stats with its source). No
 *    range means no flag, never an assumed one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fromPostgrest } from "./errors.js";

type Row = Record<string, unknown>;

export const ROUNDS = ["ED", "ED2", "EA", "REA", "SCEA", "RD", "rolling", "priority"] as const;
export const RESULTS = ["admitted", "denied", "waitlisted", "deferred", "withdrawn"] as const;
export const HOOKS = ["first_gen", "full_pay", "recruited_athlete", "legacy", "ed"] as const;

export const OUTCOME_COLUMNS =
  "id, counselor_id, student_id, student_name, high_school_id, high_school_name, cycle, college_id, " +
  "college_name, round, result, enrolled, gpa_unweighted, gpa_weighted, sat, act, hooks, " +
  "intended_major, locked, locked_at, created_at, updated_at";

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

export function toOutcome(r: Row) {
  return {
    id: String(r.id),
    counselorId: String(r.counselor_id),
    studentId: r.student_id ? String(r.student_id) : null,
    studentName: r.student_name ? String(r.student_name) : null,
    highSchoolName: String(r.high_school_name),
    cycle: String(r.cycle),
    collegeId: r.college_id ? String(r.college_id) : null,
    collegeName: String(r.college_name),
    round: String(r.round) as (typeof ROUNDS)[number],
    result: String(r.result) as (typeof RESULTS)[number],
    enrolled: r.enrolled === true,
    gpaUnweighted: num(r.gpa_unweighted),
    gpaWeighted: num(r.gpa_weighted),
    sat: num(r.sat),
    act: num(r.act),
    hooks: (Array.isArray(r.hooks) ? r.hooks : []) as (typeof HOOKS)[number][],
    intendedMajor: r.intended_major ? String(r.intended_major) : null,
    locked: r.locked === true,
    lockedAt: r.locked_at ? String(r.locked_at) : null,
    createdAt: String(r.created_at),
  };
}
export type Outcome = ReturnType<typeof toOutcome>;

/** The cycle a date falls in: applications open in August. */
export function cycleFor(date = new Date()): string {
  const y = date.getUTCFullYear();
  return date.getUTCMonth() >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Seniors in a cycle graduate with its second year: 2026-2027 is the class of 2027. */
export function classOfCycle(cycle: string): string {
  return cycle.slice(5);
}

export type CdsRange = { sat25: number; sat75: number; cohortYear: number; sourceUrl: string | null };

/** The latest published SAT middle 50% per college, where one is on file. */
export async function cdsRanges(db: SupabaseClient, collegeIds: string[]): Promise<Map<string, CdsRange>> {
  const out = new Map<string, CdsRange>();
  const ids = [...new Set(collegeIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("college_admission_stats")
    .select("college_id, cohort_year, sat_25, sat_75, source_url")
    .in("college_id", ids)
    .not("sat_25", "is", null)
    .not("sat_75", "is", null)
    .order("cohort_year", { ascending: false });
  if (error) throw fromPostgrest(error);
  for (const r of (data ?? []) as Row[]) {
    const id = String(r.college_id);
    if (out.has(id)) continue;
    out.set(id, {
      sat25: Number(r.sat_25),
      sat75: Number(r.sat_75),
      cohortYear: Number(r.cohort_year),
      sourceUrl: r.source_url ? String(r.source_url) : null,
    });
  }
  return out;
}

const keyOf = (o: Outcome) => o.collegeId ?? `name:${o.collegeName.trim().toLowerCase()}`;

export type SchoolHistory = {
  collegeId: string | null;
  collegeName: string;
  applied: number;
  admitted: number;
  enrolled: number;
  medianAdmitSat: number | null;
  admitsWithSat: number;
  cds: CdsRange | null;
};

/** Per college, what happened when this high school's students applied. */
export function summarize(outcomes: Outcome[], ranges: Map<string, CdsRange>): SchoolHistory[] {
  const groups = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    const k = keyOf(o);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const out: SchoolHistory[] = [];
  for (const rows of groups.values()) {
    // A deferral that later resolves is one application, not two.
    const byApplicant = new Map<string, Outcome>();
    for (const r of rows) {
      const who = r.studentId ?? r.studentName ?? r.id;
      const prev = byApplicant.get(who);
      if (!prev || prev.result === "deferred") byApplicant.set(who, r);
    }
    const finals = [...byApplicant.values()];
    const admits = finals.filter((r) => r.result === "admitted");
    const sats = admits.map((r) => r.sat).filter((s): s is number => typeof s === "number").sort((a, b) => a - b);
    const first = rows[0];
    out.push({
      collegeId: first.collegeId,
      collegeName: first.collegeName,
      applied: finals.length,
      admitted: admits.length,
      enrolled: finals.filter((r) => r.enrolled).length,
      medianAdmitSat: sats.length ? sats[Math.floor(sats.length / 2)] : null,
      admitsWithSat: sats.length,
      cds: first.collegeId ? ranges.get(first.collegeId) ?? null : null,
    });
  }
  return out.sort((a, b) => b.applied - a.applied || a.collegeName.localeCompare(b.collegeName));
}

export type Unexpected = {
  collegeId: string;
  collegeName: string;
  direction: "below" | "above";
  medianAdmitSat: number;
  cds: CdsRange;
};

/** Colleges where this school's admits sit 30+ points outside the CDS middle 50%. */
export function unexpected(history: SchoolHistory[]): Unexpected[] {
  const out: Unexpected[] = [];
  for (const h of history) {
    if (!h.cds || !h.collegeId || h.medianAdmitSat === null || h.admitsWithSat < 2) continue;
    if (h.medianAdmitSat < h.cds.sat25 - 30)
      out.push({ collegeId: h.collegeId, collegeName: h.collegeName, direction: "below", medianAdmitSat: h.medianAdmitSat, cds: h.cds });
    if (h.medianAdmitSat > h.cds.sat75 + 30)
      out.push({ collegeId: h.collegeId, collegeName: h.collegeName, direction: "above", medianAdmitSat: h.medianAdmitSat, cds: h.cds });
  }
  return out;
}

/** "Cornell University: 2 of 3 from Lincoln High School admitted, median admit SAT 1510 (CDS middle 50% 1470–1560)." */
export function historyLine(highSchool: string, h: SchoolHistory): string {
  const sat = h.medianAdmitSat ? `, median admit SAT ${h.medianAdmitSat}` : "";
  const cds = h.cds ? ` (CDS middle 50% ${h.cds.sat25}–${h.cds.sat75})` : "";
  return `${h.collegeName}: ${h.admitted} of ${h.applied} from ${highSchool} admitted${sat}${cds}.`;
}

/** Every outcome this counselor (and their firm) can see for a high school, by name. */
export async function outcomesForHighSchool(db: SupabaseClient, highSchool: string): Promise<Outcome[]> {
  const { data, error } = await db
    .from("admission_outcomes")
    .select(OUTCOME_COLUMNS)
    .ilike("high_school_name", highSchool.replace(/[%_\\]/g, (c) => `\\${c}`))
    .limit(2000);
  if (error) throw fromPostgrest(error);
  return ((data ?? []) as unknown as Row[]).map(toOutcome);
}
