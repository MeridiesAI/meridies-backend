/**
 * Deterministic header presets (spec §5.3), tried before any model. They are
 * deliberately conservative: until real exports from the first customers'
 * tools arrive (spec §13), a header maps only when it says plainly what it
 * is. "GPA" alone (weighted or not?) and "Grade" alone (a course grade or a
 * grade level?) are left for the model or the counselor.
 *
 * Vendor presets (VENDOR_PRESETS) are the same idea for a file that names a
 * tool in its headers, and they are weaker still: see the note above them.
 */

import type { ColumnProfile, SheetProfile } from "./profile.js";
import { normalizeHeader } from "./profile.js";
import { dropIncompleteGroups, type ParsePlan, type PlanColumn, type PlanSheet, type ProfiledFile, type SourceSystem, type Target } from "./plan.js";
import { scoreColumnParts } from "./textShapes.js";
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

/**
 * Header guesses for a file that names College Planner Pro or Counselmore
 * (detectSourceSystem), tried before PRESETS and marked "preset-unverified" so
 * the counselor is asked to check them (spec §13).
 *
 * UNVERIFIED. We have no real export from either tool. Nothing here is known to
 * be a header either tool writes; each alias is a common spelling of a field a
 * counseling tool plausibly carries, and the two tools share one list on purpose
 * (a difference between them would be invented). Rules that keep it honest:
 *   - Only spellings PRESETS does not already match, so a mapping marked
 *     unverified really is a guess and a file with no tool named maps as before.
 *     A tool's table may override a generic alias when a real export shows that
 *     tool means something else by it; the order (tool first) allows that, and
 *     nothing here does it yet.
 *   - Never a bare "GPA", "Grade", "School" or "Rank" (weighted? course or
 *     level? high school or college?), a test date (it belongs to a test row,
 *     which a one-row-per-student file has no exam column for), or an ID.
 *   - No parent or guardian column: an import has no place to put one, and a
 *     guess could put a parent's email where the student's belongs.
 * When a real export arrives, re-derive this list from its headers and drop the
 * ones it does not use.
 */
const COUNSELING_TOOL_GUESSES: ReadonlyArray<[RegExp, Target]> = [
  [/^(student s e ?mail( address)?)$/, key("email")],
  [/^(student s name|student s full name|name of student)$/, key("full_name")],
  [/^(student s first name|student first|student given name)$/, key("first_name")],
  [/^(student s last name|student last|student surname|student family name)$/, key("last_name")],
  [/^(graduating class|graduation class|grad class|graduating year|grad yr|graduation yr|high school graduation year|high school grad year|anticipated graduation year|projected graduation year)$/, key("grad_year")],
  [/^(highschool( name)?|high school attended|current high school name)$/, key("high_school")],
  [/^(cumulative gpa weighted|gpa cumulative weighted|weighted gpa cumulative|gpa w)$/, f("student_academics", "gpa_weighted")],
  [/^(cumulative gpa unweighted|gpa cumulative unweighted|unweighted gpa cumulative|gpa uw|gpa unw|unw gpa)$/, f("student_academics", "gpa_unweighted")],
  [/^(sat math section)$/, f("student_academics", "sat_math")],
  [/^(sat (ebrw|erw) section|sat (reading (and )?writing|evidence based reading (and )?writing) (score|section))$/, f("student_academics", "sat_ebrw")],
  [/^(sat total score|sat composite score|sat combined( score)?)$/, f("student_academics", "sat_superscore")],
  [/^(act composite score)$/, f("student_academics", "act_composite")],
  [/^(first gen student|first generation student|first gen(eration)? status)$/, f("student_personal_details", "first_gen")],
  [/^(intended major s|prospective majors?|prospective major s|major s of interest)$/, f("student_personal_details", "intended_majors")],
  // One row per activity: the abbreviations "Hrs/Wk" and "Wks/Yr".
  [/^(hrs wk|hours wk|hrs week)$/, row("activities", "hours_per_week")],
  [/^(wks yr|weeks yr|wks year)$/, row("activities", "weeks_per_year")],
];

