/**
 * The student's College list and Application sections: row -> DTO mapping and
 * the small rules the routes share. The DTO shapes are the contract declared
 * in meridies-app/lib/api.ts under "v10 sync: student-application".
 */

import { toCollegePhoto, type CollegePhotoRow } from "./collegePhotos.js";
import { currentCycle } from "./supplementDocs.js";

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? "" : String(v));
const nstr = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const nnum = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function initialsOf(name: string): string {
  const words = name.replace(/[^A-Za-z ]/g, " ").split(/\s+/).filter(Boolean);
  const skip = new Set(["of", "the", "at", "and", "university", "college"]);
  const strong = words.filter((w) => !skip.has(w.toLowerCase()));
  const pick = (strong.length > 0 ? strong : words).slice(0, 2);
  return pick.map((w) => w[0]!.toUpperCase()).join("") || name.slice(0, 2).toUpperCase();
}

// ---- College list ------------------------------------------------------------

export type BoardStage = "interested" | "applying" | "applied";

/** The board column a row sits in: its status, read three ways. */
export function stageOf(status: string): BoardStage {
  if (status === "not-started") return "interested";
  if (status === "in-progress") return "applying";
  return "applied";
}

export const STAGE_STATUS: Record<BoardStage, "not-started" | "in-progress" | "submitted"> = {
  interested: "not-started",
  applying: "in-progress",
  applied: "submitted",
};

/** The catalog columns a list row embeds. */
export const LIST_SELECT =
  "*, college:colleges(id, slug, name, city, state, acceptance_rate, test_policy, application_fee_cents, deadlines, website)";

