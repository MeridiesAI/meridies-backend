/**
 * Colleges, v8-v10: search ranking, research filing, decision rounds, the
 * profile extras' serializers, and the Build College Lists model.
 *
 * Ported from meridies-demo `lib/schoolSearch.ts`, `lib/collegeExtras.ts` and
 * `lib/listBuilder.ts`, minus the fixtures: every input here is a catalog row
 * or a student's own record, and nothing is filled in when a row is missing.
 */

import { z } from "zod";
import { consideration, testPolicyFrom } from "./ingest/ipeds.js";
import { RACE_KEYS, type RaceKey } from "./ingest/scorecard.js";
import {
  carnegieBasicLabel,
  carnegieSizeSettingLabel,
  completionLabels,
  isReligiouslyAffiliated,
  predominantDegreeLabel,
} from "./scorecardCodes.js";

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? "" : String(v));
const nstr = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const nnum = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

export type Provenance = "sourced" | "curated" | "estimated";
const prov = (r: Row) => ({
  provenance: (nstr(r.provenance) ?? "sourced") as Provenance,
  sourceUrl: nstr(r.source_url),
  sourceVerifiedAt: nstr(r.source_verified_at),
});

// ---- Catalog summary --------------------------------------------------------

/** The columns every card needs: name, place, logo key (slug), the headline numbers. */
export const COLLEGE_CARD_COLUMNS =
  "id, name, slug, aka, initials, brand_color, city, state, control, size, acceptance_rate, test_policy, website, deadlines";

export const toCollegeCard = (r: Row) => ({
  id: str(r.id),
  name: str(r.name),
  slug: str(r.slug),
  aka: arr(r.aka),
  initials: nstr(r.initials),
  brandColor: nstr(r.brand_color),
  city: nstr(r.city),
  state: nstr(r.state),
  control: nstr(r.control),
  size: nnum(r.size),
  acceptanceRate: nnum(r.acceptance_rate),
  testPolicy: nstr(r.test_policy),
  website: nstr(r.website),
});

// ---- Search -----------------------------------------------------------------

/**
 * Rank a school against what the counselor has typed ("Co" -> Colgate,
 * Columbia, Cornell): name prefix first, then a word in the name, then the
 * name anywhere, then city, state or a popular major. Two letters only match
 * a name being typed. -1 means no match.
 */
export function searchRank(name: string, aka: string[], extra: string[], query: string): number {
  // Both sides lose punctuation the same way, so "st johns" and "St. John's" meet.
  const norm = (s: string) => safeIlikeTerm(s).toLowerCase();
  const q = norm(query);
  if (!q) return -1;
  const names = [name, ...aka].map(norm);
  if (names.some((n) => n.startsWith(q))) return 0;
  if (q.length < 3) return -1;
  if (names.some((n) => n.split(/[\s,–-]+/).some((w) => w.startsWith(q)))) return 1;
  if (names.some((n) => n.includes(q))) return 2;
  return extra.some((e) => norm(e).includes(q)) ? 3 : -1;
}

/**
 * A search term safe to splice into PostgREST's `or=(...)` filter and an ILIKE
 * pattern. An allow-list, not a block-list: letters (any script), digits and
 * spaces survive; everything else (`;`, `-`, `,`, `(`, `%`, `&`...) becomes a
 * space, so no input can change the filter's syntax or its wildcards. "Texas
 * A&M" and "St. John's" still find their school through the words left over.
 */
