/**
 * Row -> DTO mapping.
 *
 * The frontend's `MeridiesUser` / `Profile` types in meridies-app/lib/api.ts are
 * the contract. The database is normalized (activities, awards, essays,
 * student_colleges, ...), so the `profile` object the client reads is
 * assembled here from those tables plus the free-form `profiles.profile` blob
 * that still holds intake answers. Normalized rows win over the blob.
 */

export type Role = "student" | "counselor";

export type Profile = {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  role_confirmed: boolean;
  onboarding_step: number;
  onboarding_complete: boolean;
  counselor_id: string | null;
  firm_id: string | null;
  avatar_url: string | null;
  phone: string | null;
  timezone: string | null;
  title: string | null;
  headline: string | null;
  hometown: string | null;
  high_school: string | null;
  grad_year: string | null;
  profile: Record<string, unknown> | null;
};

export type MeridiesUser = {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  onboardingStep: number;
  onboardingComplete: boolean;
  counselorId: string | null;
  counselorName: string | null;
  avatarUrl: string | null;
  profile: Record<string, unknown>;
};

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number | undefined =>
  v == null || v === "" ? undefined : Number(v);

/** Base user, with `profile` carrying only the scalar fields. */
export function toMeridiesUser(
  p: Profile,
  opts: { counselorName?: string | null; extraProfile?: Row } = {}
): MeridiesUser {
  const blob = (p.profile ?? {}) as Row;

  return {
    id: p.id,
    fullName: p.full_name,
    email: p.email,
    role: p.role,
    onboardingStep: p.onboarding_step,
    onboardingComplete: p.onboarding_complete,
    counselorId: p.counselor_id,
    counselorName: opts.counselorName ?? null,
    avatarUrl: p.avatar_url,
    profile: {
      ...blob,
      headline: p.headline ?? blob.headline,
      hometown: p.hometown ?? blob.hometown,
      highSchool: p.high_school ?? blob.highSchool,
      gradYear: p.grad_year ?? blob.gradYear,
      title: p.title ?? blob.title,
      ...(opts.extraProfile ?? {}),
    },
  };
}

// ---- Normalized record -> the shapes lib/api.ts already declares -----------

export const toActivity = (r: Row) => ({
  id: str(r.id),
  name: str(r.name),
  role: str(r.position),
  category: str(r.category),
  organization: str(r.organization),
  commitment:
    r.hours_per_week && r.weeks_per_year
      ? `${r.hours_per_week} hrs/wk · ${r.weeks_per_year} wks/yr`
      : str(r.timing),
  hoursPerWeek: num(r.hours_per_week),
  weeksPerYear: num(r.weeks_per_year),
  description: str(r.description),
  ucDescription: str(r.uc_description),
  gradeLevels: (r.grade_levels as string[]) ?? [],
  sortOrder: num(r.sort_order) ?? 0,
});

export const toAward = (r: Row) => ({
  id: str(r.id),
  name: str(r.name),
  level: str(r.level),
  year: str(r.year),
  ucCriteria: str(r.uc_criteria),
  ucEarned: str(r.uc_earned),
  sortOrder: num(r.sort_order) ?? 0,
});

export const toEssay = (r: Row) => ({
  id: str(r.id),
  title: str(r.title),
  prompt: str(r.prompt),
  school: str(r.school),
  words: str(r.word_count),
  wordCount: num(r.word_count) ?? 0,
  wordLimit: num(r.word_limit),
  status: str(r.status) as "not-started" | "drafting" | "review" | "final",
  dueDate: r.due_date ? str(r.due_date) : null,
  updatedAt: str(r.updated_at),
});

export const toCollege = (r: Row) => ({
  id: str(r.id),
  name: str(r.name),
  initials: str(r.initials) || initialsOf(str(r.name)),
  color: str(r.brand_color) || "#176b45",
  round: str(r.round),
  fit: (r.fit ? str(r.fit) : "target") as "reach" | "target" | "likely",
  status: str(r.status),
  binding: Boolean(r.binding),
  deadline: r.deadline ? str(r.deadline) : "",
  notes: str(r.notes),
  sortOrder: num(r.sort_order) ?? 0,
});