/** "Early Action" / "Regular Decision" / ... in colleges.deadlines, by round. */
const PLAN_NAMES: Record<string, string[]> = {
  ED: ["Early Decision", "Early Decision I"],
  ED2: ["Early Decision II"],
  EA: ["Early Action"],
  REA: ["Restrictive Early Action"],
  SCEA: ["Single-Choice Early Action", "Restrictive Early Action"],
  RD: ["Regular Decision", "Regular Action"],
  rolling: ["Rolling"],
  priority: ["Priority"],
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The catalog's "Nov 1" for a round, as a date in the cycle's year: the cycle
 * opens in August, so August to December fall in its first year and January to
 * July in its second. Null when the catalog has no date for that round.
 */
export function catalogDeadline(deadlines: unknown, round: string | null, cycle = currentCycle()): string | null {
  if (!deadlines || typeof deadlines !== "object") return null;
  const map = deadlines as Record<string, unknown>;
  const names = PLAN_NAMES[round ?? "RD"] ?? PLAN_NAMES.RD!;
  const raw = names.map((n) => map[n]).find((v) => typeof v === "string") as string | undefined;
  if (!raw) return null;
  const m = raw.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return null;
  const first = Number(cycle.slice(0, 4));
  const year = month >= 7 ? first : first + 1;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

export function toListCollege(
  r: Row,
  supplementCounts: Map<string, number> = new Map(),
  photos: Map<string, CollegePhotoRow> = new Map()
) {
  const c = (r.college ?? null) as Row | null;
  const status = str(r.status) || "not-started";
  const collegeId = nstr(r.college_id);
  const admit = c ? nnum(c.acceptance_rate) : null;
  return {
    id: str(r.id),
    collegeId,
    collegeSlug: c ? nstr(c.slug) : null,
    /** The catalog college's campus photo (lib/collegePhotos.ts), or null. */
    collegePhoto: collegeId ? toCollegePhoto(photos.get(collegeId), str(c?.name) || str(r.name)) : null,
    name: str(r.name),
    initials: str(r.initials) || initialsOf(str(r.name)),
    color: str(r.brand_color) || "#176b45",
    city: c ? [nstr(c.city), nstr(c.state)].filter(Boolean).join(", ") || null : null,
    round: nstr(r.round),
    fit: nstr(r.fit) as "reach" | "target" | "likely" | null,
    status,
    stage: stageOf(status),
    binding: Boolean(r.binding),
    deadline: nstr(r.deadline),
    customDeadline: nstr(r.custom_deadline),
    intendedMajor: nstr(r.intended_major),
    recsRequired: nnum(r.recs_required),
    recsInHand: nnum(r.recs_in_hand),
    testing: nstr(r.testing) ?? (c ? nstr(c.test_policy) : null),
    testingOverridden: r.testing != null,
    applicationFeeCents: nnum(r.application_fee_cents) ?? (c ? nnum(c.application_fee_cents) : null),
    feeOverridden: r.application_fee_cents != null,
    /** Reported acceptance rate as a percentage (catalog), or null. */
    admitRate: admit === null ? null : Math.round(admit * 1000) / 10,
    supplementCount: collegeId ? supplementCounts.get(collegeId) ?? 0 : 0,
    notes: str(r.notes),
    sortOrder: nnum(r.sort_order) ?? 0,
    updatedAt: str(r.updated_at),
  };
}

export function toRecommendation(r: Row) {
  return {
    id: str(r.id),
    collegeId: nstr(r.college_id),
    name: str(r.name),
    fit: nstr(r.fit) as "reach" | "target" | "likely" | null,
    suggestedBy: (str(r.suggested_by) || "counselor") as "counselor" | "axis",
    recommendedByName: nstr(r.recommended_by_name),
    why: nstr(r.why),
    status: str(r.status) as "open" | "dismissed" | "added",
    createdAt: str(r.created_at),
  };
}

// ---- Essays ------------------------------------------------------------------

export const ESSAY_SELECT =
  "*, document:documents(id, filename, mime_type, source, external_provider, external_web_url, available_to_llm, ai_access, ferpa_waived, parse_status, bucket, storage_path), supplement_doc:supplement_docs(id, web_url, admission_cycle)";

function fileKindOf(doc: Row | null, url: string | null): "google-doc" | "word" | "pdf" | "image" | "other" {
  if (url && /docs\.google\.com\/document/.test(url)) return "google-doc";
  if (!doc) return url ? "other" : "google-doc";
  const provider = nstr(doc.external_provider);
  const mime = str(doc.mime_type).toLowerCase();
  const name = str(doc.filename).toLowerCase();
  if (provider === "google" && (mime.includes("google-apps.document") || !mime)) return "google-doc";
  if (mime.includes("wordprocessingml") || mime === "application/msword" || /\.docx?$/.test(name)) return "word";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  return "other";
}

export function toEssayDoc(r: Row) {
  const doc = (r.document ?? null) as Row | null;
  const sdoc = (r.supplement_doc ?? null) as Row | null;
  const url =
    (sdoc ? nstr(sdoc.web_url) : null) ??
    (doc ? nstr(doc.external_web_url) : null) ??
    nstr(r.external_url);
  const provider = doc ? nstr(doc.external_provider) : null;
  const source: "gdoc" | "word" | "upload" | "link" =
    sdoc || provider === "google"
      ? "gdoc"
      : provider === "microsoft"
        ? "word"
        : doc
          ? "upload"
          : url
            ? "link"
            : "gdoc";
  const body = str(r.body);
  const textStatus = (str(r.text_status) || "read") as "pending" | "read" | "unreadable";
  return {
    id: str(r.id),
    essayKind: (str(r.essay_kind) || "supplement") as "personal-statement" | "supplement" | "other",
    title: str(r.title),
    prompt: str(r.prompt),
    school: str(r.school),
    studentCollegeId: nstr(r.student_college_id),
    collegeSupplementId: nstr(r.college_supplement_id),
    supplementDocId: nstr(r.supplement_doc_id),
    documentId: nstr(r.document_id),
    wordCount: nnum(r.word_count) ?? 0,
    wordLimit: nnum(r.word_limit),
    status: (str(r.status) || "not-started") as "not-started" | "drafting" | "review" | "final",
    dueDate: nstr(r.due_date),
    source,
    url,
    linkIsMine: false,
    fileKind: fileKindOf(doc, url),
    textStatus,
    readable: textStatus !== "unreadable",
    availableToLlm: doc ? doc.available_to_llm !== false : true,
    /** An upload's Storage object, for a signed preview link (null for suite files). */
    file: doc && !url && doc.storage_path ? { bucket: str(doc.bucket) || "student-documents", path: str(doc.storage_path) } : null,
    excerpt: body.slice(0, 800),
    updatedAt: str(r.updated_at),
    sortOrder: nnum(r.sort_order) ?? 0,
  };
}

export function toSupplementPrompt(r: Row) {
  return {
    id: str(r.id),
    collegeId: str(r.college_id),
    cycle: str(r.admission_cycle),
    title: str(r.title),
    prompt: str(r.prompt),
    wordLimit: nnum(r.word_limit),
    scope: str(r.scope) as "universal" | "major" | "scholarship",
    majorOrProgram: nstr(r.major_or_program),
    required: r.required !== false,
    sortOrder: nnum(r.sort_order) ?? 0,
    verified: r.source_verified_at != null,
    sourceUrl: nstr(r.source_url),
  };
}

export function toSupplementDoc(r: Row, cycle = currentCycle()) {
  return {
    id: str(r.id),
    studentCollegeId: nstr(r.student_college_id),
    collegeId: nstr(r.college_id),
    collegeName: str(r.college_name),
    cycle: str(r.admission_cycle),
    title: str(r.title),
    webUrl: str(r.web_url),
    sharedWith: nstr(r.shared_with),
    shareStatus: str(r.share_status) as "shared" | "not-shared" | "failed",
    /** A Doc from an earlier cycle: kept, never rewritten (the student may have typed into it). */
    outdated: str(r.admission_cycle) !== cycle,
    ownedByMe: false,
    textSyncedAt: nstr(r.text_synced_at),
    createdAt: str(r.created_at),
  };
}

// ---- Sheets ------------------------------------------------------------------

export const UC_CATEGORIES = ["coursework-other", "educational-prep", "extracurricular", "volunteer", "work"] as const;
export const GRADES = ["9", "10", "11", "12", "PG"] as const;
export const TIMINGS = ["school", "break", "year"] as const;
export const RECOGNITION = ["school", "state-regional", "national", "international"] as const;
export const UC_LEVELS = ["school", "city-community", "state", "regional", "national", "international"] as const;

export function toSheetActivity(r: Row) {
  const timing = arr(r.timing)[0]?.toLowerCase() ?? null;
  return {
    id: str(r.id),
    category: nstr(r.category),
    gradeLevels: arr(r.grade_levels),
    timing: (TIMINGS as readonly string[]).includes(timing ?? "") ? (timing as (typeof TIMINGS)[number]) : null,
    hoursPerWeek: nnum(r.hours_per_week),
    weeksPerYear: nnum(r.weeks_per_year),
    continuing: r.continuing == null ? null : Boolean(r.continuing),
    position: str(r.position),
    organization: str(r.organization) || str(r.name),
    description: str(r.description),
    ucCategory: nstr(r.uc_category) as (typeof UC_CATEGORIES)[number] | null,
    ucOrgDescription: str(r.uc_org_description),
    ucDescription: str(r.uc_description),
    sortOrder: nnum(r.sort_order) ?? 0,
  };
}

export function toSheetHonor(r: Row) {
  return {
    id: str(r.id),
    title: str(r.name),
    gradeLevels: arr(r.grade_levels),
    recognitionLevels: arr(r.recognition_levels),
    ucType: nstr(r.uc_type) as "academic" | "non-academic" | null,
    ucLevel: nstr(r.uc_level) as (typeof UC_LEVELS)[number] | null,
    ucEligibility: str(r.uc_criteria),
    ucAchievement: str(r.uc_earned),
    sortOrder: nnum(r.sort_order) ?? 0,
  };
}

// ---- Coherence / Activities Build -------------------------------------------

export function toFlag(r: Row) {
  return {
    id: str(r.id),
    severity: (str(r.severity) || "medium") as "high" | "medium" | "low",
    what: str(r.title),
    where: str(r.location) || [nstr(r.source_a), nstr(r.source_b)].filter(Boolean).join(" against "),
    fix: str(r.suggestion),
    status: str(r.status) as "open" | "resolved" | "dismissed",
    assignedTaskId: nstr(r.assigned_task_id),
  };
}

export function toCoherenceReport(r: Row, flags: Row[]) {
  return {
    id: str(r.id),
    criteria: (r.criteria ?? {}) as Record<string, unknown>,
    read: arr(r.read_labels),
    storyline: arr(r.storyline),
    next: arr(r.next_steps),
    flags: flags.map(toFlag),
    createdAt: str(r.created_at),
  };
}

export function toProgram(r: Row) {
  return {
    id: str(r.id),
    name: str(r.name),
    host: nstr(r.org),
    url: nstr(r.url),
    applyUrl: nstr(r.apply_url),
    summary: str(r.summary),
    whyFit: str(r.why_fit),
    eligibility: nstr(r.eligibility_notes),
    deadline: nstr(r.deadline),
    deadlineNote: nstr(r.scheduling_notes),
    type: nstr(r.program_type),
    duration: nstr(r.duration),
    location: nstr(r.location),
    online: r.online == null ? null : Boolean(r.online),
    topics: arr(r.topics),
    source: (str(r.source) || "axis") as "catalog" | "axis",
    status: str(r.status),
    assignedTaskId: nstr(r.assigned_task_id),
  };
}
