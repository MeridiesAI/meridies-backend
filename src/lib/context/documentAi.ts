/** The per-document AI decision (spec §3.1–§3.2). Order is fixed and tested. */
export const AI_DEFAULT_DOCUMENT_KINDS = ["transcript", "resume", "test-report", "activity-list"] as const;

/** Kinds that stay out of a task's prompts unless the counselor allowed the file by hand. */
export const SENSITIVE_DOCUMENT_KINDS = ["financial", "iep-504", "counselor-only", "recommendation-letter", "award-letter"] as const;

export type DocumentAiReason = "keep-out" | "waived" | "excluded" | "not-categorized" | "kind-excluded" | "practice-setting" | null;

export type AiDoc = { kind: string; available_to_llm: boolean; ai_access: string; ferpa_waived: boolean; kind_confirmed: boolean };

/** A documents row as a decision input. Absent switches read as today's defaults. */
export function toAiDoc(row: Record<string, unknown>): AiDoc {
  return {
    kind: typeof row.kind === "string" ? row.kind : "other",
    available_to_llm: row.available_to_llm !== false,
    ai_access: typeof row.ai_access === "string" && row.ai_access ? row.ai_access : "default",
    ferpa_waived: row.ferpa_waived === true,
    kind_confirmed: row.kind_confirmed !== false,
  };
}

/** What the context layer (and AxIS retrieval) may read. */
export function documentAiDecision(doc: AiDoc, practiceReadsDocuments: boolean): { allowed: boolean; reason: DocumentAiReason } {
  // A Drive pick nobody has confirmed: out, and reported as "not categorized" so the counselor is asked.
  if (!doc.kind_confirmed) return { allowed: false, reason: "not-categorized" };
  if (!doc.available_to_llm) return { allowed: false, reason: "keep-out" };
  if (doc.kind === "recommendation-letter" && doc.ferpa_waived) return { allowed: false, reason: "waived" };
  if (!practiceReadsDocuments) return { allowed: false, reason: "practice-setting" };
  if (doc.ai_access === "excluded") return { allowed: false, reason: "excluded" };
  if (doc.ai_access === "allowed") return { allowed: true, reason: null };
  // The same sensitive list the tracker and submission review use (one constant, three readers).
  if ((SENSITIVE_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) return { allowed: false, reason: "kind-excluded" };
  if ((AI_DEFAULT_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) return { allowed: true, reason: null };
  if (doc.kind === "other") return { allowed: false, reason: "not-categorized" };
  return { allowed: false, reason: "kind-excluded" };
}

/**
 * What the task tracker and submission review may read: the file the task is
 * about. Same protections as the context layer (unconfirmed, keep-out, waived
 * letters, the practice switch, per-file exclusion), but the kind defaults are
 * replaced by a short list of sensitive kinds, because these features read the
 * student's work for the task (an essay, a draft filed as "other").
 */
export function documentReadableForTask(doc: AiDoc, practiceReadsDocuments: boolean): { allowed: boolean; reason: DocumentAiReason } {
  if (!doc.kind_confirmed) return { allowed: false, reason: "not-categorized" };
  if (!doc.available_to_llm) return { allowed: false, reason: "keep-out" };
  if (doc.kind === "recommendation-letter" && doc.ferpa_waived) return { allowed: false, reason: "waived" };
  if (!practiceReadsDocuments) return { allowed: false, reason: "practice-setting" };
  if (doc.ai_access === "excluded") return { allowed: false, reason: "excluded" };
  if (doc.ai_access === "allowed") return { allowed: true, reason: null };
  if ((SENSITIVE_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) return { allowed: false, reason: "kind-excluded" };
  return { allowed: true, reason: null };
}

/**
 * Documents a student may not see unless they uploaded them (documents_student_restricted_select): a waived
 * recommendation letter, IEP/504 and counselor-only files. Anything that would echo such a file's name to a
 * student (an activity log entry, say) must leave the name out.
 */
export function isRestrictedDocument(doc: { kind: string; ferpa_waived?: boolean }): boolean {
  return (doc.kind === "recommendation-letter" && doc.ferpa_waived === true) || doc.kind === "iep-504" || doc.kind === "counselor-only";
}