export const toNote = (r: Row) => ({
  id: str(r.id),
  date: str(r.meeting_date),
  title: str(r.title),
  summary: str(r.summary),
  body: str(r.body),
  tags: (r.tags as string[]) ?? [],
  visibility: str(r.visibility),
});

export const toNarrativeFlag = (r: Row) => ({
  id: str(r.id),
  studentId: str(r.student_id),
  severity: str(r.severity) as "high" | "medium" | "low",
  title: str(r.title),
  detail: str(r.detail),
  sourceA: str(r.source_a),
  sourceB: str(r.source_b),
  suggestion: str(r.suggestion),
  citation: (r.citation as Record<string, unknown>) ?? {},
  status: str(r.status) as "open" | "resolved",
  sharedWithStudent: Boolean(r.shared_with_student),
});

export const toFamilyReport = (r: Row) => ({
  id: str(r.id),
  studentId: str(r.student_id),
  title: str(r.title),
  kind: str(r.kind),
  date: str(r.created_at).slice(0, 10),
  summary: str(r.summary),
  highlights: (r.highlights as string[]) ?? [],
  body: str(r.body),
  status: str(r.status),
});

export const toSchoolReframing = (r: Row) => ({
  id: str(r.id),
  school: str(r.school),
  likes: (r.likes as { point: string }[]) ?? [],
  reframe: { from: str(r.reframe_from), to: str(r.reframe_to) },
  note: str(r.note),
});

export const toPolygonAxis = (r: Row) => ({
  id: str(r.id),
  key: str(r.key),
  label: str(r.label),
  description: str(r.description),
  maxScore: num(r.max_score) ?? 100,
  autoScore: num(r.auto_score) ?? null,
  manualScore: num(r.manual_score) ?? null,
  score: num(r.score) ?? 0,
  isManual: r.manual_score != null,
  note: str(r.note),
  source: str(r.source) as "default" | "custom",
  sortOrder: num(r.sort_order) ?? 0,
});

export const toDeadline = (r: Row) => ({
  id: str(r.id),
  studentId: str(r.student_id),
  title: str(r.title),
  school: r.school ? str(r.school) : null,
  type: str(r.type),
  dateLabel: r.date_label ? str(r.date_label) : null,
  dueDate: r.due_date ? str(r.due_date) : null,
  level: str(r.level),
  owner: str(r.owner) as "counselor" | "student",
  description: str(r.description),
  reminderSent: Boolean(r.reminder_sent),
  done: Boolean(r.done),
});

export const toInvitation = (r: Row) => {
  const accepter = r.accepted_by_profile as Row | null | undefined;
  return {
    id: str(r.id),
    email: str(r.email),
    status: str(r.status) as "pending" | "accepted" | "revoked",
    createdAt: str(r.created_at),
    expiresAt: r.expires_at ? str(r.expires_at) : null,
    acceptedAt: r.accepted_at ? str(r.accepted_at) : null,
    acceptedByName: accepter ? str(accepter.full_name) : null,
  };
};

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// ---- September 2026: tasks, files, review, blasts, college intelligence ----
//
// These surfaces are newer than the `profile` blob, so they follow the newest
// convention in the client (chat, polygon): camelCase DTOs with nulls rather
// than empty strings, so "no due date" is distinguishable from "the empty
// string" on the wire.

const nstr = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const nnum = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

export const toTaskStage = (r: Row) => ({
  id: str(r.id),
  deliverableId: str(r.deliverable_id),
  name: str(r.name),
  detail: nstr(r.detail),
  dueDate: nstr(r.due_date),
  sequence: num(r.sequence) ?? 0,
  done: Boolean(r.done),
  doneAt: nstr(r.done_at),
  deadlineId: nstr(r.deadline_id),
});