export function safeIlikeTerm(q: string): string {
  return q
    .normalize("NFC")
    .replace(/['\u2019]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Escape ILIKE's own wildcards so user text matches literally. */
export function escapeIlike(q: string): string {
  return q.replace(/[%_\\]/g, (c) => `\\${c}`);
}

// ---- Research filing ----------------------------------------------------------

function hostWords(website: string | null): string | null {
  if (!website) return null;
  const host = website.replace(/^https?:\/\/(www\.)?/i, "").split("/")[0];
  return host ? host.toLowerCase().replace(/\./g, " ") : null;
}

/**
 * The school a resource is about, read off its address or file name: a name
 * or alias in the text, or the school's own domain. Null when nothing matches
 * (the caller files it under "General").
 */
export function schoolIn(
  text: string,
  colleges: { id: string; name: string; aka: string[]; website: string | null }[]
): { id: string; name: string } | null {
  const t = ` ${text.toLowerCase().replace(/[-_./]+/g, " ")} `;
  // Longest names first, so "University of Pennsylvania" wins over "Penn".
  const sorted = [...colleges].sort((a, b) => b.name.length - a.name.length);
  for (const c of sorted) {
    if ([c.name, ...c.aka].some((n) => n.length >= 3 && t.includes(` ${n.toLowerCase()} `))) {
      return { id: c.id, name: c.name };
    }
  }
  for (const c of sorted) {
    const host = hostWords(c.website);
    if (host && t.includes(` ${host} `)) return { id: c.id, name: c.name };
    // A subdomain of the school's own site ("admissions.cornell.edu").
    if (host && t.includes(` ${host}`) && host.split(" ").length >= 2) {
      return { id: c.id, name: c.name };
    }
  }
  return null;
}

// ---- Decision rounds -----------------------------------------------------------

export type Round = "ED" | "ED II" | "EA" | "REA" | "RD";

export const ROUND_LABEL: Record<Round, string> = {
  ED: "Early Decision",
  "ED II": "Early Decision II",
  EA: "Early Action",
  REA: "Restrictive Early Action",
  RD: "Regular Decision",
};

/** The rounds a school publishes, read off its plan names, with each deadline. */
export function roundsFrom(deadlines: unknown): { round: Round; label: string; plan: string; deadline: string }[] {
  if (!deadlines || typeof deadlines !== "object" || Array.isArray(deadlines)) return [];
  return Object.entries(deadlines as Record<string, unknown>)
    .filter(([, d]) => typeof d === "string" && d.trim())
    .map(([plan, d]) => {
      const n = plan.toLowerCase();
      const round: Round =
        n.includes("restrictive") || n.includes("single-choice")
          ? "REA"
          : n.includes("decision ii") || n.includes("ed ii")
            ? "ED II"
            : n.includes("early decision")
              ? "ED"
              : n.includes("early action")
                ? "EA"
                : "RD";
      return { round, label: ROUND_LABEL[round], plan, deadline: String(d) };
    });
}

// ---- Profile extras ---------------------------------------------------------------

export const toProfileFacts = (r: Row) => ({
  address: nstr(r.address),
  founded: nnum(r.founded),
  campusSetting: nstr(r.campus_setting),
  overview: nstr(r.overview),
  studentFacultyRatio: nstr(r.student_faculty_ratio),
  graduationRate4yr: nnum(r.graduation_rate_4yr),
  graduationRate6yr: nnum(r.graduation_rate_6yr),
  retentionRate: nnum(r.retention_rate),
  roomAndBoardCents: nnum(r.room_and_board_cents),
  satRange: nstr(r.sat_range),
  actRange: nstr(r.act_range),
  gpaRange: nstr(r.gpa_range),
  commonApp: r.common_app == null ? null : Boolean(r.common_app),
  popularMajors: arr(r.popular_majors),
  studentLife: (r.student_life as Record<string, unknown> | null) ?? null,
  admissionRequirements: (r.admission_requirements as Record<string, unknown> | null) ?? null,
  netPriceByIncome: Array.isArray(r.net_price_by_income)
    ? (r.net_price_by_income as { band: string; priceCents: number }[])
    : [],
  sourceNote: nstr(r.source_note),
  ...prov(r),
});

/** Curated: `ratingKind` travels verbatim so the UI labels it as a Meridies rating. */
export const toAdmittedProfile = (r: Row) => ({
  axes: Array.isArray(r.axes) ? (r.axes as { label: string; value: number }[]) : [],
  ratingKind: str(r.rating_kind),
  note: nstr(r.note),
  ratedAt: nstr(r.rated_at),
});

export const toCdsEdition = (r: Row) => ({
  edition: str(r.edition),
  url: str(r.url),
  releasedLabel: nstr(r.released_label),
  checkedAt: nstr(r.checked_at),
  ...prov(r),
});

export const toCollegeProgram = (r: Row) => ({
  id: str(r.id),
  kind: str(r.kind) as "combined" | "special",
  name: str(r.name),
  ...prov(r),
});

export const toWebinarTip = (r: Row, viewerId: string) => ({
  id: str(r.id),
  collegeId: str(r.college_id),
  source: str(r.source),
  sessionDate: nstr(r.session_date),
  tip: str(r.tip),
  sourceUrl: nstr(r.source_url),
  /** "meridies": a curator's note for everyone; "firm" / "mine": a counselor's. */
  scope: (r.created_by == null && r.firm_id == null
    ? "meridies"
    : r.firm_id != null
      ? "firm"
      : "mine") as "meridies" | "firm" | "mine",
  mine: r.created_by === viewerId,
  createdAt: str(r.created_at),
});

// ---- Build College Lists ---------------------------------------------------------

export const SCHOOL_SIZES = [
  { label: "Small", min: 0, max: 2000 },
  { label: "Medium", min: 2000, max: 15000 },
  { label: "Large", min: 15000, max: 30000 },
  { label: "Very large", min: 30000, max: Infinity },
] as const;

export const LOCATION_TYPES = ["Rural", "Small city", "Major city", "Suburban", "College town"] as const;
export const AID_OPTIONS = ["No preference", "Lenient", "Limited"] as const;
export const DIVERSITY_OPTIONS = ["No preference", "Yes", "No"] as const;
export const LIST_MILES = { min: 50, max: 3000 } as const;

export type Fit = "reach" | "target" | "likely";

export type ListCriteria = {
  majors: string[];
  sizes: string[];
  settings: string[];
  testOptional: "Yes" | "No" | null;
  miles: number;
  origin: { lat: number; lng: number; label: string } | null;
  aid: (typeof AID_OPTIONS)[number];
  diversity: (typeof DIVERSITY_OPTIONS)[number];
};

export type ListSchool = {
  collegeId: string;
  slug: string;
  name: string;
  initials: string | null;
  brandColor: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  lat: number;
  lng: number;
  undergrads: number | null;
  setting: string | null;
  testPolicy: string | null;
  /** Admit rate, % (0-100). */
  admit: number | null;
  satMid: number | null;
  gpaMid: number | null;
  /** The Meridies need-based rating, 1-10. Curated. */
  needRating: number | null;
  largestGroupPct: number | null;
  fields: string[];
  regularDeadline: string | null;
};

type Field =
  | "Engineering" | "Computer Science" | "Mathematics" | "Sciences" | "Nursing"
  | "Public Health" | "Business" | "Economics" | "Humanities" | "Arts";

/** The field a major needs a school to teach. Order matters: first match wins. */
const FIELD_RULES: [RegExp, Field][] = [
  [/nurs/i, "Nursing"],
  [/public health|global health|community health|health policy/i, "Public Health"],
  [/engineer|bioeng/i, "Engineering"],
  [/computer|software|data sci|computing|informatics/i, "Computer Science"],
  [/math|statistic/i, "Mathematics"],
  [/econ/i, "Economics"],
  [/business|financ|account|market|management|entrepreneur/i, "Business"],
  [/history|english|philosoph|politic|government|international|writing|journal|law|humanit|language|classics/i, "Humanities"],
  [/bio|chem|physics|neuro|pre-?med|medicine|science/i, "Sciences"],
  [/\barts?\b|music|design|film|theat|drama|dance|architect/i, "Arts"],
];

export function fieldFor(major: string): Field | null {
  return FIELD_RULES.find(([re]) => re.test(major))?.[1] ?? null;
}

export function sizeLabel(undergrads: number | null): string | null {
  if (undergrads == null) return null;
  return SCHOOL_SIZES.find((s) => undergrads >= s.min && undergrads < s.max)?.label ?? null;
}

/** Great-circle miles between two points. */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}

/** Share of undergraduates above which a campus does not count as diverse. */
const DIVERSE_MAX = 45;
/** Meridies need-based rating floors for each aid answer. */
export const AID_FLOOR: Record<string, number> = { Lenient: 5, Limited: 8 };

export type Constraint =
  | "Diversity" | "Financial aid" | "Location type" | "School size" | "Test optional" | "Majors";

/** Loosened in this order when nothing matches: preferences first, the major last. */
const RELAX_ORDER: Constraint[] = ["Diversity", "Financial aid", "Location type", "School size", "Test optional", "Majors"];

function tests(c: ListCriteria): Record<Constraint, { on: boolean; test: (s: ListSchool) => boolean }> {
  const fields = c.majors.map(fieldFor).filter((f): f is Field => f !== null);
  return {
    Majors: { on: fields.length > 0, test: (s) => fields.some((f) => s.fields.includes(f)) },
    "School size": { on: c.sizes.length > 0, test: (s) => c.sizes.includes(sizeLabel(s.undergrads) ?? "") },
    "Location type": { on: c.settings.length > 0, test: (s) => s.setting !== null && c.settings.includes(s.setting) },
    "Test optional": {
      on: c.testOptional === "Yes",
      test: (s) => s.testPolicy === "optional" || s.testPolicy === "blind",
    },
    // A school with no Meridies rating on file cannot pass an aid floor.
    "Financial aid": { on: c.aid in AID_FLOOR, test: (s) => (s.needRating ?? 0) >= AID_FLOOR[c.aid] },
    Diversity: {
      on: c.diversity === "Yes",
      test: (s) => s.largestGroupPct !== null && s.largestGroupPct <= DIVERSE_MAX,
    },
  };
}

export type StudentNumbers = { sat: number | null; gpaUnweighted: number | null };

/**
 * This student's odds at one school: the published rate, lifted or lowered by
 * where their SAT and unweighted GPA sit against the school's middle. A test
 * optional list is modelled without the SAT. Null when the school publishes
 * no admit rate: no number is better than an invented one.
 */
export function studentOdds(student: StudentNumbers, s: ListSchool, withScores: boolean): number | null {
  if (s.admit == null) return null;
  const sat = withScores ? student.sat : null;
  const satEdge = sat && s.satMid ? (sat - s.satMid) / 80 : 0;
  const gpaEdge = student.gpaUnweighted && s.gpaMid ? (student.gpaUnweighted - s.gpaMid) / 0.2 : 0;
  return Math.max(0.5, Math.min(94, s.admit * Math.exp(0.35 * satEdge + 0.35 * gpaEdge)));
}

/** Under 15% admitted is a reach for anyone, whatever the numbers say. */
export function fitFor(s: ListSchool, odds: number | null): Fit {
  if (odds == null || (s.admit ?? 0) < 15 || odds < 35) return "reach";
  if (odds < 70) return "target";
  return "likely";
}

export type ListPick = { school: ListSchool; miles: number | null; odds: number | null; fit: Fit };

export function buildList(
  student: StudentNumbers,
  schools: ListSchool[],
  c: ListCriteria
): { picks: ListPick[]; relaxed: Constraint[] } {
  const withScores = c.testOptional !== "Yes";
  const near = schools
    .map((school) => ({
      school,
      miles: c.origin ? Math.round(milesBetween(c.origin, { lat: school.lat, lng: school.lng })) : null,
    }))
    .filter((s) => s.miles === null || s.miles <= c.miles);
  const checks = tests(c);
  const relaxed: Constraint[] = [];
  for (;;) {
    const active = RELAX_ORDER.filter((k) => checks[k].on && !relaxed.includes(k));
    const hits = near.filter((s) => active.every((k) => checks[k].test(s.school)));
    if (hits.length > 0 || active.length === 0) {
      const picks = hits.map(({ school, miles }) => {
        const odds = studentOdds(student, school, withScores);
        return { school, miles, odds, fit: fitFor(school, odds) };
      });
      picks.sort((a, b) => (b.odds ?? -1) - (a.odds ?? -1) || (a.school.admit ?? 100) - (b.school.admit ?? 100));
      return { picks, relaxed };
    }
    relaxed.push(active[0]);
  }
}

export const toListSchool = (college: Row, list: Row, needRating: number | null): ListSchool => {
  const deadlines = (college.deadlines ?? {}) as Record<string, unknown>;
  const regular =
    Object.entries(deadlines).find(([plan]) => /regular/i.test(plan))?.[1] ??
    Object.values(deadlines).at(-1) ??
    null;
  const rate = nnum(college.acceptance_rate);
  return {
    collegeId: str(college.id),
    slug: str(college.slug),
    name: str(college.name),
    initials: nstr(college.initials),
    brandColor: nstr(college.brand_color),
    city: nstr(college.city),
    state: nstr(college.state),
    website: nstr(college.website),
    lat: Number(list.latitude),
    lng: Number(list.longitude),
    undergrads: nnum(college.size),
    setting: nstr(list.campus_setting),
    testPolicy: nstr(college.test_policy),
    admit: rate == null ? null : Math.round(rate * 10000) / 100,
    satMid: nnum(list.sat_mid),
    gpaMid: nnum(list.gpa_mid),
    needRating,
    largestGroupPct: nnum(list.largest_group_pct),
    fields: arr(list.field_areas),
    regularDeadline: regular == null ? null : String(regular),
  };
};

// ---- Official data (College Scorecard, IPEDS) ---------------------------------------

/** Older than this, official figures are flagged rather than served as current. */
export const STALE_AFTER_DAYS = 395; // ~13 months: one yearly release plus a month's grace

export function freshness(verifiedAt: unknown, dataYear: unknown, now = Date.now()) {
  const at = typeof verifiedAt === "string" ? Date.parse(verifiedAt) : NaN;
  return {
    dataYear: dataYear == null ? null : String(dataYear),
    verifiedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    // No date at all is stale too: we can't say it's current.
    stale: !Number.isFinite(at) || now - at > STALE_AFTER_DAYS * 86_400_000,
  };
}

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/** A 0-1 share from a jsonb object, or null: a missing column, key or junk value all read as not reported. */
const shareOf = (obj: unknown, key: string): number | null => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
};
const byRace = (obj: unknown) => Object.fromEntries(RACE_KEYS.map((k) => [k, shareOf(obj, k)])) as Record<RaceKey, number | null>;

/** Smallint codes from college_stats; undefined (a column the migration hasn't added) is null. */
const codeOf = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) ? n : null;
};

