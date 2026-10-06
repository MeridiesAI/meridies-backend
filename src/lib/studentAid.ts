/**
 * A student's Financial aid page (demo v8-v10): the aid overview and
 * Scholarship matching.
 *
 * The per-school checklist is *derived* from the college list, as the demo's
 * is: add a school and it gets a row, rather than quietly falling out of the
 * tracker. Only the counselor's marks are stored (`student_aid_checklist`),
 * on top of what the catalog and the award letters already say.
 *
 * FAFSA: status and due date only (v8). Nothing here reads, derives or
 * returns anything from inside the form, and there is no per-school FAFSA
 * cell. Which forms a *school* asks for is that school's published policy
 * (`college_aid_profiles.aid_methodology`), which is a different thing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fromPostgrest } from "./errors.js";

type Row = Record<string, unknown>;

const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const n = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Aid overview
// ---------------------------------------------------------------------------

export type ChecklistKey = "css" | "verification" | "award";

const ITEM_FOR: Record<ChecklistKey, string> = {
  css: "css-profile",
  verification: "verification",
  award: "award-letter",
};

const DONE_STATUSES = new Set(["submitted", "received", "waived", "not-applicable"]);

export type ChecklistCell = {
  key: ChecklistKey;
  label: string;
  done: boolean;
  /** False when the school does not ask for this at all: a dash, not a gap. */
  applicable: boolean;
  note: string | null;
  /** True when the counselor set this cell by hand. */
  overridden: boolean;
};

export type SchoolAidRow = {
  studentCollegeId: string;
  collegeId: string | null;
  name: string;
  /** Null when the school is not in the catalog: "check the school's site", never "not required". */
  cssRequired: boolean | null;
  aidMethodology: string | null;
  priorityDeadline: string | null;
  stickerPriceCents: number | null;
  /** This student's own estimate or letter, where one exists. Never a catalog average. */
  netPriceCents: number | null;
  netPriceSource: "award-letter" | "estimate" | null;
  checklist: ChecklistCell[];
};

export type FormSummary = {
  status: string;
  dueDate: string | null;
  /** 'set' by the counselor, or 'derived' from the earliest priority deadline. */
  dueDateSource: "set" | "derived" | null;
};

export type AidOverview = {
  studentId: string;
  fafsa: FormSummary;
  css: FormSummary & { requiredBySome: boolean };
  saiEstimate: number | null;
  family: {
    parentAgiCents: number | null;
    householdSize: number | null;
    numberInCollege: number | null;
    incomeBand: string | null;
    assetsBand: string | null;
    dependencyStatus: string | null;
    stateOfResidence: string | null;
    homeEquity: string | null;
    familyBusiness: string | null;
    parentStatus: string | null;
    siblingsInCollege: string | null;
  };
  schools: SchoolAidRow[];
  /** Share of checklist cells complete, 0-100; null when the list is empty. */
  completion: number | null;
};