export const toTaskDocument = (r: Row) => {
  const doc = (r.document as Row | null) ?? null;
  return {
    documentId: str(r.document_id),
    role: str(r.role),
    note: nstr(r.note),
    filename: doc ? str(doc.filename) : null,
    title: doc ? nstr(doc.title) : null,
    mimeType: doc ? nstr(doc.mime_type) : null,
    sizeBytes: doc ? nnum(doc.size_bytes) : null,
    kind: doc ? str(doc.kind) : null,
    availableToLlm: doc ? Boolean(doc.available_to_llm) : null,
    /** Where the file is, so whoever can see it can open it (Storage RLS decides). */
    bucket: doc ? nstr(doc.bucket) : null,
    storagePath: doc ? nstr(doc.storage_path) : null,
    addedAt: nstr(r.created_at),
  };
};

/**
 * A task is a deliverable plus its stages and attached documents. The client
 * renders all three together, so they are one DTO rather than three fetches.
 */
export const toTask = (
  r: Row,
  extras: { stages?: Row[]; documents?: Row[]; tracker?: Row | null } = {}
) => ({
  id: str(r.id),
  studentId: str(r.student_id),
  kind: str(r.kind),
  title: str(r.title),
  instructions: nstr(r.instructions),
  status: str(r.status),
  dueDate: nstr(r.due_date),
  progressPct: num(r.progress_pct) ?? 0,
  targetWords: nnum(r.target_words),
  currentWords: num(r.current_words) ?? 0,
  essayId: nstr(r.essay_id),
  studentCollegeId: nstr(r.student_college_id),
  deadlineId: nstr(r.deadline_id),
  assignedBy: nstr(r.assigned_by),
  assignedAt: nstr(r.assigned_at),
  /**
   * SV Demo v2: "counselor" = assigned (the student only records progress);
   * "student" = the student added it for themselves (theirs to edit/delete).
   */
  source: (r.source === "student" ? "student" : "counselor") as "counselor" | "student",
  createdBy: nstr(r.created_by),
  /** A request from the New student page: answered by the student's Submit, received by the counselor. */
  intakeInvitationId: nstr(r.intake_invitation_id),
  intakeRequestId: nstr(r.intake_request_id),
  intakeAnswer: nstr(r.intake_answer),
  sentBackNote: nstr(r.sent_back_note),
  notifyEmail: Boolean(r.notify_email),
  notifySms: Boolean(r.notify_sms),
  notifiedAt: nstr(r.notified_at),
  notifyError: nstr(r.notify_error),
  lastActivityAt: nstr(r.last_activity_at),
  createdAt: nstr(r.created_at),
  updatedAt: nstr(r.updated_at),
  stages: (extras.stages ?? []).map(toTaskStage),
  documents: (extras.documents ?? []).map(toTaskDocument),
  tracker: extras.tracker ? toTrackerCheck(extras.tracker) : null,
});

export const toTrackerCheck = (r: Row) => ({
  id: str(r.id ?? r.check_id),
  deliverableId: str(r.deliverable_id),
  documentId: nstr(r.document_id),
  verdict: str(r.verdict) as "on-track" | "no-activity" | "below-the-brief",
  note: str(r.note),
  alignmentScore: nnum(r.alignment_score),
  daysSinceActivity: nnum(r.days_since_activity),
  stallAfterDays: nnum(r.stall_after_days),
  documentsChecked: num(r.documents_checked) ?? 0,
  findings: Array.isArray(r.findings) ? (r.findings as string[]) : [],
  source: str(r.source) as "system" | "ai" | "counselor",
  checkedAt: nstr(r.checked_at),
});

export const toFolder = (r: Row) => ({
  id: str(r.id),
  ownerId: str(r.owner_id),
  parentId: nstr(r.parent_id),
  studentId: nstr(r.student_id),
  name: str(r.name),
  description: nstr(r.description),
  kind: str(r.kind) as "custom" | "student",
  color: nstr(r.color),
  isSystem: Boolean(r.is_system),
  /** A practice folder a feature files into (v10 sync: calendar-files-axis). */
  systemKey: nstr(r.system_key) as "practice-templates" | "policy-research" | null,
  sortOrder: num(r.sort_order) ?? 0,
  createdAt: nstr(r.created_at),
});

