/**
 * Activity values the way counselors say them, turned into what the Activities sheet stores (spec 4.2).
 *
 * The model's tool input passes through `normalizeField` before any schema check, so "sophomore", "grades 10–12",
 * "summer" or "6hr week" just work. The same readers find values in free text (`mentionsIn`): the provenance check
 * uses them to confirm a structured value came from a source, and the draft sorter to tell a reply with details
 * ("Grade 11 Summer / 6hr week") from a question ("is her 1450 good for UCLA?").
 *
 * Pure functions, no I/O.
 */
import { ACTIVITY_TYPES, GRADES, TIMINGS, UC_CATEGORIES, type ActivityType } from "../../studentApplication.js";

export type Grade = (typeof GRADES)[number];
export type Timing = (typeof TIMINGS)[number];
export type UcCategory = (typeof UC_CATEGORIES)[number];

export type ActivityField =
  | "organization"
  | "position"
  | "category"
  | "grade_levels"
  | "timing"
  | "hours_per_week"
  | "weeks_per_year"
  | "continuing"
  | "uc_category"
  | "description";

export const ACTIVITY_FIELDS: readonly ActivityField[] = [
  "organization", "position", "category", "grade_levels", "timing", "hours_per_week", "weeks_per_year", "continuing", "uc_category", "description",
];

/** A value, or why there isn't one. `readAs`: the counselor's phrase when it differs from the value ("grades 10–12"). */
export type Norm<T> = { ok: true; value: T; readAs?: string } | { ok: false; problem: string };

export type Mentions = {
  grades: Grade[];
  timing: Timing[];
  hours: number[];
  weeks: number[];
  continuing: boolean[];
  uc: UcCategory[];
  category: ActivityType[];
};

/** Lowercase, letters and digits only (any script), every other run one space. Shared with provenance. */
export function freeTextKey(s: string): string {
  return s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// ---- Scanning ---------------------------------------------------------------------------------------

type Hit<T> = { value: T; start: number; end: number };
const NUM = String.raw`(\d+(?:\.\d+)?)`;
const ORD = String.raw`(?:st|nd|rd|th)?`;
const RANGE = String.raw`\s*(?:-|–|—|to|through|thru)\s*`;
const GRADE_NUM: Record<string, Grade> = { "9": "9", "10": "10", "11": "11", "12": "12" };
const CLASS_WORDS: Record<string, Grade> = { freshman: "9", frosh: "9", sophomore: "10", soph: "10", junior: "11", senior: "12" };
const CLASS_ABBR: Record<string, Grade> = { jr: "11", sr: "12" };
const ORDINAL_WORDS: Record<string, Grade> = { ninth: "9", tenth: "10", eleventh: "11", twelfth: "12" };

function* matches(text: string, re: RegExp): Generator<RegExpExecArray> {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    yield m;
    if (m[0] === "") g.lastIndex++;
  }
}

const span = (m: RegExpExecArray) => ({ start: m.index, end: m.index + m[0].length });
const gradeRange = (a: string, b: string): Grade[] => {
  const lo = Number(a);
  const hi = Number(b);
  if (!(lo >= 9 && hi <= 12 && lo <= hi)) return [];
  const out: Grade[] = [];
  for (let n = lo; n <= hi; n++) out.push(String(n) as Grade);
  return out;
};
const classRange = (a: Grade, b: Grade): Grade[] => gradeRange(a, b);

