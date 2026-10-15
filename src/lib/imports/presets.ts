/**
 * Deterministic header presets (spec §5.3), tried before any model. They are
 * deliberately conservative: until real exports from the first customers'
 * tools arrive (spec §13), a header maps only when it says plainly what it
 * is. "GPA" alone (weighted or not?) and "Grade" alone (a course grade or a
 * grade level?) are left for the model or the counselor.
 */

import type { ColumnProfile, SheetProfile } from "./profile.js";
import { normalizeHeader } from "./profile.js";
import { dropIncompleteGroups, type ParsePlan, type PlanColumn, type PlanSheet, type ProfiledFile, type SourceSystem, type Target } from "./plan.js";
import { testKindOf } from "./values.js";

const f = (table: "student_academics" | "student_personal_details", field: string): Target => ({ kind: "field", table, field });
const key = (k: "email" | "full_name" | "first_name" | "last_name" | "grad_year" | "high_school"): Target => ({ kind: "key", key: k });
const row = (table: "test_scores" | "courses" | "activities", part: string): Target => ({ kind: "row", table, group: "1", part });

/** Normalized header (lowercase, punctuation as spaces) to target. */
const PRESETS: ReadonlyArray<[RegExp, Target]> = [
  [/^(e ?mail|email address|student e ?mail|student email( address)?|primary email|login email)$/, key("email")],
  [/^(name|student name|full name|student full name|student)$/, key("full_name")],
  [/^(first name|first|given name|student first name|fname|first nm)$/, key("first_name")],
  [/^(last name|last|surname|family name|student last name|lname|last nm)$/, key("last_name")],
  [/^(class of|grad year|graduation year|class year|year of graduation|hs grad year|hs graduation year|expected graduation( year)?)$/, key("grad_year")],
  [/^(high school|high school name|current high school|current school|hs name)$/, key("high_school")],
  [/^(birth ?date|date of birth|dob|birthday)$/, f("student_personal_details", "birthday")],
  [/^(weighted gpa|gpa weighted|weighted cumulative gpa|cumulative weighted gpa|w gpa)$/, f("student_academics", "gpa_weighted")],
  [/^(unweighted gpa|gpa unweighted|unweighted cumulative gpa|cumulative unweighted gpa|uw gpa)$/, f("student_academics", "gpa_unweighted")],
  [/^(gpa scale)$/, f("student_academics", "gpa_scale")],
  [/^(class rank)$/, f("student_academics", "class_rank")],
  [/^(sat math|sat m|sat math score)$/, f("student_academics", "sat_math")],
  [/^(sat ebrw|sat erw|sat reading (and )?writing|sat evidence based reading (and )?writing|sat ebrw score)$/, f("student_academics", "sat_ebrw")],
  [/^(sat|sat total|sat composite|sat superscore|superscore sat|best sat|sat score)$/, f("student_academics", "sat_superscore")],
  [/^(act|act composite|act superscore|best act|act score)$/, f("student_academics", "act_composite")],
  [/^(test status|testing status)$/, f("student_academics", "test_status")],
  [/^(gender|sex)$/, f("student_personal_details", "gender")],
  [/^(citizenship|citizenship status)$/, f("student_personal_details", "citizenship")],
  [/^(first gen|first generation|first generation college student|first gen college)$/, f("student_personal_details", "first_gen")],
  [/^(intended majors?|intended field of study|academic interests?|majors? of interest)$/, f("student_personal_details", "intended_majors")],
  [/^(home address|mailing address|street address|address)$/, f("student_personal_details", "address")],
  [/^(contact email|personal email|alternate email|secondary email)$/, f("student_personal_details", "contact_email")],
  // One row per test.
  [/^(test|test name|exam|exam name)$/, row("test_scores", "exam")],
  [/^(test score|exam score)$/, row("test_scores", "score")],
  [/^(test date|date taken|exam date)$/, row("test_scores", "taken_on")],
  // One row per course.
  [/^(course|course name|course title)$/, row("courses", "name")],
  [/^(course type|course level)$/, row("courses", "type")],
  [/^(course grade|final grade)$/, row("courses", "grade")],
  [/^(course status)$/, row("courses", "status")],
  [/^(school year|academic year)$/, row("courses", "school_year")],
  // One row per activity.
  [/^(activity|activity name|extracurricular|extracurricular activity)$/, row("activities", "name")],
  [/^(position|leadership position|role)$/, row("activities", "position")],
  [/^(organization|organization name)$/, row("activities", "organization")],
  [/^(activity type|activity category)$/, row("activities", "category")],
  [/^(hours per week|hrs per wk|hours week)$/, row("activities", "hours_per_week")],
  [/^(weeks per year|wks per yr|weeks year)$/, row("activities", "weeks_per_year")],
  [/^(activity description|description)$/, row("activities", "description")],
  [/^(grade levels|grades participated|participation grade levels)$/, row("activities", "grade_levels")],
];