export const toDocument = (r: Row) => ({
  id: str(r.id),
  studentId: nstr(r.student_id),
  folderId: nstr(r.folder_id),
  filename: str(r.filename),
  title: nstr(r.title),
  description: nstr(r.description),
  bucket: str(r.bucket),
  storagePath: str(r.storage_path),
  mimeType: nstr(r.mime_type),
  sizeBytes: nnum(r.size_bytes),
  kind: str(r.kind),
  source: str(r.source),
  parseStatus: str(r.parse_status),
  availableToLlm: Boolean(r.available_to_llm),
  /** Drive / OneDrive file this was imported from; the tracker watches it. */
  externalProvider: nstr(r.external_provider) as "google" | "microsoft" | null,
  externalWebUrl: nstr(r.external_web_url),
  externalModifiedAt: nstr(r.external_modified_at),
  createdAt: nstr(r.created_at),
  updatedAt: nstr(r.updated_at),
});

export const toDocumentLink = (r: Row) => ({
  id: str(r.id),
  ownerId: str(r.owner_id),
  studentId: nstr(r.student_id),
  folderId: nstr(r.folder_id),
  url: str(r.url),
  domain: nstr(r.domain),
  title: nstr(r.title),
  kind: str(r.kind),
  status: str(r.status) as "queued" | "reading" | "read" | "failed" | "skipped",
  summary: nstr(r.summary),
  keyPoints: arr(r.key_points),
  relevance: nstr(r.relevance),
  contentChars: nnum(r.content_chars),
  availableToLlm: Boolean(r.available_to_llm),
  error: nstr(r.error),
  readAt: nstr(r.read_at),
  createdAt: nstr(r.created_at),
});

export const toEssayMark = (r: Row) => ({
  id: str(r.id),
  essayId: str(r.essay_id),
  qualityCheckId: nstr(r.quality_check_id),
  dimension: str(r.dimension) as "content" | "grammar",
  severity: str(r.severity) as "critical" | "major" | "minor" | "suggestion",
  category: nstr(r.category),
  startOffset: num(r.start_offset) ?? 0,
  endOffset: num(r.end_offset) ?? 0,
  quotedText: str(r.quoted_text),
  comment: str(r.comment),
  /** Present only on grammar marks: the product never rewrites content. */
  suggestedReplacement: nstr(r.suggested_replacement),
  status: str(r.status) as "open" | "accepted" | "rejected" | "stale",
  createdBy: str(r.created_by) as "ai" | "counselor",
  appliedAt: nstr(r.applied_at),
  createdAt: nstr(r.created_at),
});

export const toEssayReview = (r: Row, marks: Row[] = []) => ({
  id: str(r.id),
  essayId: nstr(r.essay_id),
  wordCount: nnum(r.word_count),
  contentScore: nnum(r.content_score),
  grammarScore: nnum(r.grammar_score),
  contentNote: nstr(r.content_note),
  grammarNote: nstr(r.grammar_note),
  /** The effort/authenticity signal, kept distinct from the two product scores. */
  qualityScore: nnum(r.quality_score),
  aiLikelihood: nnum(r.ai_likelihood),
  verdict: nstr(r.verdict),
  findings: Array.isArray(r.findings) ? (r.findings as string[]) : [],
  markCount: num(r.mark_count) ?? marks.length,
  checkedAt: nstr(r.checked_at),
  marks: marks.map(toEssayMark),
});

export const toBlast = (r: Row) => ({
  id: str(r.id),
  subject: str(r.subject),
  body: str(r.body),
  audienceKind: str(r.audience_kind) as
    | "roster" | "class-year" | "school" | "status" | "selection",
  audienceValue: nstr(r.audience_value),
  audienceLabel: nstr(r.audience_label),
  channel: str(r.channel) as "email" | "sms" | "both",
  status: str(r.status),
  recipientCount: num(r.recipient_count) ?? 0,
  deliveredCount: num(r.delivered_count) ?? 0,
  failedCount: num(r.failed_count) ?? 0,
  sentAt: nstr(r.sent_at),
  createdAt: nstr(r.created_at),
});