export async function loadAidOverview(db: SupabaseClient, studentId: string): Promise<AidOverview> {
  const [profile, colleges, marks, letters, estimates] = await Promise.all([
    db.from("student_aid_profiles").select("*").eq("student_id", studentId).maybeSingle(),
    db
      .from("student_colleges")
      .select("id, college_id, name, deadline, status, sort_order")
      .eq("student_id", studentId)
      .neq("status", "withdrawn")
      .order("sort_order"),
    db.from("student_aid_checklist").select("*").eq("student_id", studentId),
    db
      .from("award_letters")
      .select("student_college_id, college_id, school_name, net_price_cents, received_at")
      .eq("student_id", studentId),
    db
      .from("net_price_estimates")
      .select("student_college_id, college_id, estimated_net_cents, computed_at")
      .eq("student_id", studentId)
      .order("computed_at", { ascending: false }),
  ]);
  for (const r of [profile, colleges, marks, letters, estimates]) {
    if (r.error) throw fromPostgrest(r.error);
  }

  const p = (profile.data ?? {}) as Row;
  const list = (colleges.data ?? []) as Row[];

  const collegeIds = [...new Set(list.map((c) => s(c.college_id)).filter((v): v is string => !!v))];
  const aidById = new Map<string, Row>();
  if (collegeIds.length > 0) {
    const { data, error } = await db
      .from("college_aid_profiles")
      .select(
        "college_id, css_profile_required, aid_methodology, priority_aid_deadline, sticker_price_cents, cost_of_attendance_cents"
      )
      .in("college_id", collegeIds);
    if (error) throw fromPostgrest(error);
    for (const r of (data ?? []) as Row[]) aidById.set(String(r.college_id), r);
  }

  const markRows = (marks.data ?? []) as Row[];
  const letterRows = (letters.data ?? []) as Row[];
  const estimateRows = (estimates.data ?? []) as Row[];
  const cssSubmitted = p.css_status === "submitted";

  const schools: SchoolAidRow[] = list.map((c) => {
    const scId = String(c.id);
    const collegeId = s(c.college_id);
    const aid = collegeId ? aidById.get(collegeId) : undefined;
    const cssRequired = aid && typeof aid.css_profile_required === "boolean" ? aid.css_profile_required : null;

    const markFor = (key: ChecklistKey) =>
      markRows.find((m) => m.student_college_id === scId && m.item === ITEM_FOR[key]);
    const letter = letterRows.find(
      (l) =>
        l.student_college_id === scId ||
        (collegeId && l.college_id === collegeId) ||
        String(l.school_name ?? "").toLowerCase() === String(c.name).toLowerCase()
    );
    const estimate = estimateRows.find(
      (e) => e.student_college_id === scId || (collegeId && e.college_id === collegeId)
    );

    const css = markFor("css");
    const verification = markFor("verification");
    const award = markFor("award");

    const checklist: ChecklistCell[] = [
      {
        key: "css",
        label: "CSS Profile submitted",
        applicable: cssRequired !== false,
        done: css ? DONE_STATUSES.has(String(css.status)) : cssRequired === false || (cssRequired === true && cssSubmitted),
        note: css
          ? s(css.note)
          : cssRequired === false
            ? "Not required here"
            : cssRequired === null
              ? "Not on file — check the school's aid page"
              : null,
        overridden: Boolean(css),
      },
      {
        // Only outstanding while a school has asked for documents.
        key: "verification",
        label: "Verification docs",
        applicable: Boolean(verification) && verification?.status !== "not-applicable",
        done: verification ? DONE_STATUSES.has(String(verification.status)) : true,
        note: verification ? s(verification.note) : "Not selected for verification",
        overridden: Boolean(verification),
      },
      {
        key: "award",
        label: "Award letter received",
        applicable: true,
        done: award ? DONE_STATUSES.has(String(award.status)) : Boolean(letter),
        note: award ? s(award.note) : letter ? null : "Arrives with the decision",
        overridden: Boolean(award),
      },
    ];

    const letterNet = letter ? n(letter.net_price_cents) : null;
    const estimateNet = estimate ? n(estimate.estimated_net_cents) : null;

    return {
      studentCollegeId: scId,
      collegeId,
      name: String(c.name),
      cssRequired,
      aidMethodology: aid ? s(aid.aid_methodology) : null,
      priorityDeadline: (aid ? s(aid.priority_aid_deadline) : null) ?? s(c.deadline),
      stickerPriceCents: aid ? n(aid.sticker_price_cents) ?? n(aid.cost_of_attendance_cents) : null,
      netPriceCents: letterNet ?? estimateNet,
      netPriceSource: letterNet !== null ? "award-letter" : estimateNet !== null ? "estimate" : null,
      checklist,
    };
  });

  const earliest = (rows: SchoolAidRow[]) =>
    rows
      .map((r) => r.priorityDeadline)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;

  const fafsaSet = s(p.fafsa_due_date);
  const cssSet = s(p.css_due_date);
  const fafsaDerived = earliest(schools);
  const cssDerived = earliest(schools.filter((r) => r.cssRequired === true));

  const cells = schools.flatMap((r) => r.checklist);
  const completion =
    cells.length === 0 ? null : Math.round((cells.filter((c) => c.done || !c.applicable).length / cells.length) * 100);

  return {
    studentId,
    fafsa: {
      status: s(p.fafsa_status) ?? "not-started",
      dueDate: fafsaSet ?? fafsaDerived,
      dueDateSource: fafsaSet ? "set" : fafsaDerived ? "derived" : null,
    },
    css: {
      status: s(p.css_status) ?? "not-started",
      dueDate: cssSet ?? cssDerived,
      dueDateSource: cssSet ? "set" : cssDerived ? "derived" : null,
      requiredBySome: schools.some((r) => r.cssRequired === true),
    },
    saiEstimate: n(p.sai_estimate),
    family: {
      parentAgiCents: n(p.parent_agi_cents),
      householdSize: n(p.household_size),
      numberInCollege: n(p.number_in_college),
      incomeBand: s(p.income_band),
      assetsBand: s(p.assets_band),
      dependencyStatus: s(p.dependency_status),
      stateOfResidence: s(p.state_of_residence),
      homeEquity: s(p.home_equity),
      familyBusiness: s(p.family_business),
      parentStatus: s(p.parent_status),
      siblingsInCollege: s(p.siblings_in_college),
    },
    schools,
    completion,
  };
}

