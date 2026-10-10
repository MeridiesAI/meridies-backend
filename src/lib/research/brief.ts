import { createHash } from "node:crypto";
import { fourPointGpa, gpaScaleKind } from "../gpa.js";
import type { StudentContext } from "../context/types.js";

export const ACTIVITY_CATEGORIES = [
  "math competitions", "science research", "robotics", "computer science", "debate", "model un", "journalism",
  "creative writing", "visual arts", "music", "theater", "athletics", "community service", "student government",
  "entrepreneurship", "environmental", "health and medicine", "engineering", "languages", "religious",
  "cultural clubs", "tutoring", "work", "family responsibilities", "dance", "career exploration", "leadership",
  "academics", "other",
] as const;

/**
 * The product's own activity types (`ACTIVITY_TYPES` in src/lib/profileUpdates.ts, the Common App list) each map to
 * exactly one entry of the vocabulary above. The table is keyed by the folded type. It is not imported from
 * profileUpdates.ts because that module pulls in env and the Supabase client, which this pure module must not load;
 * test/unit/research-brief.test.ts imports the real list and fails when a type has no row here.
 * "other" is never sent as an interest. Two types are deliberately "other": "LGBT" (a protected characteristic that
 * must not reach an outside model, however generic the word) and "School Spirit" (no useful research category).
 */
export const ACTIVITY_TYPE_CATEGORY: Readonly<Record<string, (typeof ACTIVITY_CATEGORIES)[number]>> = {
  "academic": "academics",
  "art": "visual arts",
  "athletics: club": "athletics",
  "athletics: jv/varsity": "athletics",
  "career-oriented": "career exploration",
  "community service (volunteer)": "community service",
  "computer/technology": "computer science",
  "cultural": "cultural clubs",
  "dance": "dance",
  "debate/speech": "debate",
  "environmental": "environmental",
  "family responsibilities": "family responsibilities",
  "foreign exchange": "languages",
  "journalism/publication": "journalism",
  "junior r.o.t.c.": "leadership",
  "lgbt": "other",
  "music: instrumental": "music",
  "music: vocal": "music",
  "religious": "religious",
  "research": "science research",
  "robotics": "robotics",
  "school spirit": "other",
  "science/math": "science research",
  "student govt./politics": "student government",
  "theater/drama": "theater",
  "work (paid)": "work",
  "other club/activity": "other",
};

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
 * characters (zero-width space, soft hyphen), then drop combining marks so NFC, NFD and unaccented spellings agree,
 * and finally map the few letters that don't decompose (ø, ł, đ, ß, æ, œ, þ, ı) to their ASCII spelling.
 */
export function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase().normalize("NFD").replace(/[\p{M}\p{Cf}]/gu, "").normalize("NFC").replace(NON_DECOMPOSING, (c) => LETTER_FOLDS[c]!);
}

/** Letters NFKD doesn't decompose, mapped to their usual ASCII spelling (on tokens and on text alike). */
const LETTER_FOLDS: Readonly<Record<string, string>> = { "ø": "o", "ł": "l", "đ": "d", "ß": "ss", "æ": "ae", "œ": "oe", "þ": "th", "ı": "i" };
const NON_DECOMPOSING = /[øłđßæœþı]/g;

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
 * Words that are generic for a school and say nothing about where it is. They are not added as word tokens (the whole
 * school or hometown string still is). Place words (city, valley, park, ...) and state names are deliberately NOT here:
 * too broad a list leaks, too narrow a list only refuses runs.
 */