export const toBlastRecipient = (r: Row) => ({
  id: str(r.id),
  studentId: nstr(r.student_id),
  fullName: nstr(r.full_name),
  toEmail: nstr(r.to_email),
  toPhone: nstr(r.to_phone),
  channel: str(r.channel) as "email" | "sms",
  status: str(r.status) as "queued" | "sent" | "skipped" | "failed",
  skipReason: nstr(r.skip_reason),
  error: nstr(r.error),
  sentAt: nstr(r.sent_at),
});

export const toFirm = (r: Row) => ({
  id: str(r.id),
  name: str(r.name),
  slug: nstr(r.slug),
  plan: str(r.plan),
  seats: num(r.seats) ?? 1,
  website: nstr(r.website),
  logoUrl: nstr(r.logo_url),
  bannerUrl: nstr(r.banner_url),
  accentColor: nstr(r.accent_color),
  accentColorSource: str(r.accent_color_source) as "default" | "logo" | "banner" | "manual",
});

// ---- College intelligence --------------------------------------------------
//
// `provenance` rides on every row on purpose: the client must be able to label
// a curated Meridies judgement differently from a sourced fact, and it can only
// do that if the distinction survives serialization.

const provenance = (r: Row) => ({
  provenance: (r.provenance ? str(r.provenance) : "sourced") as
    | "sourced" | "curated" | "estimated",
  sourceUrl: nstr(r.source_url),
  sourceVerifiedAt: nstr(r.source_verified_at),
});

export const toCollegeIntel = (r: Row) => ({
  collegeId: str(r.college_id),
  defaultAdmissionModel: nstr(r.default_admission_model),
  admissionModelNote: nstr(r.admission_model_note),
  classRankConsidered: nstr(r.class_rank_considered),
  classRankNote: nstr(r.class_rank_note),
  undergradEnrollment: nnum(r.undergrad_enrollment),
  graduateEnrollment: nnum(r.graduate_enrollment),
  gradToUndergradRatio: nnum(r.grad_to_undergrad_ratio),
  researchDesignation: nstr(r.research_designation),
  cdsYear: nnum(r.cds_year),
  cdsUrl: nstr(r.cds_url),
  curatorNote: nstr(r.curator_note),
  ...provenance(r),
});

export const toCollegeMajor = (r: Row) => ({
  id: str(r.id),
  collegeId: str(r.college_id),
  name: str(r.name),
  department: nstr(r.department),
  schoolOrCollege: nstr(r.school_or_college),
  cipCode: nstr(r.cip_code),
  discipline: nstr(r.discipline),
  facultyCount: nnum(r.faculty_count),
  majorsEnrolled: nnum(r.majors_enrolled),
  studentsPerFaculty: nnum(r.students_per_faculty),
  graduateEnrolled: nnum(r.graduate_enrolled),
  gradToUndergradRatio: nnum(r.grad_to_undergrad_ratio),
  admissionModel: nstr(r.admission_model),
  admissionModelNote: nstr(r.admission_model_note),
  secondaryAdmitRate: nnum(r.secondary_admit_rate),
  secondaryAdmitNote: nstr(r.secondary_admit_note),
  capacityConstrained: r.capacity_constrained == null ? null : Boolean(r.capacity_constrained),
  durability: nstr(r.durability) as
    | "growing" | "stable" | "under-review" | "being-cut" | null,
  durabilityNote: nstr(r.durability_note),
  durabilitySourceUrl: nstr(r.durability_source_url),
  durabilityVerifiedAt: nstr(r.durability_verified_at),
  graduationRate: nnum(r.graduation_rate),
  graduationRateYears: nnum(r.graduation_rate_years),
  programHealth: nstr(r.program_health),
  programHealthNote: nstr(r.program_health_note),
  fundingNote: nstr(r.funding_note),
  ...provenance(r),
});