/**
 * Every key below `medianEarnings10yr` comes from migration 20261023080001 or
 * from a coded column served raw before; each is null (or all-null) when its
 * column is absent, so this serves the same shape before the migration.
 */
export const toOfficialStats = (r: Row, now = Date.now()) => ({
  admitRate: numOrNull(r.admit_rate),
  openAdmissions: r.open_admissions == null ? null : Boolean(r.open_admissions),
  satRange: r.sat_total_25 != null && r.sat_total_75 != null ? { p25: Number(r.sat_total_25), p75: Number(r.sat_total_75) } : null,
  satEbrw: r.sat_ebrw_25 != null && r.sat_ebrw_75 != null ? { p25: Number(r.sat_ebrw_25), p75: Number(r.sat_ebrw_75) } : null,
  satMath: r.sat_math_25 != null && r.sat_math_75 != null ? { p25: Number(r.sat_math_25), p75: Number(r.sat_math_75) } : null,
  actRange: r.act_25 != null && r.act_75 != null ? { p25: Number(r.act_25), p75: Number(r.act_75) } : null,
  undergradEnrollment: numOrNull(r.undergrad_enrollment),
  control: (r.control as string | null) ?? null,
  locale: numOrNull(r.locale),
  hbcu: r.hbcu === true,
  hsi: r.hsi === true,
  tribal: r.tribal === true,
  womenOnly: r.women_only === true,
  menOnly: r.men_only === true,
  religiousAffiliation: numOrNull(r.religious_affiliation),
  costOfAttendance: numOrNull(r.cost_of_attendance),
  tuitionInState: numOrNull(r.tuition_in_state),
  tuitionOutOfState: numOrNull(r.tuition_out_of_state),
  avgNetPrice: numOrNull(r.avg_net_price),
  netPriceByIncome: (r.net_price_by_income as Record<string, number> | null) ?? {},
  priceCalculatorUrl: (r.price_calculator_url as string | null) ?? null,
  pellRate: numOrNull(r.pell_rate),
  federalLoanRate: numOrNull(r.federal_loan_rate),
  medianDebt: numOrNull(r.median_debt),
  // latest.completion.consumer_rate: the graduation rate Scorecard's site sorts
  // by (Outcome Measures, an award within 8 years for all entering students,
  // where reported; else first-time full-time within 150% of normal time).
  // Never a 6-year rate: gradRate150 below is the timed one.
  gradRate: numOrNull(r.grad_rate),
  medianEarnings10yr: numOrNull(r.median_earnings_10yr),
  // The coded fields, raw and labelled.
  testRequirements: codeOf(r.test_requirements),
  predominantDegree: codeOf(r.predominant_degree),
  carnegieSizeSetting: codeOf(r.carnegie_size_setting),
  carnegieBasic: codeOf(r.carnegie_basic),
  religious: isReligiouslyAffiliated(codeOf(r.religious_affiliation)),
  labels: {
    // The curated campus-setting words, so a catalog school and a profiled one read alike.
    setting: settingFromLocale(codeOf(r.locale)),
    carnegieSizeSetting: carnegieSizeSettingLabel(codeOf(r.carnegie_size_setting)),
    carnegieBasic: carnegieBasicLabel(codeOf(r.carnegie_basic)),
    // The catalog's test-policy words (required, recommended, optional, blind).
    testPolicy: testPolicyFrom(consideration(r.test_requirements == null ? undefined : String(r.test_requirements))),
    predominantDegree: predominantDegreeLabel(codeOf(r.predominant_degree)),
    gradRateOnTime: completionLabels(nstr(r.completion_basis)).onTime,
    gradRate150: completionLabels(nstr(r.completion_basis)).within150,
  },
  // First-time full-time completion, from one IPEDS cohort (completionBasis).
  completionBasis: r.completion_basis === "four-year" || r.completion_basis === "less-than-four-year" ? r.completion_basis : null,
  gradRateOnTime: numOrNull(r.grad_rate_on_time),
  gradRate150: numOrNull(r.grad_rate_150),
  completionByRace: byRace(r.completion_by_race),
  retentionRate: numOrNull(r.retention_rate),
  partTimeShare: numOrNull(r.part_time_share),
  studentFacultyRatio: numOrNull(r.student_faculty_ratio),
  gradStudents: numOrNull(r.grad_students),
  // Shares of degree-seeking undergraduates.
  demographics: {
    women: shareOf(r.demographics, "women"),
    men: shareOf(r.demographics, "men"),
    race: byRace(r.demographics),
  },
  roomBoardOnCampus: numOrNull(r.room_board_on_campus),
  booksSupplies: numOrNull(r.books_supplies),
  medianEarnings6yr: numOrNull(r.median_earnings_6yr),
  medianDebtMonthly: numOrNull(r.median_debt_monthly),
  medianDebtNoncompleters: numOrNull(r.median_debt_noncompleters),
  provenance: "sourced" as const,
  sourceUrl: String(r.source_url ?? ""),
  ...freshness(r.source_verified_at, r.data_year, now),
});

