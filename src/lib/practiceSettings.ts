/**
 * Data & privacy settings (public.practice_settings), read for the caller's
 * practice and enforced here, so a switch on the settings page is a promise
 * the API keeps rather than a preference the UI remembers.
 *
 * One row per practice: the firm's, or a solo counselor's. No row means the
 * defaults. Students have no practice of their own; their requests read the
 * row of the counselor they belong to only where a rule needs it.
 */

import type { FastifyRequest } from "fastify";
import type { AiModule } from "./anthropic.js";
import { loadWorkspace } from "./crm.js";
import { forbidden, fromPostgrest } from "./errors.js";

type Row = Record<string, unknown>;

export type PrivacySettings = {
  aiSummaries: boolean;
  autoParseDocuments: boolean;
  studentsSeeSharedReports: boolean;
};

export const DEFAULT_PRIVACY: PrivacySettings = {
  aiSummaries: true,
  autoParseDocuments: true,
  studentsSeeSharedReports: true,
};

export const toPrivacySettings = (r: Row | null | undefined): PrivacySettings =>
  r
    ? {
        aiSummaries: r.ai_summaries !== false,
        autoParseDocuments: r.auto_parse_documents !== false,
        studentsSeeSharedReports: r.students_see_shared_reports !== false,
      }
    : { ...DEFAULT_PRIVACY };

/** The caller's practice row (null when none is saved), and whether they may change it. */
export async function loadPracticeSettings(request: FastifyRequest) {
  const ws = await loadWorkspace(request);
  let builder = request.db.from("practice_settings").select("*");
  builder = ws.firmId ? builder.eq("firm_id", ws.firmId) : builder.eq("counselor_id", request.auth.userId);
  const { data, error } = await builder.maybeSingle();
  if (error) throw fromPostgrest(error);
  return { workspace: ws, row: (data as Row | null) ?? null, settings: toPrivacySettings(data as Row | null) };
}

/** Modules that summarize a student, a family or a page: "AI co-pilot summaries". */
const SUMMARY_MODULES: ReadonlySet<AiModule> = new Set<AiModule>([
  "profile-summary",
  "family-report",
  "aid-report",
  "link-digest",
]);

/** Modules that read uploaded documents on their own: "Auto-parse uploaded documents". */
const DOCUMENT_MODULES: ReadonlySet<AiModule> = new Set<AiModule>(["file-filing", "document-tracker", "submission-review"]);

/**
 * Throws when the caller's practice has switched this kind of AI off. Only
 * counselors carry a practice; other callers pass through (students reach no
 * gated module).
 */
export async function assertAiAllowed(request: FastifyRequest, module: AiModule): Promise<void> {
  if (!SUMMARY_MODULES.has(module) && !DOCUMENT_MODULES.has(module)) return;
  if (request.profile?.role !== "counselor") return;
  const { settings } = await loadPracticeSettings(request);
  if (SUMMARY_MODULES.has(module) && !settings.aiSummaries) {
    throw forbidden("AI summaries are turned off in Settings › Data & privacy.");
  }
  if (DOCUMENT_MODULES.has(module) && !settings.autoParseDocuments) {
    throw forbidden("Automatic document reading is turned off in Settings › Data & privacy.");
  }
}
