import { createHash } from "node:crypto";
import { fourPointGpa } from "../gpa.js";
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

/** True when the text holds a letter outside ASCII (CJK, Cyrillic, accented Latin, ...). */
function hasNonAsciiLetter(s: string): boolean {
  return [...s].some((ch) => /\p{L}/u.test(ch) && !/^[\x00-\x7F]$/.test(ch));
}

function clean(s: string | null): string {
  return (s ?? "").trim().toLowerCase();
}

export function identityTokens(id: Facts["identity"]): string[] {
  const out = new Set<string>();
  const name = clean(id.name);
  if (name) {
    for (const part of name.split(/[\s,.-]+/)) {
      const len = [...part].length;
      if (len >= 3 || (len >= 2 && hasNonAsciiLetter(part))) out.add(part);
    }
    if (hasNonAsciiLetter(name)) out.add(name.replace(/\s+/g, ""));
  }
  const email = clean(id.email);
  if (email) {
    out.add(email);
    out.add(email.split("@")[0]);
  }
  const school = clean(id.school);
  if (school) out.add(school);
  const hometown = clean(id.hometown);
  if (hometown) out.add(hometown);
  return [...out].filter((t) => t.length > 0);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function assertNoIdentity(text: string, tokens: string[]): void {
  const t = text.toLowerCase();
  for (const tok of tokens) {
    if (!tok) continue;
    if (hasNonAsciiLetter(tok)) {
      if (t.includes(tok)) throw new IdentityLeakError();
      continue;
    }
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(tok)}([^\\p{L}\\p{N}]|$)`, "u").test(t)) throw new IdentityLeakError();
  }
}

const category = (c: string): string | null => {
  const n = c.trim().toLowerCase();
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(n) ? n : null;
};

function gpaBand(gpa: Facts["gpa"]): string {
  const v = fourPointGpa(gpa.value, gpa.scale);
  if (v === null) return "unknown";
  const lo = Math.floor(v / 0.2) * 0.2;
  const scale = (gpa.scale ?? "4.0").trim() || "4.0";
  return `${lo.toFixed(1)}–${(lo + 0.2).toFixed(1)} on ${scale}`;
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

export function toResearchBrief(facts: Facts, feature: ResearchBrief["feature"], focus: string | null, now = new Date()): ResearchBrief {
  const tokens = identityTokens(facts.identity);
  const cleanFocus = focus?.trim() ? focus.trim().slice(0, 200) : null;
  if (cleanFocus) assertNoIdentity(cleanFocus, tokens);
  const brief: ResearchBrief = {
    feature,
    grade: grade(facts.gradYear, now),
    region: facts.state,
    majors: facts.intendedMajors.map((m) => m.trim().toLowerCase()).filter(Boolean).slice(0, 5),
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