/**
 * Mark one cell. Stored as the counselor's override on top of the derived
 * value; `done: null` drops the override and lands back on the derived one.
 */
export async function setChecklistCell(
  db: SupabaseClient,
  studentId: string,
  studentCollegeId: string,
  key: ChecklistKey,
  done: boolean | null,
  note?: string | null
): Promise<void> {
  const item = ITEM_FOR[key];
  const { data: existing, error } = await db
    .from("student_aid_checklist")
    .select("id")
    .eq("student_id", studentId)
    .eq("student_college_id", studentCollegeId)
    .eq("item", item)
    .maybeSingle();
  if (error) throw fromPostgrest(error);

  if (done === null) {
    if (existing) {
      const del = await db.from("student_aid_checklist").delete().eq("id", existing.id as string);
      if (del.error) throw fromPostgrest(del.error);
    }
    return;
  }

  const values: Row = {
    status: done ? (key === "award" ? "received" : "submitted") : "todo",
    completed_at: done ? new Date().toISOString() : null,
  };
  if (note !== undefined) values.note = note;

  const res = existing
    ? await db.from("student_aid_checklist").update(values).eq("id", existing.id as string)
    : await db
        .from("student_aid_checklist")
        .insert({ ...values, student_id: studentId, student_college_id: studentCollegeId, item });
  if (res.error) throw fromPostgrest(res.error);
}

// ---------------------------------------------------------------------------
// Scholarship matching
// ---------------------------------------------------------------------------

export const AUDIENCES = [
  "union",
  "military-family",
  "first-responder",
  "language",
  "disability",
  "hardship",
  "single-parent",
  "military-service",
] as const;
export type Audience = (typeof AUDIENCES)[number];

export type ScholarshipPrefs = {
  audience: Audience[];
  otherConnection: string | null;
  homeLanguage: string | null;
  minAwardCents: number;
  essaysOk: boolean;
  basis: "any" | "merit" | "need";
  maxApplications: number;
};

export const DEFAULT_PREFS: ScholarshipPrefs = {
  audience: [],
  otherConnection: null,
  homeLanguage: null,
  minAwardCents: 0,
  essaysOk: true,
  basis: "any",
  maxApplications: 8,
};

export function toPrefs(r: Row | null): ScholarshipPrefs {
  if (!r) return DEFAULT_PREFS;
  return {
    audience: (Array.isArray(r.audience) ? r.audience : []).filter((a): a is Audience =>
      (AUDIENCES as readonly string[]).includes(String(a))
    ),
    otherConnection: s(r.other_connection),
    homeLanguage: s(r.home_language),
    minAwardCents: n(r.min_award_cents) ?? 0,
    essaysOk: r.essays_ok !== false,
    basis: r.basis === "merit" || r.basis === "need" ? r.basis : "any",
    maxApplications: n(r.max_applications) ?? 8,
  };
}