export type VendorPresets = Partial<Record<SourceSystem, ReadonlyArray<[RegExp, Target]>>>;

/** UNVERIFIED guesses per tool; a tool absent here (or "unknown") has none. */
export const VENDOR_PRESETS: VendorPresets = {
  collegeplannerpro: COUNSELING_TOOL_GUESSES,
  counselmore: COUNSELING_TOOL_GUESSES,
};

const norm = (h: string) => normalizeHeader(h).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

function dateHints(c: ColumnProfile, sheet: SheetProfile): PlanColumn["parse"] {
  if (c.dateHints.excelSerial) return { date: sheet.date1904 ? "excel1904" : "excel1900" };
  if (c.dateHints.firstOver12 && !c.dateHints.secondOver12) return { date: "DMY" };
  return undefined;
}

export function presetTarget(header: string): Target | null {
  const h = norm(header);
  for (const [re, t] of PRESETS) if (re.test(h)) return t;
  // A score column named for its test: "AP Biology", "AP Calculus BC Score", "IB Math HL".
  const m = scoreColumnParts(header.trim());
  if (m && m[1].trim().length >= 2) {
    const exam = `${m[0].toUpperCase()} ${m[1].trim()}`.slice(0, 80);
    return { kind: "score_column", exam, testKind: testKindOf(exam) };
  }
  return null;
}

/** What a named tool's table maps the header to (UNVERIFIED), or null. */
export function vendorTarget(header: string, system: SourceSystem, tables: VendorPresets = VENDOR_PRESETS): Target | null {
  const h = norm(header);
  for (const [re, t] of tables[system] ?? []) if (re.test(h)) return t;
  return null;
}

/**
 * One sheet's preset mapping. With a tool named (`system`), that tool's table
 * is consulted first and what it maps is "preset-unverified"; everything else
 * is the generic "preset", exactly as without a tool.
 */
export function presetSheet(fileId: string, sheet: SheetProfile, system: SourceSystem = "unknown", tables: VendorPresets = VENDOR_PRESETS): PlanSheet {
  const columns: PlanColumn[] = [];
  for (const c of sheet.columns) {
    if (c.sensitive) continue;
    const guessed = vendorTarget(c.header, system, tables);
    const t = guessed ?? presetTarget(c.header);
    if (!t) continue;
    // "AP Courses Taken" isn't a score: a score column holds 1 to 7 only.
    if (t.kind === "score_column" && !(c.numeric && c.min !== null && c.max !== null && c.min >= 1 && c.max <= 7)) continue;
    const isDate = (t.kind === "field" && t.field === "birthday") || (t.kind === "row" && t.part === "taken_on");
    const parse = isDate ? dateHints(c, sheet) : undefined;
    columns.push({ index: c.index, target: t, ...(parse ? { parse } : {}), source: guessed ? "preset-unverified" : "preset" });
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

/** Which tool a file's own headers name, across all its sheets. */
export function fileSourceSystem(file: ProfiledFile): SourceSystem {
  return detectSourceSystem(file.profile.sheets.flatMap((s) => s.columns.map((c) => c.header)));
}

/**
 * A file's preset sheets. The tool is read from this file's headers before any
 * mapping is made, so a file that names one gets its guesses and another file in
 * the same import does not.
 */
export function presetSheetsFor(file: ProfiledFile, tables: VendorPresets = VENDOR_PRESETS): PlanSheet[] {
  const system = fileSourceSystem(file);
  return file.profile.sheets.map((s) => presetSheet(file.fileId, s, system, tables));
}

export function presetPlan(files: ProfiledFile[]): ParsePlan {
  const sheets = files.flatMap((file) => presetSheetsFor(file));
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