export const toMajorAdmitStat = (r: Row) => ({
  id: str(r.id),
  collegeMajorId: str(r.college_major_id),
  cohortYear: num(r.cohort_year) ?? 0,
  entryPoint: str(r.entry_point) as "freshman" | "secondary-admission" | "transfer",
  applicants: nnum(r.applicants),
  admits: nnum(r.admits),
  enrolled: nnum(r.enrolled),
  acceptanceRate: nnum(r.acceptance_rate),
  edAcceptanceRate: nnum(r.ed_acceptance_rate),
  eaAcceptanceRate: nnum(r.ea_acceptance_rate),
  gpaAvg: nnum(r.gpa_avg),
  sat50: nnum(r.sat_50),
  act50: nnum(r.act_50),
  rigorNote: nstr(r.rigor_note),
  ...provenance(r),
});

export const toCdsFactor = (r: Row) => ({
  id: str(r.id),
  cdsYear: num(r.cds_year) ?? 0,
  factor: str(r.factor),
  weight: str(r.weight) as "very-important" | "important" | "considered" | "not-considered",
  note: nstr(r.note),
  ...provenance(r),
});

export const toCourseRequirement = (r: Row) => ({
  id: str(r.id),
  collegeMajorId: nstr(r.college_major_id),
  subject: str(r.subject),
  requirement: nstr(r.requirement),
  yearsRequired: nnum(r.years_required),
  minimumLevel: nstr(r.minimum_level),
  kind: str(r.kind) as "required" | "recommended" | "expected",
  note: nstr(r.note),
  ...provenance(r),
});

export const toRigorFlag = (r: Row) => ({
  id: str(r.id),
  collegeMajorId: nstr(r.college_major_id),
  title: str(r.title),
  detail: str(r.detail),
  severity: str(r.severity) as "critical" | "high" | "medium" | "low",
  triggerRule: (r.trigger_rule as Record<string, unknown>) ?? {},
  ...provenance(r),
});

/**
 * One of the three curated aid ratings. `kind` says which — need-based,
 * merit-based, or how *consistent* generosity is across income bands — and
 * `ratingKind` is carried through verbatim so the UI cannot accidentally
 * present a Meridies judgement as a federal statistic.
 */
export const toAidRating = (r: Row) => ({
  collegeId: str(r.college_id),
  kind: str(r.kind) as "need-based" | "merit-based" | "income-band-consistency",
  rating: num(r.rating) ?? 0,
  label: nstr(r.label),
  ratingKind: str(r.rating_kind),
  headline: nstr(r.headline),
  rationale: nstr(r.rationale),
  gotchas: arr(r.gotchas),
  meritReality: nstr(r.merit_reality),
  evidence: Array.isArray(r.evidence) ? (r.evidence as unknown[]) : [],
  methodologyUrl: nstr(r.methodology_url),
  ratedAt: nstr(r.rated_at),
  reviewDueAt: nstr(r.review_due_at),
});

export const toHighSchoolRanking = (r: Row) => ({
  id: str(r.id),
  name: str(r.name),
  ceebCode: nstr(r.ceeb_code),
  reportsClassRank: r.reports_class_rank == null ? null : Boolean(r.reports_class_rank),
  rankingPractice: nstr(r.ranking_practice),
  rankTransparency: nstr(r.rank_transparency),
  internalRankingNote: nstr(r.internal_ranking_note),
  schoolProfileUrl: nstr(r.school_profile_url),
  gradingScale: nstr(r.grading_scale),
  weightsGpa: r.weights_gpa == null ? null : Boolean(r.weights_gpa),
  apCoursesOffered: nnum(r.ap_courses_offered),
  ibProgram: r.ib_program == null ? null : Boolean(r.ib_program),
  profileVerifiedAt: nstr(r.profile_verified_at),
  // The published profile itself. Roughly one school in six publishes nothing,
  // so every one of these can legitimately come back null.
  city: nstr(r.city),
  state: nstr(r.state),
  type: nstr(r.type),
  enrollment: nnum(r.enrollment),
  graduatingClass: nnum(r.graduating_class),
  weightedScaleMax: nnum(r.weighted_scale_max),
  unweightedScaleMax: nnum(r.unweighted_scale_max),
  apCap: nstr(r.ap_cap),
  ibCoursesOffered: nnum(r.ib_courses_offered),
  medianSat: nnum(r.median_sat),
  medianAct: nnum(r.median_act),
  studentsPerCounselor: nnum(r.students_per_counselor),
  matriculation: arr(r.matriculation),
  notes: arr(r.profile_notes),
  sourceLabel: nstr(r.source_label),
});