export async function loadPrefs(db: SupabaseClient, studentId: string): Promise<ScholarshipPrefs> {
  const { data, error } = await db
    .from("scholarship_match_prefs")
    .select("*")
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw fromPostgrest(error);
  return toPrefs((data as Row | null) ?? null);
}

export type ScholarshipDto = {
  id: string;
  name: string;
  sponsor: string | null;
  url: string | null;
  description: string | null;
  amountCents: number | null;
  amountNote: string | null;
  renewable: boolean | null;
  opensAt: string | null;
  deadline: string | null;
  basis: "merit" | "need" | "both" | null;
  scope: string | null;
  essayRequired: boolean | null;
  sourceUrl: string | null;
};

export type ScholarshipMatch = ScholarshipDto & {
  /** The line that says which part of this student's profile it matched. */
  fit: string;
  matchedOn: "audience" | "major" | "activity" | "axis" | "state" | "gpa" | "grade" | "open";
  recommended: boolean;
  matchId: string | null;
};

export type HeldScholarship = ScholarshipDto & { reason: "closed" | "not-open" };

export type ScholarshipScan = {
  today: string;
  prefs: ScholarshipPrefs;
  matches: ScholarshipMatch[];
  /** Eligible, but outside their application window. */
  held: HeldScholarship[];
  /** What the matcher could not check because it is not on file. */
  missing: string[];
};

function toScholarship(r: Row): ScholarshipDto {
  const tags = Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [];
  const basis = tags.find((t) => t === "merit" || t === "need" || t === "both") as ScholarshipDto["basis"] | undefined;
  const scope = tags.find((t) => ["national", "state", "regional"].includes(t)) ?? null;
  return {
    id: String(r.id),
    name: String(r.name),
    sponsor: s(r.sponsor),
    url: s(r.url) ?? s(r.apply_url),
    description: s(r.description),
    amountCents: n(r.amount_cents),
    amountNote: s(r.amount_note),
    renewable: typeof r.renewable === "boolean" ? r.renewable : null,
    opensAt: s(r.opens_at),
    deadline: s(r.deadline),
    basis: basis ?? null,
    scope: scope ? scope[0].toUpperCase() + scope.slice(1) : null,
    essayRequired: typeof r.essay_required === "boolean" ? r.essay_required : null,
    sourceUrl: s(r.source_url),
  };
}