export const toAdmissionFactors = (r: Row, now = Date.now()) => ({
  gpa: (r.gpa as string | null) ?? null,
  classRank: (r.class_rank as string | null) ?? null,
  record: (r.record as string | null) ?? null,
  collegePrep: (r.college_prep as string | null) ?? null,
  recommendations: (r.recommendations as string | null) ?? null,
  competencies: (r.competencies as string | null) ?? null,
  testScores: (r.test_scores as string | null) ?? null,
  englishProficiency: (r.english_proficiency as string | null) ?? null,
  workExperience: (r.work_experience as string | null) ?? null,
  essay: (r.essay as string | null) ?? null,
  legacy: (r.legacy as string | null) ?? null,
  testPolicy: (r.test_policy as string | null) ?? null,
  provenance: "sourced" as const,
  sourceUrl: String(r.source_url ?? ""),
  ...freshness(r.source_verified_at, r.data_year, now),
});

export const toFieldOfStudy = (r: Row) => ({
  cipCode: String(r.cip_code),
  title: String(r.title),
  credentialLevel: Number(r.credential_level),
  awards: numOrNull(r.awards),
  earnings4yr: numOrNull(r.earnings_4yr),
  medianDebt: numOrNull(r.median_debt),
});

// ---- Search query (GET /colleges/search) --------------------------------------------

