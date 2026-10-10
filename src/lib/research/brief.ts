import { createHash } from "node:crypto";
import { fourPointGpa, gpaScaleKind } from "../gpa.js";
import type { StudentContext } from "../context/types.js";

export const ACTIVITY_CATEGORIES = [
  "math competitions", "science research", "robotics", "computer science", "debate", "model un", "journalism",
  "creative writing", "visual arts", "music", "theater", "athletics", "community service", "student government",
  "entrepreneurship", "environmental", "health and medicine", "engineering", "languages", "religious",
  "cultural clubs", "tutoring", "work", "family responsibilities", "other",
] as const;

export type ResearchBrief = {
  feature: "college_list" | "activities";
  grade: number | null;
  region: string | null;
  majors: string[];
  interests: string[];
  gpaBand: string;
  testBand: string | null;
  focus: string | null;
};

export class IdentityLeakError extends Error {
  constructor() {
    super("Research input contained the student's identity");
    this.name = "IdentityLeakError";
  }
}

type Facts = StudentContext["facts"];

/**
 * One comparison form for tokens and text: NFKC (full-width to ASCII), lowercase, strip invisible format
 * characters (zero-width space, soft hyphen), then drop combining marks so NFC, NFD and unaccented spellings agree.
 */
export function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase().normalize("NFD").replace(/[\p{M}\p{Cf}]/gu, "").normalize("NFC");
}

/** True when the text holds a letter outside ASCII (CJK, Cyrillic, ...). Accented Latin is already folded to ASCII. */
function hasNonAsciiLetter(s: string): boolean {
  return [...s].some((ch) => /\p{L}/u.test(ch) && !/^[\x00-\x7F]$/.test(ch));
}

const STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming",
];

/**
 * Generic school and place words that are not added as word tokens (the whole school or hometown string still is),
 * so ordinary research text such as "high school" or "math competitions" does not trip the filter.
 */
export const IDENTITY_STOPLIST: ReadonlySet<string> = new Set([
  "high", "school", "schools", "academy", "college", "university", "institute", "center", "centre", "central",
  "north", "south", "east", "west", "northern", "southern", "eastern", "western", "senior", "junior", "middle",
  "upper", "lower", "preparatory", "prep", "saint", "city", "town", "county", "public", "private", "charter",
  "magnet", "international", "christian", "catholic", "lutheran", "jewish", "islamic", "technical", "tech",
  "technology", "science", "sciences", "arts", "math", "mathematics", "engineering", "early", "learning",
  "community", "regional", "memorial", "district", "union", "valley", "park", "lake", "mount", "mountain", "fort",
  "port", "springs", "heights", "hills", "beach", "island", "river", "creek", "grove", "falls", "united", "states",
  "american", "national", "state",
  ...STATE_NAMES, ...STATE_NAMES.flatMap((n) => n.split(" ")),
]);