/** Senior class for a cycle: from August, the class graduating next summer. */
export function seniorClassYear(now: Date = new Date()): number {
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

type Attrs = {
  firstName: string;
  majors: string[];
  state: string | null;
  gpa: number | null;
  grade: number | null;
  gender: string | null;
  activityText: string[];
  axes: { label: string; score: number }[];
  audience: Audience[];
};

async function studentAttrs(db: SupabaseClient, studentId: string, prefs: ScholarshipPrefs): Promise<Attrs> {
  const [profile, details, academics, aid, activities, axes] = await Promise.all([
    db.from("profiles").select("full_name, grad_year, high_school_id").eq("id", studentId).maybeSingle(),
    db.from("student_personal_details").select("gender, intended_majors").eq("student_id", studentId).maybeSingle(),
    db.from("student_academics").select("gpa_weighted").eq("student_id", studentId).maybeSingle(),
    db.from("student_aid_profiles").select("state_of_residence").eq("student_id", studentId).maybeSingle(),
    db.from("activities").select("name, position, organization, category").eq("student_id", studentId),
    db
      .from("student_polygon_axes")
      .select("label, score, hidden, manual_score, auto_score")
      .eq("student_id", studentId),
  ]);
  for (const r of [profile, details, academics, aid, activities, axes]) {
    if (r.error) throw fromPostgrest(r.error);
  }

  let state: string | null = null;
  const residence = s((aid.data as Row | null)?.state_of_residence);
  if (residence && /^[A-Za-z]{2}$/.test(residence)) state = residence.toUpperCase();
  const hsId = s((profile.data as Row | null)?.high_school_id);
  if (!state && hsId) {
    const { data, error } = await db.from("high_schools").select("state").eq("id", hsId).maybeSingle();
    if (error) throw fromPostgrest(error);
    state = s((data as Row | null)?.state)?.toUpperCase() ?? null;
  }

  const gradYear = Number.parseInt(String((profile.data as Row | null)?.grad_year ?? ""), 10);
  const d = (details.data ?? {}) as Row;

  return {
    firstName: String((profile.data as Row | null)?.full_name ?? "the student").split(" ")[0],
    majors: (Array.isArray(d.intended_majors) ? (d.intended_majors as unknown[]) : []).map((m) =>
      String(m).toLowerCase()
    ),
    state,
    gpa: n((academics.data as Row | null)?.gpa_weighted),
    grade: Number.isFinite(gradYear) ? 12 - (gradYear - seniorClassYear()) : null,
    gender: s(d.gender),
    activityText: ((activities.data ?? []) as Row[]).map((a) =>
      [a.name, a.position, a.organization, a.category].filter(Boolean).join(" ").toLowerCase()
    ),
    axes: ((axes.data ?? []) as Row[])
      .filter((a) => a.hidden !== true && (a.manual_score != null || a.auto_score != null))
      .map((a) => ({ label: String(a.label), score: Number(a.score) })),
    audience: prefs.audience,
  };
}

const GENDER_WORDS: Record<string, string[]> = {
  female: ["female", "woman", "women", "girl"],
  male: ["male", "man", "men", "boy"],
  "non-binary": ["non-binary", "nonbinary"],
};

const AUDIENCE_FIT: Record<Audience, string> = {
  union: "For children of union members.",
  "military-family": "For children of service members.",
  "first-responder": "For children of first responders.",
  language: "For students who speak another language at home.",
  disability: "For students with a disability or chronic illness.",
  hardship: "For students who have faced significant hardship.",
  "single-parent": "For students raised by a single parent or guardian.",
  "military-service": "For students who plan to serve in the military.",
};

/**
 * Three gates, in the demo's order: eligibility (every stated criterion holds),
 * the counselor's answers, then time (open now, deadline ahead). What passes
 * says which part of this student's profile it matched on.
 */
export function matchOne(
  r: Row,
  a: Attrs
): { ok: boolean; matchedOn: ScholarshipMatch["matchedOn"]; fit: string } {
  const el = (r.eligibility ?? {}) as Row;
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : []);

  const audience = list(el.audience) as Audience[];
  if (audience.length > 0 && !audience.some((x) => a.audience.includes(x))) return fail();

  const states = list(el.states).map((x) => x.toUpperCase());
  if (states.length > 0 && (!a.state || !states.includes(a.state))) return fail();

  const majors = list(el.majors).map((x) => x.toLowerCase());
  const major = majors.length
    ? a.majors.find((m) => majors.some((x) => m.includes(x) || x.includes(m)))
    : undefined;
  if (majors.length > 0 && !major) return fail();

  const gpaMin = n(el.gpa_min);
  if (gpaMin !== null && (a.gpa === null || a.gpa < gpaMin)) return fail();

  const grades = list(el.grade_levels).map((x) => Number.parseInt(x, 10));
  if (grades.length > 0 && (a.grade === null || !grades.includes(a.grade))) return fail();

  const genders = list(el.gender).map((x) => x.toLowerCase());
  if (genders.length > 0) {
    const words = a.gender ? GENDER_WORDS[a.gender] ?? [] : [];
    if (!genders.some((g) => words.includes(g))) return fail();
  }

  const keywords = list(el.activity_keywords).map((x) => x.toLowerCase());
  const activity = keywords.length
    ? keywords.find((k) => a.activityText.some((t) => t.includes(k)))
    : undefined;
  if (keywords.length > 0 && !activity) return fail();

  const axisMin = el.axis_min as { label?: unknown; min?: unknown } | undefined;
  let axis: { label: string; score: number } | undefined;
  if (axisMin && typeof axisMin === "object" && axisMin.label) {
    axis = a.axes.find((x) => x.label.toLowerCase() === String(axisMin.label).toLowerCase());
    if (!axis || axis.score < Number(axisMin.min ?? 0)) return fail();
  }

  const first = a.firstName;
  if (audience.length > 0) {
    const hit = audience.find((x) => a.audience.includes(x)) as Audience;
    return { ok: true, matchedOn: "audience", fit: AUDIENCE_FIT[hit] };
  }
  if (major) return { ok: true, matchedOn: "major", fit: `Matches ${first}'s intended major, ${major}.` };
  if (activity) return { ok: true, matchedOn: "activity", fit: `Matches ${first}'s activities (${activity}).` };
  if (axis) return { ok: true, matchedOn: "axis", fit: `${first}'s ${axis.label} score (${Math.round(axis.score)}) clears the bar.` };
  if (states.length > 0) return { ok: true, matchedOn: "state", fit: `Open to ${a.state} residents.` };
  if (gpaMin !== null) return { ok: true, matchedOn: "gpa", fit: `${first}'s weighted GPA clears the ${gpaMin} minimum.` };
  if (grades.length > 0) return { ok: true, matchedOn: "grade", fit: `Open to ${first}'s grade this cycle.` };
  return { ok: true, matchedOn: "open", fit: "Open to every student who applies." };

  function fail() {
    return { ok: false, matchedOn: "open" as const, fit: "" };
  }
}

