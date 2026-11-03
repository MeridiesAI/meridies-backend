/**
 * AI help for the questionnaire's tables (POST /me/intake/fill).
 *
 * A student types a line ("I took apes, ap calc ab in 11th, got a 5 on ap
 * bio") or adds a photo of a class schedule or transcript, and gets back rows
 * for one of the questionnaire's tables: courses, AP / IB exam scores, honors
 * or activities. Nothing is stored here. The app appends the rows to the table
 * for the student to check, and the questionnaire's normal save stores them,
 * so the database's questionnaire sync (20261023010002) reads them like any
 * typed row. That is why every value here is one of the questionnaire's own
 * option values (lib/aggregator.ts in the app), never a label.
 *
 * The model only cleans and sorts what the student gave it; the code below is
 * the last word on what comes back: each value is mapped onto the table's
 * options or dropped, text is trimmed and capped, names are cased, a few
 * common abbreviations are expanded, duplicates and empty rows go, and the row
 * count is capped at the table's own limit. Pure, so it is unit tested
 * (test/unit/intake-fill.test.ts).
 */

import { z } from "zod";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./context/pack.js";

export const INTAKE_FILL_SECTIONS = ["courses", "exams", "awards", "activities"] as const;
export type IntakeFillSection = (typeof INTAKE_FILL_SECTIONS)[number];

export const MAX_FILL_TEXT = 4000;
/** Decoded image bytes. */
export const MAX_FILL_IMAGE_BYTES = 5 * 1024 * 1024;
/** Base64 grows 4/3, plus padding. */
const MAX_FILL_IMAGE_CHARS = Math.ceil((MAX_FILL_IMAGE_BYTES * 4) / 3) + 4;

export const FILL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type FillImageType = (typeof FILL_IMAGE_TYPES)[number];

/** Each table's own row cap (the questionnaire's maxRows). */
export const ROW_CAPS: Record<IntakeFillSection, number> = { courses: 20, exams: 15, awards: 25, activities: 20 };

