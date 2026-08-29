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