const csvOf = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .string()
    .trim()
    .max(2000)
    .transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item).max(max));

const truthy = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const NET_PRICE_BANDS = ["0-30000", "30001-48000", "48001-75000", "75001-110000", "110001-plus"] as const;

export const searchQuery = z
  .object({
    q: z.string().trim().max(120).default(""),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().max(40).optional(),
    sort: z.enum(["relevance", "name", "admit-rate", "net-price", "enrollment", "distance"]).optional(),
    states: csvOf(z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()), 60).optional(),
    control: csvOf(z.enum(["public", "private", "private-for-profit"]), 3).optional(),
    testPolicy: csvOf(z.enum(["required", "optional", "blind", "recommended"]), 4).optional(),
    setting: csvOf(z.enum(["city", "suburb", "town", "rural"]), 4).optional(),
    majors: csvOf(z.string().min(2).max(80), 10).optional(),
    admitMin: z.coerce.number().min(0).max(1).optional(),
    admitMax: z.coerce.number().min(0).max(1).optional(),
    enrollmentMin: z.coerce.number().int().min(0).optional(),
    enrollmentMax: z.coerce.number().int().min(0).optional(),
    netPriceMax: z.coerce.number().int().min(0).max(200_000).optional(),
    band: z.enum(NET_PRICE_BANDS).optional(),
    hbcu: truthy.optional(),
    hsi: truthy.optional(),
    womenOnly: truthy.optional(),
    religious: truthy.optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    miles: z.coerce.number().min(1).max(3000).optional(),
    studentId: z.string().uuid().optional(),
    fit: csvOf(z.enum(["reach", "target", "likely"]), 3).optional(),
    superscore: csvOf(z.enum(["sat", "act", "both", "none"]), 4).optional(),
    cssProfile: truthy.optional(),
    stars: truthy.optional(),
  })
  .strict()
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: "lat and lng go together" });