export const intakeFillBody = z
  .object({
    section: z.enum(INTAKE_FILL_SECTIONS),
    text: z.string().max(MAX_FILL_TEXT).optional(),
    image: z
      .object({
        mediaType: z.enum(FILL_IMAGE_TYPES),
        data: z.string().min(16).max(MAX_FILL_IMAGE_CHARS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => Boolean(b.text?.trim()) || Boolean(b.image), {
    message: "Type what you took or add a picture of your schedule",
  });

export type IntakeFillBody = z.infer<typeof intakeFillBody>;

// ---------------------------------------------------------------------------
// The image
// ---------------------------------------------------------------------------

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The picture's bytes, checked: real base64, under the size cap, and the
 * format it claims to be (by its first bytes, not its name). Throws a sentence
 * the student can read.
 */
export function checkFillImage(image: { mediaType: FillImageType; data: string }): { mediaType: FillImageType; data: string } {
  const data = image.data.trim();
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw new Error("That picture couldn't be read. Try a PNG or JPEG.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) throw new Error("That picture is empty.");
  if (bytes.length > MAX_FILL_IMAGE_BYTES) throw new Error("That picture is over 5 MB. Try a smaller one.");
  if (sniffImage(bytes) !== image.mediaType) throw new Error("That picture couldn't be read. Try a PNG or JPEG.");
  return { mediaType: image.mediaType, data };
}

export function sniffImage(b: Buffer): FillImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// ---------------------------------------------------------------------------
// Option values (the app's lib/aggregator.ts)
// ---------------------------------------------------------------------------

export const COURSE_TYPES = ["ap", "ib", "honors", "de", "other"] as const;
export const GRADE_LEVELS = ["9", "10", "11", "12", "pg"] as const;
export const COURSE_STATUSES = ["completed", "inprogress", "planned"] as const;
export const EXAM_SCORES = ["5", "4", "3", "2", "1", "pending"] as const;
export const AWARD_LEVELS = ["international", "national", "state", "school"] as const;
export const TIMINGS = ["school", "break", "year"] as const;
/** The questionnaire's activity categories, exactly as its select holds them. */
export const ACTIVITY_CATEGORIES = [
  "Academic", "Art", "Athletics: Club", "Athletics: JV/Varsity", "Career-Oriented",
  "Community Service (Volunteer)", "Computer/Technology", "Cultural", "Dance", "Debate/Speech",
  "Environmental", "Family Responsibilities", "Foreign Exchange", "Foreign Language", "Internship",
  "Journalism/Publication", "Junior R.O.T.C.", "LGBT", "Music: Instrumental", "Music: Vocal",
  "Religious", "Research", "Robotics", "School Spirit", "Science/Math", "Social Justice",
  "Student Govt./Politics", "Theater/Drama", "Work (Paid)", "Other Club/Activity",
] as const;

export type CourseRow = { name: string; type: string; grade: string; status: string };
export type ExamRow = { exam: string; score: string };
export type AwardRow = { name: string; level: string; year: string };
export type ActivityRow = {
  category: string;
  gradeLevels: string[];
  timing: string;
  hoursPerWeek: string;
  weeksPerYear: string;
  position: string;
  organization: string;
  description: string;
};
export type FillRows = CourseRow[] | ExamRow[] | AwardRow[] | ActivityRow[];

// ---------------------------------------------------------------------------
// Text helpers (linear: the input is capped first, and every pattern is a
// single pass with no nested quantifier)
// ---------------------------------------------------------------------------

/** Trim, collapse runs of whitespace, drop control characters, cap. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.slice(0, max * 4).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

const KEEP_UPPER = new Set(["AP", "IB", "HL", "SL", "AB", "BC", "US", "USA", "UK", "CS", "II", "III", "IV", "STEM", "ROTC", "DECA", "FBLA", "HOSA", "NHS", "MUN", "SAT", "ACT", "PSAT", "AMC", "AIME", "USAMO", "ISEF", "JV", "DE", "UN", "AI"]);
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/**
 * Proper case for a name typed all in one case ("ap calc ab", "AP BIOLOGY").
 * A name that already mixes cases is the student's (or the school's) and stays.
 */
export function properCase(s: string): string {
  if (!s) return s;
  const hasLower = s !== s.toUpperCase();
  const hasUpper = s !== s.toLowerCase();
  if (hasLower && hasUpper) return s;
  const words = s.split(" ");
  return words
    .map((w, i) => {
      const bare = w.replace(/[^A-Za-z]/g, "");
      if (KEEP_UPPER.has(bare.toUpperCase()) && bare.length > 0) return w.toUpperCase();
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/**
 * The common shorthands for AP courses, as a backstop to the model. Keyed by
 * the lowercased name with spaces collapsed; only a whole-name match expands.
 */
const COURSE_SHORTHANDS: Record<string, string> = {
  apes: "AP Environmental Science",
  "ap enviro": "AP Environmental Science",
  "ap env sci": "AP Environmental Science",
  apush: "AP United States History",
  "ap us history": "AP United States History",
  apwh: "AP World History: Modern",
  "ap world": "AP World History: Modern",
  "ap euro": "AP European History",
  "ap lang": "AP English Language and Composition",
  "ap lit": "AP English Literature and Composition",
  "ap calc ab": "AP Calculus AB",
  "ap calc bc": "AP Calculus BC",
  "ap bio": "AP Biology",
  "ap chem": "AP Chemistry",
  "ap gov": "AP United States Government and Politics",
  "ap us gov": "AP United States Government and Politics",
  "ap psych": "AP Psychology",
  "ap stats": "AP Statistics",
  "ap stat": "AP Statistics",
  "ap csa": "AP Computer Science A",
  "ap csp": "AP Computer Science Principles",
  "ap macro": "AP Macroeconomics",
  "ap micro": "AP Microeconomics",
  "ap hug": "AP Human Geography",
  "ap human geo": "AP Human Geography",
  "ap phys 1": "AP Physics 1",
  "ap physics c mech": "AP Physics C: Mechanics",
  "ap span": "AP Spanish Language and Culture",
  "ap spanish": "AP Spanish Language and Culture",
  "ap french": "AP French Language and Culture",
  "ap art history": "AP Art History",
  "ap music theory": "AP Music Theory",
};

/** A course or exam name: shorthand expanded, cased, capped. */
export function courseName(v: unknown, max = 200): string {
  const s = cleanText(v, max);
  if (!s) return "";
  const key = s.toLowerCase().replace(/\./g, "");
  return COURSE_SHORTHANDS[key] ?? properCase(s);
}

function pick<T extends string>(v: unknown, allowed: readonly T[], synonyms: Record<string, T> = {}): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const s = String(v).trim().toLowerCase().slice(0, 60);
  if (!s) return "";
  const exact = allowed.find((a) => a.toLowerCase() === s);
  if (exact) return exact;
  return synonyms[s] ?? "";
}

export function courseType(v: unknown, name: string): string {
  const t = pick(v, COURSE_TYPES, {
    "advanced placement": "ap",
    "international baccalaureate": "ib",
    honor: "honors",
    "dual enrollment": "de",
    "dual-enrollment": "de",
    "dual credit": "de",
    "college": "de",
    "other advanced": "other",
  });
  if (t) return t;
  // Read off the name when the model left it out.
  const n = name.toLowerCase();
  if (n.startsWith("ap ")) return "ap";
  if (n.startsWith("ib ")) return "ib";
  if (n.startsWith("honors ") || n.endsWith(" honors")) return "honors";
  if (n.includes("dual enrollment")) return "de";
  return "";
}

export function gradeLevel(v: unknown): string {
  return pick(v, GRADE_LEVELS, {
    "9th": "9", ninth: "9", freshman: "9", "grade 9": "9",
    "10th": "10", tenth: "10", sophomore: "10", "grade 10": "10",
    "11th": "11", eleventh: "11", junior: "11", "grade 11": "11",
    "12th": "12", twelfth: "12", senior: "12", "grade 12": "12",
    "post-grad": "pg", postgrad: "pg", "post grad": "pg",
  });
}

export function courseStatus(v: unknown): string {
  return pick(v, COURSE_STATUSES, {
    complete: "completed", done: "completed", finished: "completed", taken: "completed",
    "in progress": "inprogress", "in-progress": "inprogress", current: "inprogress", taking: "inprogress", "currently taking": "inprogress",
    plan: "planned", "planning": "planned", scheduled: "planned", future: "planned", "will take": "planned",
  });
}

/**
 * An exam score as the questionnaire's option value. The option is the AP
 * score with the IB score beside it ("5 / 7"), so an IB 7 is "5", an IB 6 is
 * "4", and so on down to an IB 3 ("1").
 */
export function examScore(v: unknown, exam: string): string {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().toLowerCase().slice(0, 40) : "";
  if (!s) return "";
  if (["pending", "awaiting", "awaiting score", "not back yet", "waiting"].includes(s)) return "pending";
  const n = Number(s);
  if (!Number.isInteger(n)) return "";
  const ib = /^ib\b/i.test(exam);
  if (ib) return n >= 3 && n <= 7 ? String(n - 2) : "";
  return n >= 1 && n <= 5 ? String(n) : "";
}

export function awardLevel(v: unknown): string {
  return pick(v, AWARD_LEVELS, {
    "state / regional": "state", regional: "state", state_regional: "state",
    "school / local": "school", local: "school", "school/local": "school",
    "state/regional": "state", international: "international", national: "national",
  });
}

export function awardYear(v: unknown): string {
  const s = cleanText(typeof v === "number" ? String(v) : v, 20);
  const m = /\b(19|20)\d{2}\b/.exec(s);
  return m ? m[0] : "";
}

export function activityCategory(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim().toLowerCase().slice(0, 60);
  return ACTIVITY_CATEGORIES.find((c) => c.toLowerCase() === s) ?? (s ? "Other Club/Activity" : "");
}

function wholeNumber(v: unknown, max: number): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) return "";
  return String(Math.min(max, Math.round(n)));
}

function timing(v: unknown): string {
  return pick(v, TIMINGS, {
    "school year": "school", "during school year": "school",
    summer: "break", "school break": "break", "during school break": "break",
    "all year": "year", "year-round": "year", "year round": "year",
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function rowsOf(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && !Array.isArray(r)).slice(0, 60);
}

function dedupe<T>(rows: T[], key: (r: T) => string, cap: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = key(r).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

/** The model's answer turned into rows the table can hold, or nothing. */
export function normalizeFill(section: IntakeFillSection, value: unknown): FillRows {
  const raw = rowsOf(value);
  const cap = ROW_CAPS[section];
  switch (section) {
    case "courses":
      return dedupe(
        raw.map((r) => {
          const name = courseName(r.name, 300);
          return { name, type: courseType(r.type, name), grade: gradeLevel(r.grade), status: courseStatus(r.status) };
        }),
        (r) => r.name,
        cap
      );
    case "exams":
      return dedupe(
        raw.map((r) => {
          const exam = courseName(r.exam, 200);
          return { exam, score: examScore(r.score, exam) };
        }),
        (r) => r.exam,
        cap
      );
    case "awards":
      return dedupe(
        raw.map((r) => ({ name: properCaseIfFlat(cleanText(r.name, 100)), level: awardLevel(r.level), year: awardYear(r.year) })),
        (r) => `${r.name}|${r.year}`,
        cap
      ).filter((r) => r.name);
    case "activities":
      return dedupe(
        raw.map((r) => ({
          category: activityCategory(r.category),
          gradeLevels: Array.isArray(r.gradeLevels)
            ? [...new Set(r.gradeLevels.slice(0, 10).map(gradeLevel).filter(Boolean))].sort(byGrade)
            : [],
          timing: timing(r.timing),
          hoursPerWeek: wholeNumber(r.hoursPerWeek, 168),
          weeksPerYear: wholeNumber(r.weeksPerYear, 52),
          position: properCaseIfFlat(cleanText(r.position, 50)),
          organization: properCaseIfFlat(cleanText(r.organization, 100)),
          description: cleanText(r.description, 150),
        })),
        (r) => `${r.organization}|${r.position}|${r.category}`.replace(/^\|+$/, ""),
        cap
      ).filter((r) => r.organization || r.position || r.category);
  }
}

const GRADE_ORDER: readonly string[] = GRADE_LEVELS;
const byGrade = (a: string, b: string) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b);

/** Case a name only when it was typed all in one case. */
function properCaseIfFlat(s: string): string {
  return properCase(s);
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

const S = (extra: Record<string, unknown> = {}) => ({ type: "string", ...extra });

export const FILL_SCHEMAS: Record<IntakeFillSection, Record<string, unknown>> = {
  courses: rowsSchema({
    name: S({ description: "Full course name, e.g. AP Environmental Science" }),
    type: S({ enum: [...COURSE_TYPES, ""] }),
    grade: S({ enum: [...GRADE_LEVELS, ""], description: "Grade level the course was taken in" }),
    status: S({ enum: [...COURSE_STATUSES, ""] }),
  }),
  exams: rowsSchema({
    exam: S({ description: "Full exam name, e.g. AP Biology or IB Chemistry HL" }),
    score: S({ description: "The score as stated (1-5 for AP, 1-7 for IB), or pending" }),
  }),
  awards: rowsSchema({
    name: S(),
    level: S({ enum: [...AWARD_LEVELS, ""] }),
    year: S({ description: "Four-digit year received, or empty" }),
  }),
  activities: rowsSchema({
    category: S({ enum: [...ACTIVITY_CATEGORIES, ""] }),
    gradeLevels: { type: "array", items: S({ enum: [...GRADE_LEVELS] }) },
    timing: S({ enum: [...TIMINGS, ""] }),
    hoursPerWeek: S(),
    weeksPerYear: S(),
    position: S(),
    organization: S(),
    description: S({ description: "Only what the student said about it, at most 150 characters, or empty" }),
  }),
};

function rowsSchema(props: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: { rows: { type: "array", items: { type: "object", properties: props, required: Object.keys(props) } } },
    required: ["rows"],
  };
}

const WHAT: Record<IntakeFillSection, string> = {
  courses: "advanced courses (AP, IB, honors, dual enrollment) the student has taken, is taking or plans to take",
  exams: "AP and IB exam scores the student has received or is waiting on",
  awards: "honors and awards the student has received",
  activities: "extracurricular activities",
};

export function fillSystem(section: IntakeFillSection): string {
  return [
    `You fill in one table of a student's college profile: ${WHAT[section]}.`,
    "Read the student's words and, when given, the picture of their schedule or transcript, and return one row per item.",
    "Only include what the words or picture state. Never invent a course, score, award or activity, and leave a field empty when it isn't stated.",
    "Clean the formatting: proper capitalization and full official names (\"apes\" is AP Environmental Science, \"ap calc ab\" is AP Calculus AB, \"apush\" is AP United States History).",
    "Use only the listed values for type, grade, status, level, category and timing. A grade is the grade level (9, 10, 11, 12) the course was taken in, not a mark.",
    "Do not write descriptions, essays or sentences for the student. A description, when asked for, is only the student's own words, shortened.",
    UNTRUSTED_DATA_RULE,
  ].join("\n");
}

export function fillPrompt(section: IntakeFillSection, text: string | undefined, hasImage: boolean): string {
  const parts = [`Table: ${section}.`];
  if (hasImage) parts.push("The picture above is the student's own schedule or transcript.");
  const t = cleanText(text, MAX_FILL_TEXT);
  if (t) parts.push(wrapUntrusted("student", t));
  parts.push("Return the rows.");
  return parts.join("\n");
}