const NAME_SEPARATORS = /[\s,._\-'\u2018\u2019\u02bc`\u00b4]+/u;
const NON_ALNUM = /[^\p{L}\p{N}]/gu;

/** Name and email parts: 3+ characters, or 2+ when they hold a non-ASCII letter ("Li" is not a token, "Wei" is). */
function keepPart(part: string): boolean {
  const len = [...part].length;
  return len >= 3 || (len >= 2 && hasNonAsciiLetter(part));
}

/** School and hometown words: 4+ characters, or 2+ when non-ASCII, and not a generic word. */
function keepPlaceWord(w: string): boolean {
  const len = [...w].length;
  return (len >= 4 || (len >= 2 && hasNonAsciiLetter(w))) && !IDENTITY_STOPLIST.has(w);
}

function addPlace(raw: string | null, out: Set<string>): void {
  const s = fold(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return;
  out.add(s);
  const stripped = s.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  if (stripped) out.add(stripped);
  for (const w of s.split(/[\s,]+/)) {
    for (const c of [w.replace(NON_ALNUM, ""), ...w.split(/[^\p{L}\p{N}]+/u)]) {
      if (c && keepPlaceWord(c)) out.add(c);
    }
  }
}

export function identityTokens(id: Facts["identity"]): string[] {
  const out = new Set<string>();
  const name = fold(id.name ?? "").trim();
  if (name) {
    const parts = name.split(NAME_SEPARATORS).filter(Boolean);
    for (const part of parts) if (keepPart(part)) out.add(part);
    if (parts.length > 1) out.add(parts.join(" "));
    const joined = name.replace(NON_ALNUM, "");
    if (keepPart(joined)) out.add(joined);
    // Words joined by an apostrophe or hyphen also appear fused ("obrien", "maryjane").
    for (const word of name.split(/[\s,]+/)) {
      if (/['\u2018\u2019\u02bc`\u00b4-]/u.test(word)) {
        const fused = word.replace(NON_ALNUM, "");
        if (keepPart(fused)) out.add(fused);
      }
    }
  }
  const email = fold(id.email ?? "").trim();
  if (email) {
    out.add(email);
    const at = email.lastIndexOf("@");
    const local = at > 0 ? email.slice(0, at) : email;
    out.add(local);
    const fusedLocal = local.replace(NON_ALNUM, "");
    if (keepPart(fusedLocal)) out.add(fusedLocal);
    for (const piece of local.split(/[^\p{L}\p{N}]+/u)) {
      if (keepPart(piece) && /\p{L}/u.test(piece)) out.add(piece);
    }
  }
  addPlace(id.school, out);
  addPlace(id.hometown, out);
  return [...out].filter((t) => t.length > 0);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function assertNoIdentity(text: string, tokens: string[]): void {
  const t = fold(text);
  for (const raw of tokens) {
    const tok = fold(raw);
    if (!tok) continue;
    if (hasNonAsciiLetter(tok)) {
      if (t.includes(tok)) throw new IdentityLeakError();
      continue;
    }
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(tok)}([^\\p{L}\\p{N}]|$)`, "u").test(t)) throw new IdentityLeakError();
  }
}

const FOLDED_CATEGORIES = new Map<string, string>(ACTIVITY_CATEGORIES.map((c) => [fold(c), c]));
const category = (c: string): string | null => FOLDED_CATEGORIES.get(fold(c).trim().replace(/\s+/g, " ")) ?? null;

/**
 * A major is kept only when it is short and plain: 1 to 5 words, at most 60 characters, letters, spaces and & - / , '
 * only. Anything else (a sentence, digits, a phone number, an email, a URL) is dropped silently.
 */
function majorOf(raw: string): string | null {
  const m = fold(raw).replace(/[\u2018\u2019]/g, "'").trim().replace(/\s+/g, " ");
  if (!m || m.length > 60) return null;
  if (!/^[\p{L} &\-/,']+$/u.test(m)) return null;
  const words = m.split(" ").filter((w) => /[\p{L}]/u.test(w));
  return words.length >= 1 && m.split(" ").length <= 5 ? m : null;
}

/**
 * The band's scale label is fixed by the scale kind, never the raw string. Mirrors the SAFE_SCALE idea in
 * src/lib/context/sections.ts (free-text scales are untrusted) and fourPointGpa in src/lib/gpa.ts.
 */
function gpaBand(gpa: Facts["gpa"]): string {
  const v = fourPointGpa(gpa.value, gpa.scale);
  if (v === null) return "unknown";
  const lo = Math.floor(v / 0.2) * 0.2;
  const kind = gpaScaleKind(gpa.scale);
  const label = kind === "five" ? "5.0" : kind === "four" ? "4.0" : v <= 4 ? "4.0" : "5.0";
  return `${lo.toFixed(1)}–${(lo + 0.2).toFixed(1)} on ${label}`;
}

function testBand(sat: number | null, act: number | null): string | null {
  if (sat !== null) { const lo = Math.floor(sat / 100) * 100; return `SAT ${lo}–${lo + 100}`; }
  if (act !== null) { const lo = Math.floor(act / 3) * 3; return `ACT ${lo}–${lo + 3}`; }
  return null;
}

/**
 * Mirrors currentGrade in src/lib/profileUpdates.ts (same UTC August rollover, same 9-12 range).
 * Not imported: that module pulls in env and the Supabase client, which this pure module must not load.
 */
function grade(gradYear: string | null, now: Date): number | null {
  const y = Number.parseInt(gradYear ?? "", 10);
  if (!Number.isFinite(y)) return null;
  const endYear = now.getUTCMonth() >= 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const g = 12 - (y - endYear);
  return g >= 9 && g <= 12 ? g : null;
}

/** Kept only when exactly two ASCII letters. */
function region(state: string | null): string | null {
  const s = (state ?? "").trim();
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null;
}

export function toResearchBrief(facts: Facts, feature: ResearchBrief["feature"], focus: string | null, now = new Date()): ResearchBrief {
  const tokens = identityTokens(facts.identity);
  const fullFocus = focus?.trim() ? focus.trim() : null;
  // Scan the whole text first: the stored focus is cut to 200 characters, an identity at position 300 must still refuse.
  if (fullFocus) assertNoIdentity(fullFocus, tokens);
  const cleanFocus = fullFocus ? fullFocus.slice(0, 200) : null;
  const brief: ResearchBrief = {
    feature,
    grade: grade(facts.gradYear, now),
    region: region(facts.state),
    majors: facts.intendedMajors.map(majorOf).filter((m): m is string => m !== null).slice(0, 5),
    interests: [...new Set(facts.activityCategories.map(category).filter((c): c is string => !!c))],
    gpaBand: gpaBand(facts.gpa),
    testBand: testBand(facts.sat, facts.act),
    focus: cleanFocus,
  };
  assertNoIdentity(JSON.stringify(brief), tokens);
  return brief;
}

export function briefHash(b: ResearchBrief): string {
  const stable = JSON.stringify({ ...b, majors: [...b.majors].sort(), interests: [...b.interests].sort() });
  return createHash("sha256").update(stable).digest("hex");
}