export type SearchQuery = z.infer<typeof searchQuery>;

/** The query string -> search_colleges' p_filters. Only keys that were given. */
export function searchFilters(q: SearchQuery): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (q.states?.length) f.states = q.states;
  if (q.control?.length) f.control = q.control;
  if (q.testPolicy?.length) f.testPolicy = q.testPolicy;
  if (q.setting?.length) f.setting = q.setting;
  if (q.majors?.length) f.majors = q.majors.map((m) => (/^\d{4}$/.test(m) ? m : safeIlikeTerm(m))).filter(Boolean);
  if (q.admitMin !== undefined || q.admitMax !== undefined) f.admitRate = { min: q.admitMin ?? 0, max: q.admitMax ?? 1 };
  if (q.enrollmentMin !== undefined || q.enrollmentMax !== undefined) {
    f.enrollment = { min: q.enrollmentMin ?? 0, max: q.enrollmentMax ?? 2_147_483_647 };
  }
  if (q.netPriceMax !== undefined) f.netPrice = { max: q.netPriceMax, band: q.band ?? "" };
  if (q.hbcu) f.hbcu = true;
  if (q.hsi) f.hsi = true;
  if (q.womenOnly) f.womenOnly = true;
  if (q.religious) f.religious = true;
  if (q.lat !== undefined && q.lng !== undefined) f.near = { lat: q.lat, lng: q.lng, miles: q.miles ?? 100 };
  if (q.fit?.length) f.fit = q.fit;
  if (q.superscore?.length) f.superscore = q.superscore;
  if (q.cssProfile !== undefined) f.cssProfile = q.cssProfile;
  if (q.stars !== undefined) f.stars = q.stars;
  return f;
}

