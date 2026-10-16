/**
 * Imported values (spec §4.2, §5.4): the TypeScript mirror of
 * private.import_value_ok_raw, and the deterministic cleanup that turns a
 * cell's text into the JSON a value_type accepts. There is no value
 * conversion: a GPA stays on its own scale, a grade stays as written. Cleanup
 * only parses (trim, "3.8/4.0", thousands separators, %, date orders, Excel
 * serials, yes/no, enum synonyms).
 *
 * import-values.test.ts checks the mirror against the same cases as the SQL.
 */

import { isEmailShape, splitListCell } from "./textShapes.js";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type DateOrder = "MDY" | "DMY" | "YMD" | "excel1900" | "excel1904";

const absent = (v: Json | undefined) => v === undefined || v === null;
const str = (v: Json | undefined): string | null => (typeof v === "string" ? v : null);
const num = (v: Json | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function textOk(v: Json | undefined, max: number): boolean {
  const s = str(v);
  return s !== null && s.trim().length >= 1 && s.trim().length <= max;
}

export function isIsoDate(s: string | null): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const GENDERS = ["female", "male", "non-binary", "undisclosed"] as const;
export const CITIZENSHIP = ["us-citizen", "permanent-resident", "international"] as const;
export const TEST_STATUS = ["not-started", "prepping", "scheduled", "taken", "retaking", "test-optional"] as const;
export const TEST_KINDS = ["ap", "sat", "act", "ib", "toefl", "ielts", "other"] as const;
export const COURSE_TYPES = ["ap", "ib", "honors", "dual-enrollment", "college", "other"] as const;
export const COURSE_STATUS = ["planned", "in-progress", "completed"] as const;

const ROW_KEYS: Record<string, readonly string[]> = {
  "row:test_score": ["exam", "kind", "score", "taken_on"],
  "row:course": ["name", "type", "grade", "status", "school_year"],
  "row:activity": [
    "name", "position", "organization", "category", "hours_per_week", "weeks_per_year", "description", "grade_levels",
    // The questionnaire's sheet columns (20261023010001).
    "timing", "continuing", "uc_description",
  ],
  // An Awards & Honors row (20261023010001). Written by the questionnaire; no
  // import plan maps to it yet, but a stored value must still read as valid.
  "row:award": ["name", "level", "year", "grade_levels", "recognition_levels", "uc_level", "uc_criteria", "uc_earned"],
};

export const ACTIVITY_TIMING = ["school", "break", "year"] as const;
export const AWARD_GRADES = ["9", "10", "11", "12", "PG"] as const;
export const AWARD_RECOGNITION = ["school", "state-regional", "national", "international"] as const;
export const AWARD_UC_LEVELS = ["school", "city-community", "state", "regional", "national", "international"] as const;

const strIn = (list: readonly string[]) => (x: Json) => list.includes(str(x) ?? "\u0000");
const arrayOf = (max: number | null, ok: (e: Json) => boolean) => (x: Json) =>
  Array.isArray(x) && (max === null || x.length <= max) && x.every((e) => str(e) !== null && ok(e));

/** private.import_value_ok, in TypeScript. Never throws; undecidable is false. */
export function valueOk(type: string, v: Json | undefined): boolean {
  if (absent(v)) return false;
  const n = num(v);
  switch (type) {
    case "gpa":
      return n !== null && n >= 0 && n <= 110;
    case "sat_total":
      return n !== null && Number.isInteger(n) && n >= 400 && n <= 1600;
    case "sat_section":
      return n !== null && Number.isInteger(n) && n >= 200 && n <= 800;
    case "act_composite":
      return n !== null && Number.isInteger(n) && n >= 1 && n <= 36;
    case "date":
      return isIsoDate(str(v));
    case "email": {
      const s = str(v);
      return s !== null && s.length <= 320 && isEmailShape(s);
    }
    case "bool":
      return typeof v === "boolean";
    case "grad_year":
      // profiles.grad_year is text; a class year reads like 2027.
      return /^20\d\d$/.test(str(v) ?? "");
    case "text[]":
      return Array.isArray(v) && v.length <= 10 && v.every((e) => textOk(e, 200));
    case "enum:gender":
      return (GENDERS as readonly string[]).includes(str(v) ?? "");
    case "enum:citizenship":
      return (CITIZENSHIP as readonly string[]).includes(str(v) ?? "");
    case "enum:test_status":
      return (TEST_STATUS as readonly string[]).includes(str(v) ?? "");
  }
  if (type.startsWith("text:")) return textOk(v, Number(type.slice(5)));
  const keys = ROW_KEYS[type];
  if (keys) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const o = v as Record<string, Json>;
    if (Object.keys(o).some((k) => !keys.includes(k))) return false;
    const opt = (k: string, ok: (x: Json) => boolean) => absent(o[k]) || ok(o[k]);
    if (type === "row:test_score") {
      return textOk(o.exam, 200) && (TEST_KINDS as readonly string[]).includes(str(o.kind) ?? "")
        && opt("score", (x) => textOk(x, 40)) && opt("taken_on", (x) => isIsoDate(str(x)));
    }
    if (type === "row:course") {
      return textOk(o.name, 300)
        && opt("type", (x) => (COURSE_TYPES as readonly string[]).includes(str(x) ?? ""))
        && opt("grade", (x) => textOk(x, 40))
        && opt("status", (x) => (COURSE_STATUS as readonly string[]).includes(str(x) ?? ""))
        && opt("school_year", (x) => textOk(x, 40));
    }
    if (type === "row:award") {
      return textOk(o.name, 300)
        && opt("level", (x) => textOk(x, 100))
        && opt("year", (x) => textOk(x, 20))
        && opt("grade_levels", arrayOf(null, strIn(AWARD_GRADES)))
        && opt("recognition_levels", arrayOf(null, strIn(AWARD_RECOGNITION)))
        && opt("uc_level", strIn(AWARD_UC_LEVELS))
        && opt("uc_criteria", (x) => textOk(x, 2000))
        && opt("uc_earned", (x) => textOk(x, 2000));
    }
    return textOk(o.name, 300)
      && opt("position", (x) => textOk(x, 200))
      && opt("organization", (x) => textOk(x, 200))
      && opt("category", (x) => textOk(x, 100))
      && opt("hours_per_week", (x) => { const h = num(x); return h !== null && h >= 0 && h <= 168; })
      && opt("weeks_per_year", (x) => { const w = num(x); return w !== null && Number.isInteger(w) && w >= 0 && w <= 52; })
      && opt("description", (x) => textOk(x, 2000))
      && opt("grade_levels", (x) => valueOk("text[]", x))
      && opt("timing", arrayOf(3, strIn(ACTIVITY_TIMING)))
      && opt("continuing", (x) => typeof x === "boolean")
      && opt("uc_description", (x) => textOk(x, 2000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cleanup: cell text -> JSON for a value_type
// ---------------------------------------------------------------------------

export type Cleaned = { ok: true; value: Json; scale?: string } | { ok: false };

/** "1,234.5" -> 1234.5; "92%" -> 92; "3,8" -> 3.8 with comma decimals. Null when not a number. */
export function parseNumber(raw: string, commaDecimal = false): number | null {
  let s = raw.trim().replace(/%$/, "").trim();
  if (s === "") return null;
  if (commaDecimal) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  // `\d+\.?\d*` split its digits between two quantifiers every possible way
  // before failing; the optional group says the same with one way to read it.
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
function ymd(y: number, m: number, d: number): string | null {
  const s = `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
  return isIsoDate(s) ? s : null;
}

/**
 * An Excel serial to an ISO date. 1900 system: serial 1 is 1900-01-01, and
 * Excel counts a 29 February 1900 that never was, so serials from 61 on are
 * one day ahead. 1904 system: serial 0 is 1904-01-01.
 */
export function excelSerialToIso(serial: number, system: "excel1900" | "excel1904"): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const whole = Math.floor(serial);
  const base = system === "excel1904" ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const days = system === "excel1900" && whole >= 61 ? whole - 1 : whole;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date cell to ISO, following the plan's order for ambiguous numeric dates. */
export function parseDate(raw: string, order: DateOrder | undefined): string | null {
  const s = raw.trim();
  if (s === "") return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y += y > 50 ? 1900 : 2000;
    const [a, b] = [+m[1], +m[2]];
    if (order === "DMY") return ymd(y, b, a);
    if (order === "YMD") return null;
    return ymd(y, a, b);
  }
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mi === -1 ? null : ymd(+m[3], mi + 1, +m[2]);
  }
  m = /^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mi === -1 ? null : ymd(+m[3], mi + 1, +m[1]);
  }
  if (/^\d+(\.\d+)?$/.test(s) && (order === "excel1900" || order === "excel1904")) {
    return excelSerialToIso(Number(s), order);
  }
  return null;
}

const YES = new Set(["yes", "y", "true", "t", "1", "x"]);
const NO = new Set(["no", "n", "false", "f", "0"]);

function synonym<T extends string>(raw: string, table: Record<string, T>): T | null {
  const k = raw.trim().toLowerCase().replace(/[_.]+/g, " ").replace(/\s+/g, " ");
  return table[k] ?? null;
}

const GENDER_SYN: Record<string, (typeof GENDERS)[number]> = {
  female: "female", f: "female", woman: "female", girl: "female",
  male: "male", m: "male", man: "male", boy: "male",
  "non-binary": "non-binary", nonbinary: "non-binary", "non binary": "non-binary", nb: "non-binary", x: "non-binary",
  undisclosed: "undisclosed", "prefer not to say": "undisclosed", "decline to state": "undisclosed", "not specified": "undisclosed",
};
const CITIZEN_SYN: Record<string, (typeof CITIZENSHIP)[number]> = {
  "us citizen": "us-citizen", "us-citizen": "us-citizen", "u s citizen": "us-citizen", citizen: "us-citizen", "united states": "us-citizen", us: "us-citizen", usa: "us-citizen",
  "permanent resident": "permanent-resident", "permanent-resident": "permanent-resident", "green card": "permanent-resident", lpr: "permanent-resident",
  international: "international", "international student": "international", "non-us": "international", foreign: "international",
};
const TEST_STATUS_SYN: Record<string, (typeof TEST_STATUS)[number]> = {
  "not started": "not-started", "not-started": "not-started", prepping: "prepping", preparing: "prepping",
  scheduled: "scheduled", registered: "scheduled", taken: "taken", done: "taken", complete: "taken", completed: "taken",
  retaking: "retaking", "re-taking": "retaking", "test optional": "test-optional", "test-optional": "test-optional", optional: "test-optional",
};
const COURSE_TYPE_SYN: Record<string, (typeof COURSE_TYPES)[number]> = {
  ap: "ap", "advanced placement": "ap", ib: "ib", "international baccalaureate": "ib", "ib hl": "ib", "ib sl": "ib",
  honors: "honors", honor: "honors", h: "honors", "dual enrollment": "dual-enrollment", "dual-enrollment": "dual-enrollment", de: "dual-enrollment",
  college: "college", "college level": "college", other: "other", regular: "other", standard: "other", cp: "other", "college prep": "other",
};
const COURSE_STATUS_SYN: Record<string, (typeof COURSE_STATUS)[number]> = {
  planned: "planned", future: "planned", "in progress": "in-progress", "in-progress": "in-progress", current: "in-progress", enrolled: "in-progress",
  ip: "in-progress", completed: "completed", complete: "completed", done: "completed", finished: "completed",
};

export function testKindOf(exam: string): (typeof TEST_KINDS)[number] {
  const e = exam.trim().toLowerCase();
  if (/^ap\b|advanced placement/.test(e)) return "ap";
  if (/^ib\b|baccalaureate/.test(e)) return "ib";
  if (/\bsat\b/.test(e) && !/\bpsat\b/.test(e)) return "sat";
  if (/\bact\b/.test(e)) return "act";
  if (/toefl/.test(e)) return "toefl";
  if (/ielts/.test(e)) return "ielts";
  return "other";
}

export function cleanEnum(field: "gender" | "citizenship" | "test_status" | "course_type" | "course_status" | "test_kind", raw: string): string | null {
  switch (field) {
    case "gender": return synonym(raw, GENDER_SYN);
    case "citizenship": return synonym(raw, CITIZEN_SYN);
    case "test_status": return synonym(raw, TEST_STATUS_SYN);
    case "course_type": return synonym(raw, COURSE_TYPE_SYN);
    case "course_status": return synonym(raw, COURSE_STATUS_SYN);
    case "test_kind": {
      const k = raw.trim().toLowerCase();
      return (TEST_KINDS as readonly string[]).includes(k) ? k : null;
    }
  }
}

export type CleanOptions = { date?: DateOrder; commaDecimal?: boolean };

/**
 * One cell, for one value_type. `scale` comes back when a GPA cell carries
 * its scale ("3.8/4.0"), so the import can record the scale it was written on.
 */
export function cleanCell(type: string, raw: string, opts: CleanOptions = {}): Cleaned {
  const s = raw.trim();
  if (s === "") return { ok: false };
  let value: Json | null = null;
  let scale: string | undefined;
  switch (type) {
    case "gpa": {
      const ratio = /^(\d+(?:[.,]\d+)?)\s*(?:\/|out of|of)\s*(\d+(?:\.\d+)?)$/i.exec(s);
      if (ratio) {
        value = parseNumber(ratio[1], opts.commaDecimal || /,/.test(ratio[1]));
        scale = ratio[2];
      } else {
        value = parseNumber(s, opts.commaDecimal);
      }
      break;
    }
    case "sat_total":
    case "sat_section":
    case "act_composite":
      value = parseNumber(s, opts.commaDecimal);
      break;
    case "date":
      value = parseDate(s, opts.date);
      break;
    case "email":
      value = s.toLowerCase();
      break;
    case "bool": {
      const k = s.toLowerCase();
      value = YES.has(k) ? true : NO.has(k) ? false : null;
      break;
    }
    case "text[]":
      value = splitListCell(s).map((x) => x.trim()).filter(Boolean).slice(0, 11);
      break;
    case "enum:gender":
      value = cleanEnum("gender", s);
      break;
    case "enum:citizenship":
      value = cleanEnum("citizenship", s);
      break;
    case "enum:test_status":
      value = cleanEnum("test_status", s);
      break;
    case "grad_year": {
      // "2027", "2027.0" (a spreadsheet number), "Class of 2027".
      const m = /^(?:class\s+of\s+)?(20\d\d)(?:\.0+)?$/i.exec(s);
      value = m ? m[1] : null;
      break;
    }
    default:
      if (type.startsWith("text:")) value = s.replace(/\s+/g, " ");
  }
  if (value === null || !valueOk(type, value)) return { ok: false };
  return scale ? { ok: true, value, scale } : { ok: true, value };
}