export async function scanScholarships(
  db: SupabaseClient,
  studentId: string,
  prefsOverride?: ScholarshipPrefs
): Promise<ScholarshipScan> {
  const prefs = prefsOverride ?? (await loadPrefs(db, studentId));
  const today = todayIso();

  const [catalog, matches, attrs] = await Promise.all([
    db.from("scholarships").select("*").eq("is_active", true).limit(1000),
    db
      .from("scholarship_matches")
      .select("id, scholarship_id, status")
      .eq("student_id", studentId)
      .not("scholarship_id", "is", null),
    studentAttrs(db, studentId, prefs),
  ]);
  if (catalog.error) throw fromPostgrest(catalog.error);
  if (matches.error) throw fromPostgrest(matches.error);

  const recommended = new Map<string, string>();
  for (const m of (matches.data ?? []) as Row[]) {
    if (m.status !== "dismissed" && m.status !== "suggested") {
      recommended.set(String(m.scholarship_id), String(m.id));
    }
  }

  const out: ScholarshipMatch[] = [];
  const held: HeldScholarship[] = [];

  for (const r of (catalog.data ?? []) as Row[]) {
    const dto = toScholarship(r);
    const fit = matchOne(r, attrs);
    if (!fit.ok) continue;

    // The counselor's answers.
    if (prefs.minAwardCents > 0 && (dto.amountCents ?? 0) < prefs.minAwardCents) continue;
    if (!prefs.essaysOk && dto.essayRequired === true) continue;
    if (prefs.basis === "merit" && dto.basis !== "merit" && dto.basis !== "both") continue;
    if (prefs.basis === "need" && dto.basis !== "need" && dto.basis !== "both") continue;

    // Time. A listing whose deadline passed is worse than no result.
    if (dto.deadline && dto.deadline < today) {
      held.push({ ...dto, reason: "closed" });
      continue;
    }
    if (dto.opensAt && dto.opensAt > today) {
      held.push({ ...dto, reason: "not-open" });
      continue;
    }

    out.push({
      ...dto,
      fit: fit.fit,
      matchedOn: fit.matchedOn,
      recommended: recommended.has(dto.id),
      matchId: recommended.get(dto.id) ?? null,
    });
  }

  // Recommended first, then soonest deadline.
  out.sort(
    (x, y) =>
      Number(y.recommended) - Number(x.recommended) ||
      (x.deadline ?? "9999").localeCompare(y.deadline ?? "9999")
  );

  const missing: string[] = [];
  if (attrs.gpa === null) missing.push("weighted GPA");
  if (attrs.grade === null) missing.push("graduation year");
  if (attrs.state === null) missing.push("state of residence");
  if (attrs.majors.length === 0) missing.push("intended majors");

  return {
    today,
    prefs,
    matches: out.slice(0, prefs.maxApplications),
    held: held.sort((x, y) => (x.deadline ?? "").localeCompare(y.deadline ?? "")),
    missing,
  };
}
