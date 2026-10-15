/** The per-document AI decision (spec §3.1–§3.2). Order is fixed and tested. */
export const AI_DEFAULT_DOCUMENT_KINDS = ["transcript", "resume", "test-report", "activity-list"] as const;

export type DocumentAiReason = "keep-out" | "waived" | "excluded" | "not-categorized" | "kind-excluded" | "practice-setting" | null;

export function documentAiDecision(
  doc: { kind: string; available_to_llm: boolean; ai_access: string; ferpa_waived: boolean },
  practiceReadsDocuments: boolean
): { allowed: boolean; reason: DocumentAiReason } {
  if (!doc.available_to_llm) return { allowed: false, reason: "keep-out" };
  if (doc.kind === "recommendation-letter" && doc.ferpa_waived) return { allowed: false, reason: "waived" };
  if (!practiceReadsDocuments) return { allowed: false, reason: "practice-setting" };
  if (doc.ai_access === "excluded") return { allowed: false, reason: "excluded" };
  if (doc.ai_access === "allowed") return { allowed: true, reason: null };
  if ((AI_DEFAULT_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) return { allowed: true, reason: null };
  if (doc.kind === "other") return { allowed: false, reason: "not-categorized" };
  return { allowed: false, reason: "kind-excluded" };
}

/**
 * Documents a student may not see unless they uploaded them (documents_student_restricted_select): a waived
 * recommendation letter, IEP/504 and counselor-only files. Anything that would echo such a file's name to a
 * student (an activity log entry, say) must leave the name out.
 */
export function isRestrictedDocument(doc: { kind: string; ferpa_waived?: boolean }): boolean {
  return (doc.kind === "recommendation-letter" && doc.ferpa_waived === true) || doc.kind === "iep-504" || doc.kind === "counselor-only";
}

/**
 * Kinds a student hands in for a task that the context layer leaves out only because nobody categorized them
 * (`other`) or because it never reads them as background (`essay`, `common-app`). Handing one in for a check is
 * the explicit request to read that file, so submission review reads them.
 */
export const HAND_IN_READABLE_KINDS = ["other", "essay", "common-app"] as const;

/**
 * Whether AxIS may read a file handed in for a task (lib/submissionReview.ts): documentAiDecision in its fixed
 * order (keep-out, a waived recommendation letter, the practice's document-reading switch, `ai_access =
 * 'excluded'`), so every per-file and per-practice switch holds. The one widening is HAND_IN_READABLE_KINDS;
 * every other kind outside the defaults (IEP/504, counselor-only, financial, award letters, recommendation
 * letters) stays out unless the counselor set the file to `allowed`.
 */
export function handInAiDecision(
  doc: { kind: string; available_to_llm: boolean; ai_access: string; ferpa_waived: boolean },
  practiceReadsDocuments: boolean
): { allowed: boolean; reason: DocumentAiReason } {
  const decision = documentAiDecision(doc, practiceReadsDocuments);
  if (decision.allowed) return decision;
  if (
    (decision.reason === "not-categorized" || decision.reason === "kind-excluded") &&
    (HAND_IN_READABLE_KINDS as readonly string[]).includes(doc.kind)
  ) {
    return { allowed: true, reason: null };
  }
  return decision;
}
