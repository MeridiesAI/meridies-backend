/**
 * Colleges, v8-v10: search ranking, research filing, decision rounds, the
 * profile extras' serializers, and the Build College Lists model.
 *
 * Ported from meridies-demo `lib/schoolSearch.ts`, `lib/collegeExtras.ts` and
 * `lib/listBuilder.ts`, minus the fixtures: every input here is a catalog row
 * or a student's own record, and nothing is filled in when a row is missing.
 */

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
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  const names = [name, ...aka].map((n) => n.toLowerCase());
  if (names.some((n) => n.startsWith(q))) return 0;
  if (q.length < 3) return -1;
  if (names.some((n) => n.split(/[\s,–-]+/).some((w) => w.startsWith(q)))) return 1;
  if (names.some((n) => n.includes(q))) return 2;
  return extra.some((e) => e.toLowerCase().includes(q)) ? 3 : -1;
}

/** Characters PostgREST's `or=(...)` filter would read as syntax. */
export function safeIlikeTerm(q: string): string {
  return q.replace(/[%_,()*\\:."']/g, " ").trim();
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