// ---------------------------------------------------------------------------
// Demo v5 parity DTOs.
// ---------------------------------------------------------------------------

/**
 * A preference card. `counselorNote` is why a counselor cares about the answer,
 * so it is stripped for a student caller by the route rather than here — a DTO
 * that silently drops a field depending on who asked is hard to reason about.
 */
export const toPreferenceCard = (r: Row) => ({
  id: str(r.id),
  key: str(r.card_key),
  category: str(r.category),
  categoryLabel: str(r.category_label),
  prompt: str(r.prompt),
  counselorNote: nstr(r.counselor_note),
  example: nstr(r.example),
  sortOrder: num(r.sort_order) ?? 0,
});

export const toCardRating = (r: Row) => ({
  id: str(r.id),
  studentId: str(r.student_id),
  cardId: str(r.card_id),
  rating: str(r.rating) as "love" | "good" | "okay" | "bad" | "really-bad",
  ratedBy: nstr(r.rated_by),
  updatedAt: nstr(r.updated_at),
});

export const toPolygonHistoryPoint = (r: Row) => ({
  id: str(r.id),
  axisKey: str(r.axis_key),
  label: str(r.label),
  score: num(r.score) ?? 0,
  maxScore: num(r.max_score) ?? 100,
  isManual: Boolean(r.is_manual),
  source: str(r.source) as "default" | "custom",
  recordedAt: nstr(r.recorded_at),
});

export const toAlertPref = (r: Row) => ({
  studentId: str(r.student_id),
  copyParents: Boolean(r.copy_parents),
  copyStudent: Boolean(r.copy_student),
  note: nstr(r.note),
  updatedBy: nstr(r.updated_by),
  updatedAt: nstr(r.updated_at),
});

export const toStudentStatus = (r: Row) => ({
  studentId: str(r.student_id),
  status: str(r.status) as "on-track" | "at-risk" | "ahead",
  note: nstr(r.note),
  setBy: nstr(r.set_by),
  updatedAt: nstr(r.updated_at),
});

export const toMeeting = (r: Row) => ({
  id: str(r.id),
  studentId: str(r.student_id),
  counselorId: str(r.counselor_id),
  title: str(r.title),
  mode: str(r.mode) as "google-meet" | "teams" | "in-person" | "phone",
  location: nstr(r.location),
  joinUrl: nstr(r.join_url),
  startsAt: nstr(r.starts_at),
  endsAt: nstr(r.ends_at),
  status: str(r.status) as "scheduled" | "held" | "cancelled" | "no-show",
  agenda: nstr(r.agenda),
  guardiansInvited: Boolean(r.guardians_invited),
  meetingNoteId: nstr(r.meeting_note_id),
  deadlineId: nstr(r.deadline_id),
  /** Set when the API booked it on a connected Google / Outlook calendar. */
  calendarProvider: nstr(r.calendar_provider) as "google" | "microsoft" | null,
  createdAt: nstr(r.created_at),
});

export const toNotification = (r: Row) => ({
  id: str(r.id),
  studentId: nstr(r.student_id),
  kind: str(r.kind),
  urgency: str(r.urgency) as "critical" | "high" | "normal" | "low",
  title: str(r.title),
  body: nstr(r.body),
  href: nstr(r.href),
  actionItems: arr(r.action_items),
  readAt: nstr(r.read_at),
  createdAt: nstr(r.created_at),
});

/**
 * An integration. `config` never leaves the server: it is where provider ids and
 * anything token-adjacent live, and a client has no use for either.
 */
