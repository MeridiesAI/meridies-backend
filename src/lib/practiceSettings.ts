/**
 * Data & privacy settings (public.practice_settings), read for the caller's
 * practice and enforced here, so a switch on the settings page is a promise
 * the API keeps rather than a preference the UI remembers.
 *
 * One row per practice: the firm's, or a solo counselor's. No row means the
 * defaults. Students have no practice of their own; their requests read the
 * row of the counselor they belong to (studentPracticeSettings) wherever a
 * gated AI module runs for them.
 */

import type { FastifyRequest } from "fastify";
import { isCounselorApproved } from "./access.js";
import type { AiModule } from "./anthropic.js";
import { loadWorkspace } from "./crm.js";
import { isSchemaMissing } from "./axis/failsafe.js";
import { forbidden, fromPostgrest } from "./errors.js";
import { serviceClient } from "./supabase.js";

type Row = Record<string, unknown>;

export type PrivacySettings = {
  aiSummaries: boolean;
  autoParseDocuments: boolean;
  studentsSeeSharedReports: boolean;
  /**
   * "Let students use AI tools": Build College Lists, Coherence, Activities Build and the scholarship Ask box
   * for the practice's own students. Unlike the switches above this one is OFF until a practice turns it on
   * (student AI is billed to a shared company ceiling), so only a literal true counts.
   */
  studentAiTools: boolean;
};

export const DEFAULT_PRIVACY: PrivacySettings = {
  aiSummaries: true,
  autoParseDocuments: true,
  studentsSeeSharedReports: true,
  studentAiTools: false,
};

export const toPrivacySettings = (r: Row | null | undefined): PrivacySettings =>
  r
    ? {
        aiSummaries: r.ai_summaries !== false,
        autoParseDocuments: r.auto_parse_documents !== false,
        studentsSeeSharedReports: r.students_see_shared_reports !== false,
        studentAiTools: r.student_ai_tools === true,
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
  // Resume bullets are drafted from the student's record, so the practice's AI summaries switch governs them.
  "resume",
  "meeting-summary",
  // A family's messages and replies go to the model to be translated (lib/translate.ts).
  "message-translate",
]);

/**
 * Modules that read uploaded documents on their own: "Auto-parse uploaded
 * documents". An import's column mapping sees only masked headers and shapes,
 * but it is still AI reading a file the practice uploaded, so a practice that
 * switched this off gets presets, templates and its own mapping instead.
 */
const DOCUMENT_MODULES: ReadonlySet<AiModule> = new Set<AiModule>([
  "file-filing", "document-tracker", "submission-review", "import-mapping", "import-cleanup",
  // The Application page reads a student's uploaded essay (where the essay is) and resume (suggested edits).
  "essay-body", "resume-adjust",
]);

/**
 * The modules a student's AI tools run on. They are gated by "Let students use AI tools" for a STUDENT only; a
 * counselor's use of the same modules is never held by it. Not a Data & privacy switch for anyone else, so they
 * are deliberately not part of aiSwitchFor.
 */
const STUDENT_TOOL_MODULES: ReadonlySet<AiModule> = new Set<AiModule>([
  "narrative-coherence", // Coherence
  "concierge", // Activities Build
  "college-list", // Build College Lists and its chat bar
  "scholarship-match", // the scholarship Ask box
]);

export const isStudentToolModule = (module: AiModule): boolean => STUDENT_TOOL_MODULES.has(module);

const STUDENT_TOOLS_OFF = "Your counselor hasn't turned on AI tools for students yet.";

/** Which Data & privacy switch gates a module, if any. */
export function aiSwitchFor(module: AiModule): "aiSummaries" | "autoParseDocuments" | null {
  if (SUMMARY_MODULES.has(module)) return "aiSummaries";
  if (DOCUMENT_MODULES.has(module)) return "autoParseDocuments";
  return null;
}

/**
 * The Data & privacy settings of the practice a student belongs to: their
 * counselor's firm, or the solo counselor's own row. A student can't read
 * practice_settings under RLS, so this reads on the service client, keyed by
 * the caller's own profile (never a client-supplied id); without one (a local
 * stack) it asks the database on the student's own token
 * (my_practice_ai_settings, 20261024000053). Null when it can't be answered
 * (no counselor, an unapproved counselor, a read error, neither way
 * available): callers fail closed on null.
 */
export async function studentPracticeSettings(
  studentId: string,
  counselorId: string | null,
  db?: FastifyRequest["db"]
): Promise<PrivacySettings | null> {
  if (!counselorId) return null;
  const svc = serviceClient();
  if (!svc) return db ? ownPracticeSettings(db) : null;
  try {
    // AI reads nothing for the student of a counselor Meridies hasn't approved (or has revoked).
    if (!(await isCounselorApproved(svc, counselorId))) return null;
    // Re-read the link from the database rather than trusting the request's copy alone.
    const { data: me, error: meError } = await svc.from("profiles").select("counselor_id").eq("id", studentId).maybeSingle();
    if (meError || (me?.counselor_id as string | null) !== counselorId) return null;
    const { data: counselor, error: cError } = await svc.from("profiles").select("firm_id").eq("id", counselorId).maybeSingle();
    if (cError) return null;
    const firmId = (counselor?.firm_id as string | null) ?? null;
    return await readPracticeSettingsFor(svc, firmId, counselorId);
  } catch {
    return null;
  }
}