/** Opaque page cursors: the offset, base64url. */
export const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString("base64url");
export function decodeCursor(cursor: string): number {
  const m = /^o:(\d{1,5})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? Math.min(Number(m[1]), 10_000) : 0;
}

/** The few official figures a search card shows. */
export const toSearchStats = (r: Row, now = Date.now()) => ({
  admitRate: numOrNull(r.admit_rate),
  satRange: r.sat_total_25 != null && r.sat_total_75 != null ? { p25: Number(r.sat_total_25), p75: Number(r.sat_total_75) } : null,
  actRange: r.act_25 != null && r.act_75 != null ? { p25: Number(r.act_25), p75: Number(r.act_75) } : null,
  avgNetPrice: numOrNull(r.avg_net_price),
  netPriceByIncome: (r.net_price_by_income as Record<string, number> | null) ?? {},
  undergradEnrollment: numOrNull(r.undergrad_enrollment),
  ...freshness(r.source_verified_at, r.data_year, now),
});

// ---- Curated per-school data (college_policies, requirements, major admit rates) --------

export const toCollegePolicies = (r: Row) => ({
  superscore: (r.superscore as string | null) ?? null,
  selfReportScores: r.self_report_scores == null ? null : Boolean(r.self_report_scores),
  cssProfileRequired: r.css_profile_required == null ? null : Boolean(r.css_profile_required),
  starsRequired: r.stars_required == null ? null : Boolean(r.stars_required),
  fairtestStatus: (r.fairtest_status as string | null) ?? null,
  // Per field: where it came from and when it was checked.
  sources: (r.sources as Record<string, { url: string; checkedAt: string }> | null) ?? {},
  provenance: "curated" as const,
});

