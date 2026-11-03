/**
 * Resume adjuster: suggested edits to the student's own resume.
 *
 * The student's existing resume (a file in their documents) is read as text,
 * split into lines, and AxIS (FAST_MODEL) suggests specific line edits:
 * the line as it stands, the line as it could read, and a short reason. It
 * may draw on the student's Activities and Honors sheets, but only for what
 * they state. Every suggestion is checked in code before it is shown:
 *
 * - `original` must be one of the resume's own lines (whitespace aside);
 * - `suggested` adds no number that neither the resume nor the sheets hold;
 * - no first person, no paragraph (a resume line, 300 characters at most);
 * - one suggestion per line, and never a line that comes back unchanged.
 *
 * Nothing is stored: the student accepts or rejects each edit in the app and
 * takes the result away (copy, print to PDF).
 */

import { z } from "zod";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./context/pack.js";

type Row = Record<string, unknown>;

export const adjustBody = z
  .object({
    documentId: z.string().uuid(),
    /** The counselor names the student; a student's own request leaves it out. */
    studentId: z.string().uuid().optional(),
  })
  .strict();

export const MAX_RESUME_CHARS = 20_000;
export const MAX_SUGGESTIONS = 15;

/** The resume as lines: trimmed, empty ones dropped, each at most 400 characters (a longer one is a paragraph). */
export function resumeLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .slice(0, 400);
}

const squash = (s: string) => s.replace(/^[\s\-•*·–]+/, "").replace(/\s+/g, " ").trim().toLowerCase();

const FIRST_PERSON = /\b(i|i'm|i've|i'd|my|me|mine|myself)\b/i;
const NUMBER = /\d+(?:[.,]\d+)?/g;

/** One sheet row's facts as the model reads them. */
export function sheetFacts(activities: Row[], honors: Row[]): string {
  const acts = activities.map((r) => {
    const parts = [
      r.organization ?? r.name, r.position, r.category, r.description,
      typeof r.hours_per_week === "number" ? `${r.hours_per_week} hours a week` : null,
      typeof r.weeks_per_year === "number" ? `${r.weeks_per_year} weeks a year` : null,
      Array.isArray(r.grade_levels) && r.grade_levels.length > 0 ? `grades ${(r.grade_levels as unknown[]).join(", ")}` : null,
    ].filter((v) => v != null && String(v).trim() !== "");
    return `Activity: ${parts.map(String).join(" | ")}`;
  });
  const hons = honors.map((r) => {
    const parts = [
      r.name,
      Array.isArray(r.recognition_levels) && r.recognition_levels.length > 0 ? `level ${(r.recognition_levels as unknown[]).join(", ")}` : null,
      Array.isArray(r.grade_levels) && r.grade_levels.length > 0 ? `grades ${(r.grade_levels as unknown[]).join(", ")}` : null,
    ].filter((v) => v != null && String(v).trim() !== "");
    return `Honor: ${parts.map(String).join(" | ")}`;
  });
  return [...acts, ...hons].join("\n");
}

export const RESUME_ADJUST_SYSTEM = [
  "You help a high school student improve the resume they already wrote. You do not write a new resume.",
  "Suggest specific edits to specific lines. For each, copy one line of the resume exactly as it appears (original), give that line as it could read (suggested), and say why in under 120 characters (reason).",
  "Good edits: start a bullet with a strong verb, cut filler, make tense consistent, fix grammar and spelling, make a vague line concrete using a fact from the student's own activity and honor records.",
  "Use only facts the resume or the records state. Never invent a number, hours, a team size, an award, a title, a date, an organization or a result. Leave a line alone if it is already good.",
  "No first person (I, my, me). No summary or objective paragraph, no story. Each suggested line stays a resume line.",
  `At most ${MAX_SUGGESTIONS} suggestions, the most useful first.`,
  UNTRUSTED_DATA_RULE,
].join("\n");

export const RESUME_ADJUST_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      maxItems: MAX_SUGGESTIONS + 5,
      items: {
        type: "object",
        properties: {
          original: { type: "string", maxLength: 500 },
          suggested: { type: "string", maxLength: 400 },
          reason: { type: "string", maxLength: 200 },
        },
        required: ["original", "suggested", "reason"],
      },
    },
  },
  required: ["suggestions"],
} as const;

export function adjustPrompt(lines: string[], facts: string): string {
  return [
    "The student's resume, one line per line:",
    wrapUntrusted("resume", lines.join("\n")),
    facts ? "The student's own activity and honor records:" : "The student has no activity or honor records on file.",
    facts ? wrapUntrusted("records", facts) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type Suggestion = { id: string; line: number; original: string; suggested: string; reason: string };

const modelOut = z.object({
  suggestions: z.array(z.object({ original: z.string(), suggested: z.string(), reason: z.string() })),
});

/**
 * The model's answer reduced to edits that pass the checks above. `line` is
 * the index into `lines`; `original` is the resume's own line, never the
 * model's copy of it.
 */
export function cleanSuggestions(value: unknown, lines: string[], facts: string): Suggestion[] {
  const parsed = modelOut.safeParse(value);
  if (!parsed.success) return [];
  const index = new Map<string, number>();
  lines.forEach((l, i) => {
    const k = squash(l);
    if (!index.has(k)) index.set(k, i);
  });
  const allowed = new Set([...(lines.join(" ").match(NUMBER) ?? []), ...(facts.match(NUMBER) ?? [])]);
  const used = new Set<number>();
  const out: Suggestion[] = [];
  for (const s of parsed.data.suggestions) {
    const i = index.get(squash(s.original));
    if (i === undefined || used.has(i)) continue;
    const suggested = s.suggested.replace(/\s+/g, " ").trim();
    if (suggested.length < 2 || suggested.length > 300) continue;
    if (squash(suggested) === squash(lines[i]!)) continue;
    if (FIRST_PERSON.test(suggested) && !FIRST_PERSON.test(lines[i]!)) continue;
    if ((suggested.match(NUMBER) ?? []).some((n) => !allowed.has(n))) continue;
    const reason = s.reason.replace(/\s+/g, " ").trim().slice(0, 160);
    used.add(i);
    out.push({ id: `s${out.length + 1}`, line: i, original: lines[i]!, suggested, reason });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out.sort((a, b) => a.line - b.line);
}
