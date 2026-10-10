/**
 * What AI may read about a student (spec §3). Deny by default: a table or
 * column not listed here is invisible to every AI feature. Loaders select
 * named columns through columns(); `select *` is forbidden in src/lib/context
 * (a unit test enforces it).
 */
export const AI_ALLOWLIST = {
  profiles: ["full_name", "grad_year", "high_school", "hometown", "headline"],
  student_academics: ["gpa_unweighted", "gpa_weighted", "gpa_scale", "class_rank", "class_rank_value",
    "rigor_count", "rigor_subjects", "test_status", "sat_ebrw", "sat_math", "sat_superscore",
    "act_composite", "strength_areas", "strength_subjects"],
  student_personal_details: ["intended_majors", "first_gen", "citizenship"],
  activities: ["name", "position", "organization", "category", "grade_levels", "hours_per_week",
    "weeks_per_year", "description", "source"],
  awards: ["name", "level", "year"],
  courses: ["name", "type", "grade", "status", "school_year", "source"],
  test_scores: ["exam", "kind", "score", "taken_on", "source"],
  student_colleges: ["name", "round", "fit", "status"],
  intake_responses: ["answers"],
  meeting_notes: ["meeting_date", "title", "summary", "tags"],
  meetings: ["title", "starts_at", "status", "agenda"],
  deadlines: ["title", "school", "type", "due_date", "level", "done"],
  student_polygon_axes: ["label", "score", "max_score", "note"],
  deliverables: ["title", "kind", "status", "due_date"],
  essays: ["title", "prompt", "school", "status", "word_count", "body"],
  documents: ["id", "filename", "title", "kind", "available_to_llm", "ai_access", "ferpa_waived", "parsed_data"],
} as const;

export type AllowTable = keyof typeof AI_ALLOWLIST;
export type AllowColumn<T extends AllowTable> = (typeof AI_ALLOWLIST)[T][number];

export function columns<T extends AllowTable>(table: T, cols: readonly AllowColumn<T>[]): string {
  const allowed = AI_ALLOWLIST[table] as readonly string[];
  for (const c of cols) {
    if (!allowed.includes(c)) throw new Error(`${table}.${c} is not on the AI allowlist`);
  }
  return cols.join(", ");
}