export const toApplicationRequirements = (r: Row, now = Date.now()) => ({
  cycle: String(r.cycle),
  platforms: (r.platforms as string[] | null) ?? [],
  applicationFeeCents: numOrNull(r.application_fee_cents),
  feeWaiver: r.fee_waiver == null ? null : Boolean(r.fee_waiver),
  personalEssayRequired: r.personal_essay_required == null ? null : Boolean(r.personal_essay_required),
  supplementCount: numOrNull(r.supplement_count),
  teacherRecs: numOrNull(r.teacher_recs),
  counselorRec: r.counselor_rec == null ? null : Boolean(r.counselor_rec),
  testing: (r.testing as string | null) ?? null,
  portfolio: (r.portfolio as string | null) ?? null,
  starsRequired: r.stars_required == null ? null : Boolean(r.stars_required),
  sourceUrl: String(r.source_url ?? ""),
  ...freshness(r.source_verified_at, r.cycle, now),
});

export const toMajorAdmitRate = (r: Row) => ({
  system: String(r.system),
  major: String(r.major),
  cipCode: (r.cip_code as string | null) ?? null,
  entryYear: Number(r.entry_year),
  residency: String(r.residency),
  applicants: numOrNull(r.applicants),
  admits: numOrNull(r.admits),
  admitRate: numOrNull(r.admit_rate),
  impacted: r.impacted == null ? null : Boolean(r.impacted),
  openMajor: r.open_major == null ? null : Boolean(r.open_major),
  eligibilityIndex: numOrNull(r.eligibility_index),
  sourceUrl: String(r.source_url ?? ""),
});

// ---- List builder candidates from the whole catalog --------------------------------------

/** IPEDS locale -> the builder's location types. */
export function settingFromLocale(locale: number | null): (typeof LOCATION_TYPES)[number] | null {
  if (locale == null) return null;
  if (locale === 11) return "Major city";
  if (locale === 12 || locale === 13) return "Small city";
  if (locale >= 21 && locale <= 23) return "Suburban";
  if (locale >= 31 && locale <= 33) return "College town";
  if (locale >= 41 && locale <= 43) return "Rural";
  return null;
}

/** A catalog school (official figures, no curated list profile) in the builder's shape. */
export function listSchoolFromCatalog(
  college: Row,
  stats: Row,
  testPolicy: string | null,
  needRating: number | null,
  programTitles: string[]
): ListSchool | null {
  const lat = nnum(stats.latitude);
  const lng = nnum(stats.longitude);
  if (lat == null || lng == null) return null;
  const admit = nnum(stats.admit_rate);
  const s25 = nnum(stats.sat_total_25);
  const s75 = nnum(stats.sat_total_75);
  const fields = [...new Set(programTitles.map(fieldFor).filter((f): f is Field => f !== null))];
  const deadlines = (college.deadlines ?? {}) as Record<string, unknown>;
  const regular = Object.entries(deadlines).find(([plan]) => /regular/i.test(plan))?.[1] ?? null;
  return {
    collegeId: str(college.id),
    slug: str(college.slug),
    name: str(college.name),
    initials: nstr(college.initials),
    brandColor: nstr(college.brand_color),
    city: nstr(college.city),
    state: nstr(college.state),
    website: nstr(college.website),
    lat,
    lng,
    undergrads: nnum(stats.undergrad_enrollment),
    setting: settingFromLocale(nnum(stats.locale)),
    testPolicy,
    admit: admit == null ? null : Math.round(admit * 1000) / 10,
    satMid: s25 != null && s75 != null ? (s25 + s75) / 2 : null,
    gpaMid: null,
    needRating,
    largestGroupPct: null,
    fields,
    regularDeadline: regular == null ? null : String(regular),
  };
}