export const toIntegration = (r: Row) => ({
  id: str(r.id),
  provider: str(r.provider),
  status: str(r.status) as "disconnected" | "connected" | "error" | "syncing",
  scopes: arr(r.scopes),
  lastSyncedAt: nstr(r.last_synced_at),
  lastError: nstr(r.last_error),
  updatedAt: nstr(r.updated_at),
});

export const toRosterImport = (r: Row) => ({
  id: str(r.id),
  filename: str(r.filename),
  source: str(r.source) as "csv" | "google" | "microsoft" | "manual",
  mapping: (r.mapping ?? {}) as Record<string, unknown>,
  status: str(r.status) as "mapping" | "importing" | "complete" | "failed",
  rowsTotal: num(r.rows_total) ?? 0,
  rowsImported: num(r.rows_imported) ?? 0,
  rowsSkipped: num(r.rows_skipped) ?? 0,
  rowsFailed: num(r.rows_failed) ?? 0,
  error: nstr(r.error),
  createdAt: nstr(r.created_at),
  completedAt: nstr(r.completed_at),
});

export const toRosterImportRow = (r: Row) => ({
  id: str(r.id),
  importId: str(r.import_id),
  rowNumber: num(r.row_number) ?? 0,
  fullName: nstr(r.full_name),
  email: nstr(r.email),
  phone: nstr(r.phone),
  gradeLevel: nstr(r.grade_level),
  gradYear: nnum(r.grad_year),
  highSchool: nstr(r.high_school),
  gpaWeighted: nnum(r.gpa_weighted),
  gpaUnweighted: nnum(r.gpa_unweighted),
  satTotal: nnum(r.sat_total),
  actComposite: nnum(r.act_composite),
  intendedMajor: nstr(r.intended_major),
  status: str(r.status) as "pending" | "invited" | "skipped" | "failed",
  skipReason: nstr(r.skip_reason),
  invitationId: nstr(r.invitation_id),
  error: nstr(r.error),
});

export const toRankBand = (r: Row) => ({
  id: str(r.id),
  label: str(r.label),
  minWeightedGpa: num(r.min_weighted_gpa) ?? 0,
  percentile: num(r.percentile) ?? 0,
  sortOrder: num(r.sort_order) ?? 0,
  ...provenance(r),
});

/**
 * Generosity band by band — the evidence behind the income-band-consistency
 * rating, and the only honest answer when that rating is low.
 */
export const toAidBandRating = (r: Row) => ({
  collegeId: str(r.college_id),
  band: str(r.band),
  bandLabel: str(r.band_label),
  rating: num(r.rating) ?? 0,
  ratingKind: str(r.rating_kind),
  note: nstr(r.note),
  sortOrder: num(r.sort_order) ?? 0,
  ...provenance(r),
});

/**
 * A red flag as its student sees it — the `student_red_flags` view's columns,
 * plus the title of the deadline or deliverable it is about. No escalation
 * timing and no issuer id: when a parent alert fires is the counselor's lever.
 */
export const toStudentRedFlag = (
  r: Row,
  related: { deadlineTitle?: string | null; deliverableTitle?: string | null } = {}
) => ({
  id: str(r.id),
  severity: str(r.severity) as "critical" | "high" | "medium",
  title: str(r.title),
  message: str(r.message),
  actionItems: arr(r.action_items),
  trigger: str(r.trigger) as
    | "no-progress"
    | "low-quality"
    | "likely-ai"
    | "missed-deadline"
    | "manual",
  issuedBy: str(r.issued_by) as "system" | "counselor",
  status: str(r.status) as "open" | "acknowledged" | "escalated" | "resolved",
  deadlineId: nstr(r.deadline_id),
  deadlineTitle: related.deadlineTitle ?? null,
  deliverableId: nstr(r.deliverable_id),
  deliverableTitle: related.deliverableTitle ?? null,
  acknowledgedAt: nstr(r.acknowledged_at),
  resolvedAt: nstr(r.resolved_at),
  createdAt: nstr(r.created_at),
});
