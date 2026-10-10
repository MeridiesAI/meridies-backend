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