/** Grade hits. `field`: the text is a grades answer, so bare numbers, ordinal words and abbreviations count. */
function gradeHits(text: string, field: boolean): Hit<Grade[]>[] {
  const t = text.toLowerCase();
  const hits: Hit<Grade[]>[] = [];
  const push = (m: RegExpExecArray, value: Grade[]) => value.length && hits.push({ value, ...span(m) });
  for (const m of matches(t, /\ball (?:four|4) years\b|\ball of high school\b|\bevery year of high school\b/)) push(m, ["9", "10", "11", "12"]);
  // "grades 10–12", "grade 11", "grades 10, 11 and 12"
  for (const m of matches(t, new RegExp(String.raw`\bgrades?\s+((?:\d{1,2}${ORD})(?:(?:\s*(?:-|–|—|to|through|thru|and|&|,|/)\s*)\d{1,2}${ORD})*)`))) {
    const body = m[1]!;
    const r = new RegExp(String.raw`^(\d{1,2})${ORD}${RANGE}(\d{1,2})${ORD}$`).exec(body);
    push(m, r ? gradeRange(r[1]!, r[2]!) : [...body.matchAll(/\d{1,2}/g)].map((x) => GRADE_NUM[x[0]]).filter((g): g is Grade => !!g));
  }
  // "9th-12th" (field context: also "10-12")
  for (const m of matches(t, new RegExp(String.raw`\b(9|10|11|12)${field ? ORD : "(?:st|nd|rd|th)"}${RANGE}(9|10|11|12)${field ? ORD : "(?:st|nd|rd|th)"}\b`))) {
    push(m, gradeRange(m[1]!, m[2]!));
  }
  for (const m of matches(t, /\b(9|10|11|12)(?:st|nd|rd|th)?\s+grade(?:rs?)?\b/)) push(m, [GRADE_NUM[m[1]!]!]);
  const classAlt = Object.keys(CLASS_WORDS).join("|");
  for (const m of matches(t, new RegExp(String.raw`\b(${classAlt})s?${RANGE}(${classAlt})s?\b`))) push(m, classRange(CLASS_WORDS[m[1]!]!, CLASS_WORDS[m[2]!]!));
  for (const m of matches(t, new RegExp(String.raw`\b(${classAlt})s?\b`))) push(m, [CLASS_WORDS[m[1]!]!]);
  for (const m of matches(t, /\b(ninth|tenth|eleventh|twelfth)(\s+grade)?\b/)) if (field || m[2]) push(m, [ORDINAL_WORDS[m[1]!]!]);
  for (const m of matches(t, /\bpg\b|\bpost[- ]?grad(?:uate)?\b/)) push(m, ["PG"]);
  if (field) {
    for (const m of matches(t, /\b(jr|sr)\b\.?/)) push(m, [CLASS_ABBR[m[1]!]!]);
    for (const m of matches(t, new RegExp(String.raw`\b(9|10|11|12)${ORD}\b`))) push(m, [GRADE_NUM[m[1]!]!]);
  }
  return dropInner(hits);
}

/** Keeps the widest hits: "grades 10–12" wins over the "12" inside it. */
function dropInner<T>(hits: Hit<T>[]): Hit<T>[] {
  return hits.filter((h) => !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start));
}

const STRONG_TIMING: [RegExp, Timing][] = [
  [/\b(?:year[- ]?round|all year|whole year|full year|all[- ]year)\b/, "year"],
  [/\b(?:summers?|winter break|spring break|summer break|over the breaks?|during breaks?|school breaks?)\b/, "break"],
  [/\b(?:after[- ]school|during the school year|school[- ]year|fall semester|spring semester)\b/, "school"],
];
const WEAK_TIMING: [RegExp, Timing][] = [
  [/\b(?:breaks?|vacations?|holidays?)\b/, "break"],
  [/\b(?:during school|school|fall|spring|semesters?|academic year)\b/, "school"],
];

function timingHits(text: string, field: boolean): Hit<Timing>[] {
  let t = text.toLowerCase();
  const hits: Hit<Timing>[] = [];
  for (const [re, value] of field ? [...STRONG_TIMING, ...WEAK_TIMING] : STRONG_TIMING) {
    for (const m of matches(t, re)) {
      hits.push({ value, ...span(m) });
      // Blank it so "spring break" isn't read again as "spring".
      t = t.slice(0, m.index) + " ".repeat(m[0].length) + t.slice(m.index + m[0].length);
    }
  }
  return hits;
}

const HOUR_UNIT = String.raw`(?:h|hr|hrs|hour|hours)\b`;
const PER_DAY = String.raw`(?:\s*(?:a|per|/|each)\s*day\b|\s*daily\b)`;

function hourHits(text: string): Hit<number>[] {
  const t = text.toLowerCase();
  const hits: Hit<number>[] = [];
  for (const m of matches(t, new RegExp(String.raw`${NUM}${RANGE}${NUM}\s*${HOUR_UNIT}(?!${PER_DAY})`))) {
    hits.push({ value: (Number(m[1]) + Number(m[2])) / 2, ...span(m) });
  }
  for (const m of matches(t, new RegExp(String.raw`${NUM}\s*${HOUR_UNIT}(?!${PER_DAY})`))) hits.push({ value: Number(m[1]), ...span(m) });
  for (const m of matches(t, new RegExp(String.raw`${NUM}\s*(?:min|mins|minutes)\b(?!${PER_DAY})`))) hits.push({ value: round2(Number(m[1]) / 60), ...span(m) });
  return dropInner(hits);
}

