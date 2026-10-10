import type { FastifyRequest } from "fastify";
import { fromPostgrest, notFound } from "../errors.js";
import { assertCanViewStudent } from "../guards.js";
import { loadPracticeSettings } from "../practiceSettings.js";
import { packSections, type Section } from "./pack.js";
import { PROFILES, type Feature } from "./profiles.js";
import { LOADERS } from "./sections.js";
import type { ContextUsage, StudentContext } from "./types.js";

export type { ContextUsage, StudentContext, Feature };

/** What one AI feature may read about one student, packed to that feature's budget. */
export async function buildStudentContext(request: FastifyRequest, studentId: string, feature: Feature): Promise<StudentContext> {
  await assertCanViewStudent(request, studentId);
  const profile = PROFILES[feature];
  const { settings } = await loadPracticeSettings(request);
  const results = await Promise.all(
    profile.sections.map((name) => LOADERS[name](request.db, studentId, {
      essayBodies: profile.essayBodies,
      practiceReadsDocuments: settings.autoParseDocuments,
    }))
  );
  const profileRow = results[profile.sections.indexOf("profile")];
  if (profile.sections.includes("profile") && !profileRow?.section) throw notFound("That student isn't on your roster");

  const sections: Section[] = results.flatMap((r) => (r.section ? [r.section] : []));
  const packed = packSections(sections, profile.budget);
  const facts: StudentContext["facts"] = Object.assign({
    intendedMajors: [], gradYear: null, state: null, gpa: { value: null, scale: null },
    sat: null, act: null, activityCategories: [], identity: { name: null, email: null, school: null, hometown: null },
  }, ...results.map((r) => r.facts ?? {}));
  // The login email is deliberately read outside the AI allowlist. It never enters `text`; it feeds the
  // identity filter (what research may not search for) and nothing else.
  const { data: who, error: whoError } = await request.db.from("profiles").select("email").eq("id", studentId).maybeSingle();
  if (whoError) throw fromPostgrest(whoError);
  facts.identity = { ...facts.identity, email: (who?.email as string | undefined) ?? null };

  return {
    text: packed.text,
    used: packed.used,
    omitted: [...results.flatMap((r) => r.omitted ?? []), ...packed.omitted],
    studentName: facts.identity.name,
    facts,
  };
}