const SWITCH_COLUMNS = "ai_summaries, auto_parse_documents, students_see_shared_reports";

/**
 * One practice's switches on the service client: the firm's row, else the solo counselor's. Null is "no answer"
 * (callers fail closed); a practice with no row gets the defaults. The code can deploy before the migration that
 * adds `student_ai_tools`, so a missing column is retried without it: the older switches still answer as they
 * always did, and the student tools read off.
 */
export async function readPracticeSettingsFor(
  svc: NonNullable<ReturnType<typeof serviceClient>>,
  firmId: string | null,
  counselorId: string
): Promise<PrivacySettings | null> {
  const read = async (columns: string) => {
    let builder = svc.from("practice_settings").select(columns);
    builder = firmId ? builder.eq("firm_id", firmId) : builder.eq("counselor_id", counselorId);
    return builder.maybeSingle();
  };
  let { data, error } = await read(`${SWITCH_COLUMNS}, student_ai_tools`);
  if (error && isSchemaMissing(error)) ({ data, error } = await read(SWITCH_COLUMNS));
  if (error) return null;
  return toPrivacySettings(data as unknown as Row | null);
}

/** The caller's own practice's AI switches through the SECURITY DEFINER function. Null: no answer. */
async function ownPracticeSettings(db: FastifyRequest["db"]): Promise<PrivacySettings | null> {
  try {
    const { data, error } = await db.rpc("my_practice_ai_settings");
    if (error || !data || typeof data !== "object") return null;
    const row = data as Row;
    return toPrivacySettings({
      ai_summaries: row.ai_summaries,
      auto_parse_documents: row.auto_parse_documents,
      // An older my_practice_ai_settings() has no such key: absent reads as off.
      student_ai_tools: row.student_ai_tools,
    });
  } catch {
    return null;
  }
}

function refuse(module: AiModule, settings: PrivacySettings): void {
  if (SUMMARY_MODULES.has(module) && !settings.aiSummaries) {
    throw forbidden("AI summaries are turned off in Settings › Data & privacy.");
  }
  if (DOCUMENT_MODULES.has(module) && !settings.autoParseDocuments) {
    throw forbidden("Automatic document reading is turned off in Settings › Data & privacy.");
  }
}

/**
 * Throws when the caller's practice has switched this kind of AI off. A
 * counselor's practice is their own; a student's is their counselor's (a
 * student reaches link digests and submission review), read fail-closed: a
 * student whose practice can't be read gets no gated AI at all. Anyone else
 * (no role yet) gets none of the gated modules either.
 */
export async function assertAiAllowed(request: FastifyRequest, module: AiModule): Promise<void> {
  const gated = SUMMARY_MODULES.has(module) || DOCUMENT_MODULES.has(module);
  const role = request.profile?.role;
  // A student tool module is gated for a student only; everyone else is held (or not) exactly as before.
  const studentTool = role === "student" && STUDENT_TOOL_MODULES.has(module);
  if (!gated && !studentTool) return;
  if (role === "counselor") {
    const { settings } = await loadPracticeSettings(request);
    refuse(module, settings);
    return;
  }
  if (role === "student") {
    const settings = await ownStudentPracticeSettings(request);
    refuse(module, settings);
    if (studentTool && !settings.studentAiTools) throw forbidden(STUDENT_TOOLS_OFF);
    return;
  }
  throw forbidden("Only counselors and their students can do that");
}

/** The signed-in student's practice switches, read fail-closed. */
async function ownStudentPracticeSettings(request: FastifyRequest): Promise<PrivacySettings> {
  const profile = request.profile as { counselor_id?: string | null } | null;
  const settings = await studentPracticeSettings(request.auth.userId, profile?.counselor_id ?? null, request.db);
  if (!settings) throw forbidden("This AI feature isn't available until your counselor's practice is set up.");
  return settings;
}

/**
 * For the routes behind a student tool that spend no model call themselves (adding the schools a Build College
 * Lists run found, say): a student needs the practice's "Let students use AI tools" switch on. A counselor is not
 * held by it. Fails closed like the AI gate.
 */
export async function assertStudentAiTools(request: FastifyRequest): Promise<void> {
  if (request.profile?.role !== "student") return;
  const settings = await ownStudentPracticeSettings(request);
  if (!settings.studentAiTools) throw forbidden(STUDENT_TOOLS_OFF);
}

/** Whether the signed-in student's practice has the tools on. Never throws: any doubt reads off (the app hides them). */
export async function studentAiToolsEnabled(request: FastifyRequest): Promise<boolean> {
  const profile = request.profile as { counselor_id?: string | null } | null;
  const settings = await studentPracticeSettings(request.auth.userId, profile?.counselor_id ?? null, request.db);
  return settings?.studentAiTools === true;
}

/** `assertStudentAiTools` as a preHandler, for the routes a student tool opens to students. */
export const requireStudentAiTools = async (request: FastifyRequest): Promise<void> => assertStudentAiTools(request);