function weekHits(text: string): Hit<number>[] {
  const t = text.toLowerCase();
  const hits: Hit<number>[] = [];
  for (const m of matches(t, new RegExp(String.raw`${NUM}\s*(?:w|wk|wks|week|weeks)\b`))) hits.push({ value: Number(m[1]), ...span(m) });
  for (const m of matches(t, /\b(?:year[- ]?round|all year|whole year|full year)\b/)) hits.push({ value: 52, ...span(m) });
  return hits;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const CONTINUING: [RegExp, boolean][] = [
  [/\b(?:still|ongoing|plans? to continue|will continue|continuing|currently|current)\b/, true],
  [/\b(?:ended|stopped|no longer|not continuing|finished|quit|discontinued)\b/, false],
];

const UC_WORDS: [RegExp, UcCategory][] = [
  [/\bvolunteer(?:ing)?\b/, "volunteer"],
  [/\b(?:work|job|paid work|work experience)\b/, "work"],
  [/\bextra[- ]?curricular\b/, "extracurricular"],
  [/\beducational? prep(?:aration)?\b|\bed prep\b|\beducational-prep\b/, "educational-prep"],
  [/\bcoursework[- ]other\b/, "coursework-other"],
];

/** Words counselors use for a Common App type, by `freeTextKey`. The builder may add more. */
const CATEGORY_SYNONYMS: Record<string, ActivityType> = {
  "community service": "Community Service (Volunteer)",
  volunteering: "Community Service (Volunteer)",
  robotics: "Robotics",
  debate: "Debate/Speech",
  "speech and debate": "Debate/Speech",
  "student government": "Student Govt./Politics",
  "student council": "Student Govt./Politics",
  job: "Work (paid)",
  "paid work": "Work (paid)",
  theater: "Theater/Drama",
  theatre: "Theater/Drama",
  drama: "Theater/Drama",
  coding: "Computer/Technology",
  programming: "Computer/Technology",
  "computer science": "Computer/Technology",
  "model un": "Other Club/Activity",
  jrotc: "Junior R.O.T.C.",
  newspaper: "Journalism/Publication",
  journalism: "Journalism/Publication",
  "yearbook": "Journalism/Publication",
};

/** Each type's own name and, where it names one type only, its main part ("Community Service", "Work"). */
const CATEGORY_NAMES: Map<string, ActivityType> = (() => {
  const map = new Map<string, ActivityType>();
  const mains = new Map<string, ActivityType[]>();
  for (const label of ACTIVITY_TYPES) {
    map.set(freeTextKey(label), label);
    const main = freeTextKey(label.split(/[(:]/)[0]!);
    mains.set(main, [...(mains.get(main) ?? []), label]);
  }
  for (const [main, labels] of mains) if (labels.length === 1 && !map.has(main)) map.set(main, labels[0]!);
  for (const [k, v] of Object.entries(CATEGORY_SYNONYMS)) map.set(freeTextKey(k), v);
  return map;
})();

function categoryHits(text: string): Hit<ActivityType>[] {
  const key = ` ${freeTextKey(text)} `;
  const hits: Hit<ActivityType>[] = [];
  for (const [name, label] of CATEGORY_NAMES) {
    const at = key.indexOf(` ${name} `);
    if (at >= 0) hits.push({ value: label, start: at, end: at + name.length });
  }
  return hits;
}

/** Bare numbers: ones no unit claimed. */
function bareNumbers(text: string, claimed: { start: number; end: number }[]): number[] {
  const out: number[] = [];
  for (const m of matches(text, /(?<![\d.])\d+(?:\.\d+)?(?![\d.])/)) {
    const s = m.index;
    const e = s + m[0].length;
    if (claimed.some((c) => s < c.end && e > c.start)) continue;
    out.push(Number(m[0]));
  }
  return out;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const sortGrades = (gs: Grade[]) => uniq(gs).sort((a, b) => GRADES.indexOf(a) - GRADES.indexOf(b));

/**
 * Every activity value a text mentions. Without `bare`, only values with a unit or a clear word ("grade 11",
 * "6hr", "2 weeks", "summer", "junior"). With `bare` (a counselor's reply, for provenance), unitless numbers no
 * unit claimed also count: 9–12 as grades, 0–168 as hours, whole 0–52 as weeks.
 */
export function mentionsIn(text: string, opts: { bare?: boolean } = {}): Mentions {
  const g = gradeHits(text, false);
  const tm = timingHits(text, true);
  const h = hourHits(text);
  const w = weekHits(text);
  const lower = text.toLowerCase();
  const out: Mentions = {
    grades: sortGrades(g.flatMap((x) => x.value)),
    timing: uniq(tm.map((x) => x.value)),
    hours: uniq(h.map((x) => x.value)),
    weeks: uniq(w.map((x) => x.value)),
    continuing: uniq(CONTINUING.filter(([re]) => re.test(lower)).map(([, v]) => v)),
    uc: uniq(UC_WORDS.filter(([re]) => re.test(lower)).map(([, v]) => v)),
    category: uniq(categoryHits(text).map((x) => x.value)),
  };
  if (opts.bare) {
    // Claimed spans come from the original text; grade and unit spans are found on the lowercased text, same offsets.
    // A per-day amount ("2 hours a day") is claimed too: it is never lent to hours or weeks (it asks, spec 4.2).
    const perDay = [...matches(lower, new RegExp(String.raw`${NUM}\s*(?:${HOUR_UNIT}|min|mins|minutes\b)${PER_DAY}`))].map(span);
    for (const n of bareNumbers(text, [...g, ...h, ...w, ...perDay])) {
      if (Number.isInteger(n) && n >= 9 && n <= 12) out.grades = sortGrades([...out.grades, String(n) as Grade]);
      if (n >= 0 && n <= 168) out.hours = uniq([...out.hours, n]);
      if (Number.isInteger(n) && n >= 0 && n <= 52) out.weeks = uniq([...out.weeks, n]);
    }
  }
  return out;
}

/** A value with a unit or a clear word: the draft sorter's rule 2. Timing counts only by a strong phrase. */
export function hasActivityValue(text: string): boolean {
  return gradeHits(text, false).length > 0 || hourHits(text).length > 0 || weekHits(text).length > 0 || timingHits(text, false).length > 0;
}

// ---- Normalizing one field --------------------------------------------------------------------------

const asText = (raw: unknown): string | null =>
  typeof raw === "string" ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : Array.isArray(raw) ? raw.map(String).join(", ") : null;
const said = (raw: unknown) => (typeof raw === "string" ? raw.trim() : asText(raw) ?? String(raw));
const readAs = (raw: unknown, plain: string): { readAs?: string } => {
  const s = typeof raw === "string" ? raw.trim() : null;
  return s && s !== plain ? { readAs: s } : {};
};
const ask = (raw: unknown, what: string): Norm<never> => ({ ok: false, problem: `"${said(raw)}" ${what}. Ask the counselor; don't guess.` });

function normGrades(raw: unknown): Norm<Grade[]> {
  if (Array.isArray(raw) && raw.length === 0) return { ok: true, value: [] };
  // A list: every item must be a grade, so a bad one is refused rather than dropped.
  if (Array.isArray(raw) && raw.length > 1) {
    const each = raw.map((x) => normGrades(x));
    const bad = each.find((n) => !n.ok);
    if (bad) return bad;
    return { ok: true, value: sortGrades(each.flatMap((n) => (n.ok ? n.value : []))) };
  }
  const text = asText(raw);
  if (text === null) return ask(raw, "isn't a grade (9, 10, 11, 12 or PG)");
  const value = sortGrades(gradeHits(text, true).flatMap((h) => h.value));
  if (!value.length) return ask(raw, "isn't a grade (9, 10, 11, 12 or PG)");
  return { ok: true, value, ...readAs(raw, value.join(", ")) };
}

function normTiming(raw: unknown): Norm<Timing[]> {
  if (Array.isArray(raw) && raw.length === 0) return { ok: true, value: [] };
  const text = asText(raw);
  const exact = text?.trim().toLowerCase();
  if (exact && (TIMINGS as readonly string[]).includes(exact)) return { ok: true, value: [exact as Timing] };
  const found = text === null ? [] : uniq(timingHits(text, true).map((h) => h.value));
  if (!found.length) return ask(raw, "isn't a timing (school year, breaks or all year)");
  const value: Timing = found.includes("year") || (found.includes("school") && found.includes("break")) ? "year" : found[0]!;
  return { ok: true, value: [value], ...readAs(raw, value) };
}

function normHours(raw: unknown): Norm<number> {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return ask(raw, "isn't a number of hours");
    if (raw > 168) return { ok: false, problem: `${raw} is more than 168. Ask the counselor; don't guess.` };
    return { ok: true, value: raw };
  }
  const text = asText(raw);
  if (text === null) return ask(raw, "isn't a number of hours");
  const t = text.toLowerCase();
  if (new RegExp(String.raw`${NUM}\s*(?:${HOUR_UNIT}|min|mins|minutes)${PER_DAY}`).test(t)) return ask(raw, "needs the days per week");
  let value: number | null = hourHits(t)[0]?.value ?? null;
  if (value === null) {
    const r = new RegExp(String.raw`^\s*(?:about|around|roughly|~)?\s*${NUM}${RANGE}${NUM}\s*$`).exec(t);
    if (r) value = (Number(r[1]) + Number(r[2])) / 2;
  }
  if (value === null) {
    const n = new RegExp(String.raw`^\s*(?:about|around|roughly|~)?\s*${NUM}\b`).exec(t);
    if (n) value = Number(n[1]);
  }
  if (value === null) return ask(raw, "isn't a number of hours a week");
  if (value > 168) return { ok: false, problem: `${value} is more than 168. Ask the counselor; don't guess.` };
  return { ok: true, value, ...readAs(raw, String(value)) };
}

function normWeeks(raw: unknown): Norm<number> {
  const check = (n: number, r: unknown): Norm<number> =>
    !Number.isInteger(n) || n < 0
      ? ask(r, "isn't a whole number of weeks")
      : n > 52
        ? { ok: false, problem: `${n} is more than 52 weeks. Ask the counselor; don't guess.` }
        : { ok: true, value: n, ...readAs(r, String(n)) };
  if (typeof raw === "number") return check(raw, raw);
  const text = asText(raw);
  if (text === null) return ask(raw, "isn't a number of weeks");
  const t = text.toLowerCase();
  if (/\bschool year\b|\bsemester\b/.test(t) && !/\d/.test(t)) return ask(raw, "isn't a number of weeks");
  const hit = weekHits(t)[0]?.value ?? (/^\s*(?:about|around|~)?\s*(\d+(?:\.\d+)?)\s*$/.exec(t) ? Number(/(\d+(?:\.\d+)?)/.exec(t)![1]) : null);
  if (hit === null) return ask(raw, "isn't a number of weeks");
  return check(hit, raw);
}

function normContinuing(raw: unknown): Norm<boolean> {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  const t = (asText(raw) ?? "").toLowerCase();
  const found = uniq(CONTINUING.filter(([re]) => re.test(t)).map(([, v]) => v));
  if (found.length !== 1) return { ok: false, problem: `"${said(raw)}" doesn't say whether it continues. Leave it blank.` };
  return { ok: true, value: found[0]!, ...readAs(raw, String(found[0])) };
}

function normUc(raw: unknown): Norm<UcCategory> {
  const t = (asText(raw) ?? "").toLowerCase().trim();
  if ((UC_CATEGORIES as readonly string[]).includes(t)) return { ok: true, value: t as UcCategory };
  const found = uniq(UC_WORDS.filter(([re]) => re.test(t)).map(([, v]) => v));
  if (found.length !== 1) {
    return { ok: false, problem: "uc_category needs the counselor's own word (volunteer, work, extracurricular, educational prep). Leave it blank." };
  }
  return { ok: true, value: found[0]!, ...readAs(raw, found[0]!) };
}

function normCategory(raw: unknown): Norm<ActivityType> {
  const text = asText(raw)?.trim() ?? "";
  const label = CATEGORY_NAMES.get(freeTextKey(text));
  if (!label) return { ok: false, problem: `"${text}" isn't one of the Common App activity types. Leave category blank.` };
  return { ok: true, value: label, ...readAs(raw, label) };
}

function normText(raw: unknown, field: ActivityField): Norm<string> {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, problem: `${field} is empty. Leave it out instead.` };
  return { ok: true, value: raw.trim() };
}

/** One field of the model's input, as the sheet stores it. `null` (and [] for lists) clears a field. */
export function normalizeField(field: ActivityField, raw: unknown): Norm<unknown> {
  if (raw === null) return { ok: true, value: null };
  switch (field) {
    case "grade_levels":
      return normGrades(raw);
    case "timing":
      return normTiming(raw);
    case "hours_per_week":
      return normHours(raw);
    case "weeks_per_year":
      return normWeeks(raw);
    case "continuing":
      return normContinuing(raw);
    case "uc_category":
      return normUc(raw);
    case "category":
      return normCategory(raw);
    default:
      return normText(raw, field);
  }
}