export const IDENTITY_STOPLIST: ReadonlySet<string> = new Set([
  "high", "school", "schools", "academy", "college", "university", "institute", "center", "centre", "central",
  "senior", "junior", "middle", "upper", "lower", "preparatory", "prep", "saint", "public", "private", "charter",
  "magnet", "international", "christian", "catholic", "lutheran", "jewish", "islamic", "technical", "tech",
  "technology", "science", "sciences", "arts", "math", "mathematics", "engineering", "early", "learning",
  "community", "regional", "memorial", "district", "union", "united", "national", "american",
  "north", "south", "east", "west", "northern", "southern", "eastern", "western",
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

/** True for the part after a hometown's last comma when it is a two-letter code or a full US state name. */
function isStatePart(p: string): boolean {
  const t = p.trim();
  return /^[a-z]{2}$/.test(t) || STATE_NAMES.includes(t);
}

function addPlace(raw: string | null, out: Set<string>, kind: "school" | "hometown"): void {
  const hometown = kind === "hometown";
  const s = fold(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return;
  out.add(s);
  let wordSource = s;
  const comma = s.lastIndexOf(",");
  // "City, ST" or "City, State": the state is not tokenized by word (it stays inside the whole-string token).
  if (hometown && comma >= 0 && isStatePart(s.slice(comma + 1))) wordSource = s.slice(0, comma);
  const stripped = s.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  if (stripped) out.add(stripped);
  // "Lee High School" is also written "Lee High": the school without its last generic word, as a phrase. Only when two
  // or more words are left and one of them says something about the school ("Central High School" gets no alias).
  if (kind === "school") {
    const words = s.split(" ");
    const last = words[words.length - 1]!.replace(NON_ALNUM, "");
    const rest = words.slice(0, -1);
    if (rest.length >= 2 && IDENTITY_STOPLIST.has(last) && rest.some((w) => !IDENTITY_STOPLIST.has(w.replace(NON_ALNUM, "")))) {
      const alias = rest.join(" ");
      out.add(alias);
      const aliasStripped = alias.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
      if (aliasStripped) out.add(aliasStripped);
    }
  }
  for (const w of wordSource.split(/[\s,]+/)) {
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
    if (keepPart(local)) out.add(local);
    const fusedLocal = local.replace(NON_ALNUM, "");
    if (keepPart(fusedLocal)) out.add(fusedLocal);
    for (const piece of local.split(/[^\p{L}\p{N}]+/u)) {
      if (keepPart(piece) && /\p{L}/u.test(piece)) out.add(piece);
    }
  }
  addPlace(id.school, out, "school");
  addPlace(id.hometown, out, "hometown");
  // Never a token that is a single character or has no letter or digit.
  return [...out].filter((t) => [...t].length >= 2 && /[\p{L}\p{N}]/u.test(t));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Throws when the text holds any token. Non-ASCII tokens match anywhere. ASCII tokens of 5 or more characters match as a
 * word prefix (the token starts at a word boundary and anything may follow: "okafors", "avery2027", "lee high school"
 * for "lee high"); shorter ones must be whole words, so the four-letter names that are also common words (Will, Mark,
 * Hope, Rose) don't refuse every "willing" or "marking".
 */
export function assertNoIdentity(text: string, tokens: string[]): void {
  const t = fold(text);
  for (const raw of tokens) {
    const tok = fold(raw);
    if (!tok) continue;
    if (hasNonAsciiLetter(tok)) {
      if (t.includes(tok)) throw new IdentityLeakError();
      continue;
    }
    const after = [...tok].length >= 5 ? "" : "([^\\p{L}\\p{N}]|$)";
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(tok)}${after}`, "u").test(t)) throw new IdentityLeakError();
  }
}

const FOLDED_CATEGORIES = new Map<string, string>(ACTIVITY_CATEGORIES.map((c) => [fold(c), c]));
/** The brief's interest word for a student's activity category: the product's types first, then the vocabulary. "other" and anything unknown give null. */
export function category(c: string): string | null {
  const key = fold(c).trim().replace(/\s+/g, " ");
  const hit = Object.hasOwn(ACTIVITY_TYPE_CATEGORY, key) ? ACTIVITY_TYPE_CATEGORY[key]! : FOLDED_CATEGORIES.get(key) ?? null;
  return hit === "other" ? null : hit;
}

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
  // Only the two fields that can carry text someone typed are scanned: each major and the focus. Everything else is
  // built by code from fixed sets (a band, a two-letter code, a word from the vocabulary), so scanning it could only
  // trip on the brief's own keys and words (a surname "Null", a school "Health Sciences High"). A major that trips the
  // scan is dropped and the run goes ahead without it; a focus that trips it refuses the run (above).
  const majors = facts.intendedMajors
    .map(majorOf)
    .filter((m): m is string => m !== null)
    .filter((m) => {
      try {
        assertNoIdentity(m, tokens);
        return true;
      } catch (err) {
        if (err instanceof IdentityLeakError) return false;
        throw err;
      }
    })
    .slice(0, 5);
  return {
    feature,
    grade: grade(facts.gradYear, now),
    region: region(facts.state),
    majors,
    interests: [...new Set(facts.activityCategories.map(category).filter((c): c is string => !!c))],
    gpaBand: gpaBand(facts.gpa),
    testBand: testBand(facts.sat, facts.act),
    focus: cleanFocus,
  };
}

export function briefHash(b: ResearchBrief): string {
  const stable = JSON.stringify({ ...b, majors: [...b.majors].sort(), interests: [...b.interests].sort() });
  return createHash("sha256").update(stable).digest("hex");
}
