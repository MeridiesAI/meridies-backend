/**
 * Past students (`GET /alumni/analysis`): every alum on the caller's caseload
 * with what they applied with and where it went, in one read.
 *
 * A past student is an `alumni_records` row (Close cycle writes one per
 * senior; nothing else does). What they applied with is read live from the
 * record: `student_academics` (GPA with its scale, SAT superscore, ACT
 * composite) and `activities`. Where they applied is the college list's
 * decided statuses (`student_colleges`, the labels the app already shows),
 * with any result recorded only in `admission_outcomes` (a hand-entered row,
 * or one whose list row was since deleted) filling in a school the list no
 * longer has. The enrolled school is the alum record's (the alum page edits
 * it), else the list's `enrolled` row.
 *
 * Nothing here is aggregated across students, so no small-number rule
 * applies: the counselor sees their own students by name, as on Overview.
 */

type Row = Record<string, unknown>;

/** The app's labels for a decided school (`denied` is shown as Rejected). */
export const PAST_RESULTS = ["enrolled", "accepted", "waitlisted", "deferred", "denied", "withdrawn"] as const;
export type PastResult = (typeof PAST_RESULTS)[number];

/** How many activity names a row carries beside the count. */
export const TOP_ACTIVITIES = 3;

export type PastSchool = {
  name: string;
  collegeId: string | null;
  /** Null: submitted, no result recorded. */
  result: PastResult | null;
  round: string | null;
  decisionDate: string | null;
};

export type PastStudent = {
  studentId: string;
  name: string | null;
  email: string | null;
  gradYear: string | null;
  cycle: string;
  highSchool: string | null;
  gpa: { unweighted: number | null; weighted: number | null; scale: string | null };
  sat: number | null;
  act: number | null;
  activities: { count: number; top: string[] };
  schools: PastSchool[];
  enrolled: { name: string; collegeId: string | null } | null;
};

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A college list status as a past result; undecided statuses are not applications. */
export function listResult(status: unknown): PastResult | null | undefined {
  switch (status) {
    case "accepted":
    case "denied":
    case "waitlisted":
    case "deferred":
    case "withdrawn":
    case "enrolled":
      return status;
    case "submitted":
      return null;
    default:
      return undefined;
  }
}

/** An `admission_outcomes` result in the list's words. */
export function outcomeResult(result: unknown, enrolled: unknown): PastResult | undefined {
  if (result === "admitted") return enrolled === true ? "enrolled" : "accepted";
  if (result === "denied" || result === "waitlisted" || result === "deferred" || result === "withdrawn") return result;
  return undefined;
}

const RANK: Record<string, number> = { enrolled: 0, accepted: 1, waitlisted: 2, deferred: 3, denied: 4, withdrawn: 5 };
const rankOf = (r: PastResult | null) => (r === null ? 6 : RANK[r]);

const schoolKey = (collegeId: string | null, name: string) => (collegeId ? `id:${collegeId}` : `name:${name.toLowerCase()}`);

/** The schools one alum applied to: the list first, outcomes only where the list has no such school. */
export function mergeSchools(listRows: Row[], outcomeRows: Row[]): PastSchool[] {
  const out = new Map<string, PastSchool>();
  const names = new Set<string>();
  for (const r of listRows) {
    const result = listResult(r.status);
    const name = str(r.name);
    if (result === undefined || !name) continue;
    const collegeId = str(r.college_id);
    out.set(schoolKey(collegeId, name), {
      name,
      collegeId,
      result,
      round: str(r.round),
      decisionDate: str(r.decision_date),
    });
    names.add(name.toLowerCase());
  }
  for (const r of outcomeRows) {
    const result = outcomeResult(r.result, r.enrolled);
    const name = str(r.college_name);
    if (result === undefined || !name) continue;
    const collegeId = str(r.college_id);
    const key = schoolKey(collegeId, name);
    // A list row typed by name and an outcome carrying the catalog id are the same school.
    if (out.has(key) || names.has(name.toLowerCase())) continue;
    out.set(key, { name, collegeId, result, round: str(r.round), decisionDate: null });
    names.add(name.toLowerCase());
  }
  return [...out.values()].sort((a, b) => rankOf(a.result) - rankOf(b.result) || a.name.localeCompare(b.name));
}

/** An activity's short name: what it is, else the role, else where. */
export function activityName(r: Row): string | null {
  return str(r.name) ?? str(r.position) ?? str(r.organization);
}

function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = String(r[key]);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export type PastStudentSources = {
  alumni: Row[];
  profiles: Row[];
  academics: Row[];
  activities: Row[];
  colleges: Row[];
  outcomes: Row[];
};

/** Rows -> the DTO, one per alum, newest class first, then by name. */
export function buildPastStudents(src: PastStudentSources): PastStudent[] {
  const profiles = new Map(src.profiles.map((p) => [String(p.id), p]));
  const academics = new Map(src.academics.map((a) => [String(a.student_id), a]));
  const activities = groupBy(src.activities, "student_id");
  const colleges = groupBy(src.colleges, "student_id");
  const outcomes = groupBy(src.outcomes, "student_id");

  const students = src.alumni.map((alum): PastStudent => {
    const id = String(alum.student_id);
    const p = profiles.get(id) ?? {};
    const a = academics.get(id) ?? {};
    const acts = [...(activities.get(id) ?? [])].sort((x, y) => (num(x.sort_order) ?? 0) - (num(y.sort_order) ?? 0));
    const schools = mergeSchools(colleges.get(id) ?? [], outcomes.get(id) ?? []);
    const recorded = str(alum.institution_name);
    const listEnrolled = schools.find((s) => s.result === "enrolled");
    return {
      studentId: id,
      name: str(p.full_name),
      email: str(p.email),
      gradYear: str(p.grad_year),
      cycle: String(alum.cycle),
      highSchool: str(p.high_school),
      gpa: { unweighted: num(a.gpa_unweighted), weighted: num(a.gpa_weighted), scale: str(a.gpa_scale) },
      sat: num(a.sat_superscore),
      act: num(a.act_composite),
      activities: {
        count: acts.length,
        top: acts
          .map(activityName)
          .filter((n): n is string => n !== null)
          .slice(0, TOP_ACTIVITIES),
      },
      schools,
      enrolled: recorded
        ? { name: recorded, collegeId: str(alum.college_id) }
        : listEnrolled
          ? { name: listEnrolled.name, collegeId: listEnrolled.collegeId }
          : null,
    };
  });

  return students.sort(
    (x, y) =>
      (y.gradYear ?? y.cycle.slice(5)).localeCompare(x.gradYear ?? x.cycle.slice(5)) ||
      (x.name ?? x.email ?? "").localeCompare(y.name ?? y.email ?? "")
  );
}

/** Ids in slices small enough for a PostgREST `in` filter in the URL. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
