/**
 * Masking (spec §7.2): what the parse-plan model may see of a cell is its
 * shape, never its value. `<email>`, `<date>`, `<phone>`, `<number ...>`,
 * `<text, 2 words, capitalized>`. A short list of generic domain words
 * (yes/no, letter grades, course levels, terms, test names) passes through,
 * because they say what a column is without saying anything about anyone.
 * A header that looks like a person's name is masked as `<name>` (§5.2).
 *
 * A header is sent as written only when it reads as a label. A file with no
 * header row makes its first student's row the "headers" (findHeaderRow
 * takes the first row with two cells), so a header shaped like a value (an
 * email, a date, a phone or ID number) or like the column under it is masked
 * the way a cell is, and when several of a sheet's headers look like data
 * the whole row is treated as data (profile.ts).
 */

import { parseName } from "./names.js";
import { isEmailShape } from "./textShapes.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?$/i;
const SLASH_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
const MONTH_DATE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{2,4}$|^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{2,4}$/i;
const PHONE = /^\+?[\d\s().-]{7,20}$/;
const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;
const RATIO = /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/;

/** Generic words that identify nobody. Compared lowercased and trimmed. */
const SAFE_WORDS = new Set([
  "yes", "no", "y", "n", "true", "false", "x", "n/a", "na", "none", "tbd",
  "a+", "a", "a-", "b+", "b", "b-", "c+", "c", "c-", "d+", "d", "d-", "f", "p", "pass", "fail", "ip",
  "ap", "ib", "honors", "dual enrollment", "dual-enrollment", "college", "regular", "cp", "standard",
  "completed", "complete", "in progress", "in-progress", "planned", "current", "enrolled",
  "fall", "spring", "summer", "winter", "semester", "year", "full year", "quarter",
  "sat", "act", "psat", "toefl", "ielts", "duolingo", "official", "unofficial", "superscore",
  "freshman", "sophomore", "junior", "senior", "9", "10", "11", "12", "9th", "10th", "11th", "12th",
  "weighted", "unweighted", "test optional", "test-optional", "taken", "scheduled", "retaking",
]);

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function caseShape(s: string): string {
  const ws = words(s).filter((w) => /\p{L}/u.test(w));
  if (ws.length === 0) return "no letters";
  if (ws.every((w) => w === w.toUpperCase())) return "uppercase";
  if (ws.every((w) => /^\p{Lu}/u.test(w))) return "capitalized";
  if (ws.every((w) => w === w.toLowerCase())) return "lowercase";
  return "mixed case";
}

/** The shape of one cell. Never returns the cell, except a SAFE_WORDS entry. */
export function maskValue(raw: string): string {
  const v = raw.trim();
  if (v === "") return "<empty>";
  const lower = v.toLowerCase();
  if (SAFE_WORDS.has(lower)) return v.length <= 20 ? lower : "<word>";
  if (isEmailShape(v)) return "<email>";
  if (ISO_DATE.test(v) || SLASH_DATE.test(v) || MONTH_DATE.test(v)) return "<date>";
  if (RATIO.test(v)) return "<number>/<number>";
  if (NUMBER.test(v)) {
    const digits = v.replace(/[^\d.]/g, "");
    const [int = "", frac] = digits.split(".");
    const pct = v.endsWith("%") ? " percent" : "";
    return frac
      ? `<decimal, ${int.length} digit${int.length === 1 ? "" : "s"} . ${frac.length}${pct}>`
      : `<number, ${int.length} digit${int.length === 1 ? "" : "s"}${pct}>`;
  }
  if (PHONE.test(v) && v.replace(/\D/g, "").length >= 7) return "<phone>";
  const n = words(v).length;
  const digits = /\d/.test(v) ? ", with digits" : "";
  return `<text, ${n} word${n === 1 ? "" : "s"}, ${caseShape(v)}${digits}>`;
}

