import type { FastifyRequest } from "fastify";
import { forbidden, fromPostgrest, notFound } from "../errors.js";
import { assertCanViewStudent } from "../guards.js";
import { loadPracticeSettings } from "../practiceSettings.js";
import { entryFree, leaveOutFree } from "./freeText.js";
import { packSections, type Section } from "./pack.js";
import { OUTSIDE_SECTIONS, PROFILES, type Feature, type SectionName } from "./profiles.js";
import { LOADERS } from "./sections.js";
import type { ContextUsage, StudentContext } from "./types.js";

export type { ContextUsage, StudentContext, Feature };

/** A profile's sections narrowed to `only`, in the profile's order; names the profile lacks are ignored. */
export function selectSections(sections: SectionName[], only?: SectionName[]): SectionName[] {
  return only ? sections.filter((name) => only.includes(name)) : sections;
}

/**
 * What one AI feature may read about one student, packed to that feature's budget.
 * `opts.only` narrows the feature's profile to those sections (never widens it).
 * `opts.shortOnly` (an AxIS question turn) leaves each outside section's free text out, with a line saying what
 * exists, so the turn reads only short fields unless a lookup fetches the rest.
 */
export async function buildStudentContext(
  request: FastifyRequest,
  studentId: string,
  feature: Feature,
  opts?: { only?: SectionName[]; trustedOnly?: boolean; shortOnly?: boolean }
): Promise<StudentContext> {
  // Counselors only (spec §4): a student's own session never builds a context, even for themselves.
  if (request.profile.role !== "counselor") throw forbidden("Only counselors can do that");
  await assertCanViewStudent(request, studentId);
  const profile = { ...PROFILES[feature], sections: selectSections(PROFILES[feature].sections, opts?.only) };
  const { settings } = await loadPracticeSettings(request);
  const results = await Promise.all(
    profile.sections.map((name) => LOADERS[name](request.db, studentId, {
      essayBodies: profile.essayBodies,
      practiceReadsDocuments: settings.autoParseDocuments,
      trustedOnly: opts?.trustedOnly === true,
    }))
  );
  const profileRow = results[profile.sections.indexOf("profile")];
  if (profile.sections.includes("profile") && !profileRow?.section) throw notFound("That student isn't on your roster");

  // Which sections carry someone else's words (OUTSIDE_SECTIONS, or what the loader said for this read).
  const outsideByName = new Map(profile.sections.map((name, i) => [name as string, results[i]?.outside ?? OUTSIDE_SECTIONS.has(name)]));
  const isOutside = (name: string) => outsideByName.get(name) === true;
  let sections: Section[] = results.flatMap((r) => (r.section ? [r.section] : []));
  if (opts?.shortOnly) sections = leaveOutFree(sections, isOutside);
  const packed = packSections(sections, profile.budget);
  const facts: StudentContext["facts"] = Object.assign({
    intendedMajors: [], gradYear: null, state: null, gpa: { value: null, scale: null },
    sat: null, act: null, activityCategories: [], identity: { name: null, email: null, school: null, hometown: null },
  }, ...results.map((r) => r.facts ?? {}));
  // The login email is deliberately read outside the AI allowlist, and only for the features that feed the
  // identity filter (what research may not search for). It never enters `text`.
  if (feature === "college-list" || feature === "activities") {
    const { data: who, error: whoError } = await request.db.from("profiles").select("email").eq("id", studentId).maybeSingle(); // ctx-email-exception
    if (whoError) throw fromPostgrest(whoError);
    facts.identity = { ...facts.identity, email: (who?.email as string | undefined) ?? null };
  }

  // Of the sections that made it into the text: which carry someone else's words, and which of those free text.
  const outside = packed.used.map((u) => u.section).filter(isOutside);
  const byName = new Map(sections.map((s) => [s.name, s]));
  const freeText = outside.filter((name) => (byName.get(name)?.untrusted ?? []).some(entryFree));

  return {
    text: packed.text,
    outside,
    freeText,
    used: packed.used,
    omitted: [...results.flatMap((r) => r.omitted ?? []), ...packed.omitted],
    studentName: facts.identity.name,
    facts,
  };
}