/** A score column named for its test: "AP Biology", "AP Calculus BC Score", "IB Math HL". */
const SCORE_COLUMN = /^(ap|ib)\s+(.+?)(\s+(score|exam score|result))?$/i;

const norm = (h: string) => normalizeHeader(h).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

function dateHints(c: ColumnProfile, sheet: SheetProfile): PlanColumn["parse"] {
  if (c.dateHints.excelSerial) return { date: sheet.date1904 ? "excel1904" : "excel1900" };
  if (c.dateHints.firstOver12 && !c.dateHints.secondOver12) return { date: "DMY" };
  return undefined;
}

export function presetTarget(header: string): Target | null {
  const h = norm(header);
  for (const [re, t] of PRESETS) if (re.test(h)) return t;
  const m = SCORE_COLUMN.exec(header.trim());
  if (m && m[2].trim().length >= 2) {
    const exam = `${m[1].toUpperCase()} ${m[2].trim()}`.slice(0, 80);
    return { kind: "score_column", exam, testKind: testKindOf(exam) };
  }
  return null;
}

export function presetSheet(fileId: string, sheet: SheetProfile): PlanSheet {
  const columns: PlanColumn[] = [];
  for (const c of sheet.columns) {
    if (c.sensitive) continue;
    const t = presetTarget(c.header);
    if (!t) continue;
    // "AP Courses Taken" isn't a score: a score column holds 1 to 7 only.
    if (t.kind === "score_column" && !(c.numeric && c.min !== null && c.max !== null && c.min >= 1 && c.max <= 7)) continue;
    const isDate = (t.kind === "field" && t.field === "birthday") || (t.kind === "row" && t.part === "taken_on");
    const parse = isDate ? dateHints(c, sheet) : undefined;
    columns.push({ index: c.index, target: t, ...(parse ? { parse } : {}), source: "preset" });
  }
  return { fileId, sheet: sheet.name, columns: dropIncompleteGroups(columns) };
}

/** Where the data came from, when a header names the tool plainly. */
export function detectSourceSystem(headers: string[]): SourceSystem {
  const all = headers.map(norm).join(" | ");
  if (/\bnaviance\b/.test(all)) return "naviance";
  if (/\bscoir\b/.test(all)) return "scoir";
  if (/\bcialfo\b/.test(all)) return "cialfo";
  if (/\bcollege ?planner ?pro\b|\bcpp id\b/.test(all)) return "collegeplannerpro";
  if (/\bcounsel ?more\b/.test(all)) return "counselmore";
  if (/\bgrad ?better\b/.test(all)) return "gradbetter";
  if (/\brecord id\b/.test(all) && /\bcontact owner\b/.test(all)) return "hubspot";
  return "unknown";
}

export function presetPlan(files: ProfiledFile[]): ParsePlan {
  const sheets = files.flatMap((file) => file.profile.sheets.map((s) => presetSheet(file.fileId, s)));
  const headers = files.flatMap((file) => file.profile.sheets.flatMap((s) => s.columns.map((c) => c.header)));
  return { version: 1, sheets, constants: {}, sourceSystem: detectSourceSystem(headers) };
}

/** Columns no preset or template mapped, per sheet (what the model may be asked about). */
export function unmappedColumns(plan: ParsePlan, files: ProfiledFile[]): Array<{ fileId: string; sheet: SheetProfile; indexes: Set<number> }> {
  const out: Array<{ fileId: string; sheet: SheetProfile; indexes: Set<number> }> = [];
  for (const file of files) {
    for (const sheet of file.profile.sheets) {
      const mapped = new Set(plan.sheets.find((s) => s.fileId === file.fileId && s.sheet === sheet.name)?.columns.map((c) => c.index) ?? []);
      const indexes = new Set(sheet.columns.filter((c) => !mapped.has(c.index) && !c.sensitive && c.nonEmpty > 0).map((c) => c.index));
      if (indexes.size > 0) out.push({ fileId: file.fileId, sheet, indexes });
    }
  }
  return out;
}