/** Words that make a header a header ("First Name", "GPA Weighted"), not a person. */
const HEADER_WORDS = new Set([
  "name", "first", "last", "middle", "full", "preferred", "nickname", "given", "family", "surname",
  "student", "students", "email", "e-mail", "mail", "address", "phone", "mobile", "cell", "contact",
  "gpa", "weighted", "unweighted", "cumulative", "scale", "rank", "class", "grade", "grades", "level",
  "sat", "act", "math", "reading", "writing", "ebrw", "verbal", "english", "science", "composite",
  "total", "score", "scores", "test", "tests", "exam", "exams", "date", "dob", "birth", "birthday", "born",
  "year", "graduation", "grad", "school", "high", "hs", "course", "courses", "subject", "term", "status",
  "activity", "activities", "position", "role", "organization", "org", "hours", "week", "weeks",
  "description", "notes", "gender", "sex", "citizenship", "major", "majors", "intended", "interest",
  "id", "number", "type", "kind", "ap", "ib", "honors", "credit", "credits", "city", "state", "zip",
  "country", "parent", "guardian", "mother", "father", "home", "of", "and", "the", "per", "in", "to",
  "first-gen", "generation", "language", "superscore", "best", "official", "taken", "on", "at",
  "counselor", "advisor", "biology", "chemistry", "physics", "history", "calculus", "statistics",
  "spanish", "french", "art", "music", "psychology", "economics", "government", "literature",
  "computer", "world", "us", "european", "environmental", "language", "lang", "lit", "comp", "bc", "ab",
  "extracurricular", "leadership", "participation", "participated", "academic", "field", "study", "current",
  "expected", "primary", "secondary", "alternate", "personal", "login", "mailing", "street", "testing",
  "evidence", "based", "nm", "fname", "lname", "erw", "wks", "wk", "yr", "hrs", "uw", "w", "m", "levels",
  "category", "title", "final", "college", "for", "or", "a", "an", "dates", "unit", "units", "hometown", "town",
]);

const VALUE_SHAPED = (h: string) =>
  isEmailShape(h) || ISO_DATE.test(h) || SLASH_DATE.test(h) || MONTH_DATE.test(h) || RATIO.test(h) || NUMBER.test(h) ||
  (PHONE.test(h) && h.replace(/\D/g, "").length >= 7) || /\d{3}-\d{2}-\d{4}/.test(h) || /\d{7,}/.test(h);

/**
 * Words of a column label ("SAT Math", "Grad Year 2027", "AP 5"): every word
 * a header word or a generic one, numbers of at most four digits, and at
 * least one word that isn't a number.
 */
export function headerIsLabel(header: string): boolean {
  const ws = header.toLowerCase().split(/[^\p{L}\p{N}+#'’-]+/u).filter(Boolean);
  if (ws.length === 0) return false;
  let word = false;
  for (const w of ws) {
    if (/^\d{1,4}(st|nd|rd|th)?$/.test(w)) continue;
    if (!HEADER_WORDS.has(w) && !SAFE_WORDS.has(w)) return false;
    word = true;
  }
  return word;
}

/**
 * Does this header read as a data cell rather than a label? A value's shape
 * (email, date, number, phone, an ID's digits), or the shape of the values
 * under it ("jane doe" over a column of names), unless it reads as a label.
 */
export function headerLooksLikeData(header: string, sampleShapes: readonly string[] = []): boolean {
  const h = header.trim();
  if (h === "" || headerIsLabel(h)) return false;
  if (VALUE_SHAPED(h) || headerLooksLikeName(h)) return true;
  return sampleShapes.includes(maskValue(h));
}

/**
 * Does this header look like a person's name ("Jane Doe", "Doe, Jane")?
 * Two to four capitalized words, none of them a header word.
 */
export function headerLooksLikeName(header: string): boolean {
  const h = header.trim();
  if (h.length < 3 || h.length > 60 || /[\d@#%/()]/.test(h)) return false;
  const ws = h.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (ws.length < 2 || ws.length > 4) return false;
  if (!ws.every((w) => /^\p{Lu}[\p{L}'’-]*$/u.test(w))) return false;
  if (ws.some((w) => HEADER_WORDS.has(w.toLowerCase().replace(/[^\p{L}-]/gu, "")))) return false;
  const { first, surnames } = parseName(h);
  return first.length >= 2 && surnames.length >= 1;
}

/**
 * What the model sees of a header: the text when it reads as a label (or
 * looks like nothing under it), `<name>` for a person's name, and a cell's
 * shape for anything that looks like data. `sampleShapes` are the masked
 * shapes of the column's values (profile.ts).
 */
export function maskHeader(header: string, sampleShapes: readonly string[] = []): string {
  const h = header.trim();
  if (h === "") return "<blank>";
  if (headerIsLabel(h)) return h.slice(0, 80);
  if (headerLooksLikeName(h)) return "<name>";
  if (/\d{3}-\d{2}-\d{4}/.test(h) || /\d{7,}/.test(h)) return "<number>";
  if (headerLooksLikeData(h, sampleShapes)) return maskValue(h);
  return h.slice(0, 80);
}
