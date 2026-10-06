/**
 * Emits supabase/migrations/20260923000001_seed_catalog.sql from the
 * meridies-demo fixtures.
 *
 *   MERIDIES_DEMO_DIR=../meridies-demo \
 *     npx tsx scripts/seed/generate-catalog.ts \
 *     > supabase/migrations/20260923000001_seed_catalog.sql
 *
 * The demo is the only place this catalog has been written down, so the seed is
 * a translation of it, never an extension of it. The rules this script holds
 * itself to:
 *
 *   - A column is filled only when a fixture states the value. Everything else
 *     stays null, so the API can say "unknown" instead of repeating a guess.
 *   - Curated Meridies judgements (generosity ratings, durability calls, the
 *     program-health verdicts) are written with `rating_kind =
 *     'meridies-curated'` / `provenance = 'curated'`, never as sourced data.
 *   - Synthesised data is not seeded. The demo's scattergram cloud is a PRNG
 *     (`applicantCloud` in collegeData.ts says "in production this array is a
 *     query, not a generator"), so `scattergram_points` stays empty.
 *   - Student-specific demo copy ("...for Evan's aid needs") never reaches a
 *     catalog row; the generator asserts no roster first name survives.
 *   - Every statement is idempotent: ON CONFLICT on a natural key where one
 *     exists, WHERE NOT EXISTS where it does not.
 *
 * Not part of the build (tsconfig only includes src/). It imports the demo's
 * TypeScript directly, so run it with tsx from a checkout that has both repos.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

// ---- The subset of the demo's fixture types this script reads ---------------

type GenerosityRating = { rating: number; label: string; rationale: string };
type DemoCollege = {
  id: string;
  name: string;
  city: string;
  state: string;
  website: string;
  aka?: string[];
  color: string;
  initials: string;
  control: "Public" | "Private nonprofit";
  undergradEnrollment: number;
  acceptanceRate: number;
  tuitionInState: number;
  tuitionOutOfState: number;
  avgNeedBasedAid: number;
  testPolicy: string;
  decisionPlans: { plan: string; deadline: string }[];
  departments: { major: string; facultyCount: number; undergradMajors: number; note: string }[];
  admitModels: { discipline: string; model: string; detail: string }[];
  majorDurability: { major: string; status: string; note: string; source: string }[];
  testingRigor: { rigorWeight: string; note: string; source: string };
  gradMix: { gradEnrollment: number };
  programHealth: {
    program: string;
    majorsEnrolled: number;
    completion4yr: number;
    fundingTrend: string;
    verdict: string;
    source: string;
  }[];
  classRank: { cdsPosition: string; internalPractice: string; source: string };
  courseRigor: { expected: string[]; redFlags: string[]; note: string };
  aid: {
    stickerPrice: number;
    cssProfile: boolean;
    methodology: string;
    meetsFullNeed: boolean;
    meritAid: string;
    meritAvailable: boolean;
    typicalMeritAward: number;
    generosity: {
      needBased: GenerosityRating;
      meritBased: GenerosityRating;
      incomeBandSpecific: GenerosityRating;
      byBand: { band: string; rating: number; note: string }[];
    };
    gotcha: string;
    netPriceCalculator: string;
    source: string;
  };
};

type DemoHighSchool = {
  name: string;
  city: string;
  state: string;
  type: string;
  enrollment: number;
  graduatingClass: number;
  weightedScaleMax: string;
  unweightedScaleMax: string;
  classRankPolicy: "Reported" | "Decile only" | "Quintile only" | "Not reported";
  rankBands: { label: string; minWeightedGpa: number; percentile: number }[];
  apOffered: number;
  ibOffered: boolean;
  apCap?: string;
  medianSAT: number;
  medianACT: number;
  counselorLoad: string;
  matriculation: string[];
  notes: string[];
  source: string;
};

type DemoScholarship = {
  id: string;
  name: string;
  sponsor: string;
  url: string;
  amountLabel: string;
  amount: number;
  renewable: boolean;
  basis: "merit" | "need" | "both";
  scope: string;
  opensISO: string;
  deadlineISO: string;
  eligibility: string;
  criteria: {
    majors?: string[];
    states?: string[];
    activityKeywords?: string[];
    axis?: { label: string; min: number };
    minGpaWeighted?: number;
    gradYears?: string[];
    gender?: string[];
  };
};

type DemoCombinedProgram = {
  id: string;
  name: string;
  school: string;
  url: string;
  length: string;
  mcat: string;
  seatConditions: string;
  whyFit: string;
};

type DemoPocProgram = {
  id: string;
  name: string;
  host: string;
  url: string;
  description: string;
  deadline: string;
  eligibility: string;
  scheduling: string;
  interests: string[];
};

type DemoOpportunity = {
  id: string;
  name: string;
  org: string;
  grade: string;
  deadline: string;
  cost: string;
  axis: string;
  citation: { url?: string };
};

type DemoPolicyUpdate = {
  id: string;
  institution: string;
  category: "Testing" | "Financial aid" | "Admissions" | "Deadlines";
  headline: string;
  detail: string;
  impact: "high" | "medium" | "low";
  citation: { url?: string };
};

// ---- Load the fixtures -----------------------------------------------------

const demoDir = path.resolve(process.env.MERIDIES_DEMO_DIR ?? "../meridies-demo");
const load = async (file: string): Promise<Record<string, unknown>> =>
  (await import(pathToFileURL(path.join(demoDir, "lib", file)).href)) as Record<string, unknown>;

const collegeData = await load("collegeData.ts");
const highSchools = await load("highSchools.ts");
const scholarships = await load("scholarships.ts");
const moduleData = await load("moduleData.ts");
const llmTools = await load("llmTools.ts");
const mockData = await load("mockData.ts");

const COLLEGES = collegeData.COLLEGES as DemoCollege[];
const HIGH_SCHOOLS = highSchools.HIGH_SCHOOL_PROFILES as DemoHighSchool[];
const SCHOLARSHIPS = scholarships.SCHOLARSHIPS as DemoScholarship[];
const COMBINED = llmTools.COMBINED_PROGRAMS as DemoCombinedProgram[];
const POC = llmTools.POC_PROGRAMS as DemoPocProgram[];
const OPPORTUNITIES = moduleData.OPPORTUNITIES as DemoOpportunity[];
const POLICY = moduleData.POLICY_UPDATES as DemoPolicyUpdate[];
const ROSTER_FIRST_NAMES = (mockData.MOCK_STUDENTS as { name: string }[]).map(
  (s) => s.name.split(" ")[0],
);

/** The date this seed was cut. Month/day-only deadlines resolve to their next
 *  occurrence on or after it. */
const SEED_DATE = "2026-09-23";

// ---- SQL helpers -------------------------------------------------------------

type Sql = { raw: string };
const raw = (s: string): Sql => ({ raw: s });

function lit(v: string | number | boolean | null | undefined | Sql): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return v.raw;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number ${v}`);
    return String(v);
  }
  return `'${v.replace(/'/g, "''")}'`;
}
const textArr = (xs: string[]): Sql =>
  raw(xs.length ? `array[${xs.map((x) => lit(x)).join(", ")}]::text[]` : `'{}'::text[]`);
const jsonb = (v: unknown): Sql => raw(`${lit(JSON.stringify(v))}::jsonb`);
const collegeRef = (slug: string): Sql =>
  raw(`(select id from public.colleges where slug = ${lit(slug)})`);
const cents = (dollars: number): number => Math.round(dollars * 100);
const ratio = (pct: number): number => Math.round(pct * 100) / 10000; // 3.9 -> 0.039

type Values = Record<string, string | number | boolean | null | undefined | Sql>;

function insert(table: string, row: Values, conflict: string): string {
  const cols = Object.keys(row);
  return (
    `insert into public.${table} (${cols.join(", ")})\nvalues (${cols
      .map((c) => lit(row[c]))
      .join(", ")})\non conflict ${conflict} do nothing;`
  );
}

function insertIfAbsent(table: string, row: Values, where: string): string {
  const cols = Object.keys(row);
  return (
    `insert into public.${table} (${cols.join(", ")})\nselect ${cols
      .map((c) => lit(row[c]))
      .join(", ")}\nwhere not exists (select 1 from public.${table} where ${where});`
  );
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`No mapping for ${what}; add one rather than guessing`);
  return value;
}

/** "Feb 6" -> the next Feb 6 on or after SEED_DATE. Null for "Rolling..." */
function nextOccurrence(text: string): string | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[1]);
  if (month < 0) return null;
  const seed = new Date(`${SEED_DATE}T00:00:00Z`);
  let year = seed.getUTCFullYear();
  const at = (y: number) => new Date(Date.UTC(y, month, Number(m[2])));
  if (at(year) < seed) year += 1;
  return at(year).toISOString().slice(0, 10);
}

function assertNoRosterNames(text: string | null, where: string): void {
  if (!text) return;
  for (const first of ROSTER_FIRST_NAMES) {
    if (new RegExp(`\\b${first}\\b`).test(text)) {
      throw new Error(`${where} still names demo student "${first}": ${text}`);
    }
  }
}

// ---- Vocabulary maps (fixture wording -> schema CHECK values) -----------------

const CONTROL: Record<DemoCollege["control"], string> = {
  Public: "public",
  "Private nonprofit": "private",
};

function testPolicy(s: string): string {
  if (/^Test required/i.test(s)) return "required";
  if (/^Test optional/i.test(s)) return "optional";
  if (/^Test blind/i.test(s)) return "blind";
  throw new Error(`Unmapped test policy "${s}"`);
}

const ADMIT_MODEL: Record<string, string> = {
  "Direct admit by major": "direct-admit",
  "Direct admit to college": "direct-admit",
  "Pre-major, secondary admission": "secondary-admission",
  "Open — declare after enrolling": "open",
};

const DURABILITY: Record<string, string> = {
  Growing: "growing",
  Stable: "stable",
  "Under review": "under-review",
  "Being cut": "being-cut",
};

/** CDS C7 weights. "Required"/"Recommended" are not CDS answers, so they map
 *  to nothing and the factor row is skipped rather than coerced. */
const CDS_WEIGHT: Record<string, string | undefined> = {
  "Very important": "very-important",
  Important: "important",
  Considered: "considered",
  "Not considered": "not-considered",
};

const AID_METHOD: Record<string, string> = {
  "Federal methodology — FAFSA only": "fafsa-only",
  "Institutional methodology — CSS Profile": "institutional",
};

const BAND: Record<string, string> = {
  "Under $60k": "under-60k",
  "$60–110k": "60-110k",
  "$110–150k": "110-150k",
  "$150–200k": "150-200k",
  "$200–250k": "200-250k",
  "$250k+": "250k-plus",
};

const HS_TYPE: Record<string, string> = {
  Public: "public",
  Independent: "independent",
  Parochial: "parochial",
  Charter: "charter",
};

const RANKING_PRACTICE: Record<DemoHighSchool["classRankPolicy"], string> = {
  Reported: "exact",
  "Decile only": "decile",
  "Quintile only": "quintile",
  "Not reported": "none",
};

/** "Common Data Set 2024–25, ..." -> 2024. */
function cdsYear(source: string): number | null {
  const m = /Common Data Set (\d{4})/.exec(source);
  return m ? Number(m[1]) : null;
}

// ---- Colleges and everything hanging off them -------------------------------

function collegeSql(c: DemoCollege): string[] {
  const out: string[] = [`-- ${c.name}`];
  const ref = collegeRef(c.id);

  out.push(
    insert(
      "colleges",
      {
        slug: c.id,
        name: c.name,
        initials: c.initials,
        brand_color: c.color,
        city: c.city,
        state: c.state,
        country: "US",
        control: CONTROL[c.control],
        size: c.undergradEnrollment,
        acceptance_rate: ratio(c.acceptanceRate),
        test_policy: testPolicy(c.testPolicy),
        deadlines: jsonb(Object.fromEntries(c.decisionPlans.map((p) => [p.plan, p.deadline]))),
        website: c.website,
      },
      "(slug)",
    ),
  );

  const rankWeight = CDS_WEIGHT[c.classRank.cdsPosition];
  const intelCdsYear = cdsYear(c.testingRigor.source);
  out.push(
    insert(
      "college_intel_profiles",
      {
        college_id: ref,
        class_rank_considered: rankWeight ?? null,
        class_rank_note: `${c.classRank.internalPractice} Source: ${c.classRank.source}.`,
        undergrad_enrollment: c.undergradEnrollment,
        graduate_enrollment: c.gradMix.gradEnrollment,
        cds_year: intelCdsYear,
        provenance: "sourced",
      },
      "(college_id)",
    ),
  );

  // CDS C7 rows: rigor of record, and class rank where it is a CDS answer.
  const rigorWeight = need(CDS_WEIGHT[c.testingRigor.rigorWeight], `rigor weight ${c.testingRigor.rigorWeight}`);
  if (intelCdsYear) {
    out.push(
      insert(
        "college_cds_factors",
        {
          college_id: ref,
          cds_year: intelCdsYear,
          factor: "rigor-of-record",
          weight: rigorWeight,
          note: c.testingRigor.note.slice(0, 1000),
          provenance: "sourced",
        },
        "(college_id, cds_year, factor)",
      ),
    );
  }
  const rankYear = cdsYear(c.classRank.source);
  if (rankWeight && rankYear) {
    out.push(
      insert(
        "college_cds_factors",
        {
          college_id: ref,
          cds_year: rankYear,
          factor: "class-rank",
          weight: rankWeight,
          note: c.classRank.internalPractice.slice(0, 1000),
          provenance: "sourced",
        },
        "(college_id, cds_year, factor)",
      ),
    );
  }

  // Majors: departments, admit models, durability and program health are four
  // fixture lists about the same programs. Merge on the name without its
  // parenthetical so "Engineering (School of Engineering)" and "Engineering"
  // land on one row.
  type Major = Values & { name: string };
  const majors = new Map<string, Major>();
  const keyOf = (n: string) => n.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
  const major = (name: string): Major => {
    const k = keyOf(name);
    let m = majors.get(k);
    if (!m) {
      m = { college_id: ref, name, provenance: "curated" };
      majors.set(k, m);
    }
    return m;
  };
  for (const d of c.departments) {
    const m = major(d.major);
    m.faculty_count = d.facultyCount;
    m.majors_enrolled = d.undergradMajors;
    m.curator_note = d.note;
  }
  for (const a of c.admitModels) {
    const m = major(a.discipline);
    m.discipline = a.discipline;
    m.admission_model = need(ADMIT_MODEL[a.model], `admit model ${a.model}`);
    m.admission_model_note =
      a.model === "Direct admit to college" ? `Direct admit to the college, not the major. ${a.detail}` : a.detail;
  }
  for (const d of c.majorDurability) {
    const m = major(d.major);
    m.durability = need(DURABILITY[d.status], `durability ${d.status}`);
    m.durability_note = `${d.note} Source: ${d.source}.`;
  }
  for (const p of c.programHealth) {
    const m = major(p.program);
    m.majors_enrolled ??= p.majorsEnrolled;
    m.graduation_rate = ratio(p.completion4yr);
    m.graduation_rate_years = 4;
    // The fixture's funding trend is not the schema's health scale, so it is
    // carried as text and program_health stays null.
    m.funding_note = `Funding trend: ${p.fundingTrend}.`;
    m.program_health_note = `${p.verdict} Source: ${p.source}.`;
  }
  for (const m of majors.values()) {
    out.push(insert("college_majors", m, "(college_id, lower(name))"));
  }

  for (const subject of c.courseRigor.expected) {
    out.push(
      insertIfAbsent(
        "college_course_requirements",
        { college_id: ref, subject, kind: "expected", provenance: "curated" },
        `college_id = ${ref.raw} and college_major_id is null and subject = ${lit(subject)}`,
      ),
    );
  }
  for (const title of c.courseRigor.redFlags) {
    out.push(
      insertIfAbsent(
        "college_rigor_flags",
        { college_id: ref, title, detail: c.courseRigor.note, provenance: "curated" },
        `college_id = ${ref.raw} and title = ${lit(title)}`,
      ),
    );
  }

  const a = c.aid;
  out.push(
    insert(
      "college_aid_profiles",
      {
        college_id: ref,
        sticker_in_state_cents: cents(c.tuitionInState),
        sticker_out_state_cents: cents(c.tuitionOutOfState),
        cost_of_attendance_cents: cents(a.stickerPrice),
        avg_need_grant_cents: cents(c.avgNeedBasedAid),
        merit_aid_available: a.meritAvailable,
        avg_merit_award_cents: a.meritAvailable ? cents(a.typicalMeritAward) : null,
        css_profile_required: a.cssProfile,
        aid_methodology: need(AID_METHOD[a.methodology], `aid methodology ${a.methodology}`),
        meets_full_need: a.meetsFullNeed,
        npc_url: `https://${a.netPriceCalculator}`,
        citations: jsonb([{ label: a.source }]),
      },
      "(college_id)",
    ),
  );

  // The three curated generosity ratings. rating_kind is left to its pinned
  // default, 'meridies-curated'.
  const ratings: [string, GenerosityRating, Values][] = [
    ["need-based", a.generosity.needBased, { gotchas: textArr([a.gotcha]) }],
    ["merit-based", a.generosity.meritBased, { merit_reality: a.meritAid }],
    ["income-band-consistency", a.generosity.incomeBandSpecific, {}],
  ];
  for (const [kind, r, extra] of ratings) {
    out.push(
      insert(
        "college_aid_ratings",
        {
          college_id: ref,
          kind,
          rating: r.rating,
          rating_kind: "meridies-curated",
          label: r.label,
          rationale: r.rationale,
          ...extra,
          evidence: jsonb([{ label: a.source }]),
        },
        "(college_id, kind)",
      ),
    );
  }
  a.generosity.byBand.forEach((b, i) => {
    out.push(
      insert(
        "college_aid_band_ratings",
        {
          college_id: ref,
          band: need(BAND[b.band], `income band ${b.band}`),
          band_label: b.band,
          rating: b.rating,
          note: b.note,
          sort_order: i,
          rating_kind: "meridies-curated",
          provenance: "curated",
        },
        "(college_id, band)",
      ),
    );
  });

  return out;
}

// ---- High schools ------------------------------------------------------------

function highSchoolSql(h: DemoHighSchool): string[] {
  const out: string[] = [`-- ${h.name}`];
  const where = `lower(name) = lower(${lit(h.name)}) and state = ${lit(h.state)}`;
  const counselorLoad = /^(\d+)/.exec(h.counselorLoad.replace(/,/g, ""));
  // Westview says of itself that its bands are Meridies estimates from a GPA
  // histogram; Lincoln's are from its published profile.
  const bandsEstimated = h.notes.some((n) => /Meridies estimates/i.test(n));

  out.push(
    insertIfAbsent(
      "high_schools",
      {
        name: h.name,
        city: h.city,
        state: h.state,
        country: "US",
        type: need(HS_TYPE[h.type], `high school type ${h.type}`),
        enrollment: h.enrollment,
        graduating_class: h.graduatingClass,
        weighted_scale_max: Number(h.weightedScaleMax),
        unweighted_scale_max: Number(h.unweightedScaleMax),
        weights_gpa: Number(h.weightedScaleMax) > Number(h.unweightedScaleMax),
        reports_class_rank: h.classRankPolicy !== "Not reported",
        ranking_practice: RANKING_PRACTICE[h.classRankPolicy],
        rank_transparency: h.classRankPolicy === "Not reported" ? "not-ranked" : null,
        ap_courses_offered: h.apOffered,
        ib_program: h.ibOffered,
        ap_cap: h.apCap ?? null,
        median_sat: h.medianSAT,
        median_act: h.medianACT,
        students_per_counselor: counselorLoad ? Number(counselorLoad[1]) : null,
        matriculation: textArr(h.matriculation),
        profile_notes: textArr(h.notes),
        source_label: h.source,
        provenance: "sourced",
      },
      where,
    ),
  );

  h.rankBands.forEach((b, i) => {
    out.push(
      insert(
        "high_school_rank_bands",
        {
          high_school_id: raw(`(select id from public.high_schools where ${where} limit 1)`),
          label: b.label,
          min_weighted_gpa: b.minWeightedGpa,
          // The demo stores 99 for "Top 1%"; the API and app read `percentile`
          // as the N in "Top N%" (lib/classRank.ts, HighSchoolPanel). Flip it.
          percentile: 100 - b.percentile,
          sort_order: i,
          provenance: bandsEstimated ? "estimated" : "sourced",
        },
        "(high_school_id, lower(label))",
      ),
    );
  });
  return out;
}

// ---- Combined programs -------------------------------------------------------

function combinedSql(p: DemoCombinedProgram): string {
  const [school, partner] = p.school.split(" · ");
  const years = /^(\d+)/.exec(p.length);
  return insertIfAbsent(
    "combined_programs",
    {
      name: p.name,
      partner_institution: partner ?? null,
      track: /BA\/MD/.test(p.name) ? "ba-md" : "other",
      years: years ? Number(years[1]) : null,
      description: `${school} — ${p.whyFit}`,
      requirements: `Length: ${p.length}. MCAT: ${p.mcat}. Seat conditions: ${p.seatConditions}`,
      url: p.url,
      source_url: p.url,
    },
    `name = ${lit(p.name)}`,
  );
}

// ---- Scholarships ------------------------------------------------------------

function scholarshipSql(s: DemoScholarship): string {
  const c = s.criteria;
  const eligibility: Record<string, unknown> = { need_based: s.basis !== "merit" };
  if (c.majors) eligibility.majors = c.majors;
  if (c.states) eligibility.states = c.states;
  if (c.minGpaWeighted !== undefined) {
    eligibility.gpa_min = c.minGpaWeighted;
    eligibility.gpa_scale = "weighted";
  }
  // The demo writes grad years against its own calendar (class of 2026 = 12th
  // grade). A literal year would be wrong the day this is applied, so the
  // grade it stands for is stored instead.
  if (c.gradYears) eligibility.grade_levels = c.gradYears.map((y) => String(12 - (Number(y) - 2026)));
  if (c.activityKeywords) eligibility.activity_keywords = c.activityKeywords;
  if (c.axis) eligibility.axis_min = c.axis;
  if (c.gender) eligibility.gender = c.gender;

  return insertIfAbsent(
    "scholarships",
    {
      name: s.name,
      sponsor: s.sponsor,
      description: s.eligibility,
      url: s.url,
      amount_cents: cents(s.amount),
      amount_note: s.amountLabel,
      renewable: s.renewable,
      opens_at: s.opensISO,
      deadline: s.deadlineISO,
      eligibility: jsonb(eligibility),
      tags: textArr([s.basis, s.scope.toLowerCase()]),
      source_url: s.url,
    },
    `name = ${lit(s.name)} and sponsor is not distinct from ${lit(s.sponsor)}`,
  );
}

// ---- Opportunities -----------------------------------------------------------

type OppExtra = {
  category: string;
  format: string | null;
  isFree: boolean | null;
  financialAid: boolean | null;
  gradeLevels: string[];
  eligibility: Record<string, unknown>;
};

/**
 * What the POC fixture says in prose, as columns. Every value here is read off
 * that entry's `eligibility` / `scheduling` / `description` text; nothing the
 * text does not state is filled.
 *
 * Two POC entries are deliberately absent: "AP Intensive + Diagnostic Testing
 * Block" (Carnegie Mellon Pre-College) and "Local Nonprofit Board Fellowship"
 * (United Way) are not programs those hosts run under those names — they are
 * demo scaffolding, and the concierge's own rule is that a program nobody can
 * sign up for is left out.
 */
const POC_EXTRA: Record<string, OppExtra | null> = {
  ssrp: {
    category: "research", format: "in-person", isFree: null, financialAid: null,
    gradeLevels: ["11"], eligibility: { age_min: 16 },
  },
  clark: {
    category: "research", format: "in-person", isFree: null, financialAid: null,
    gradeLevels: [], eligibility: { age_min: 17 },
  },
  "nslc-med": {
    category: "summer-program", format: null, isFree: false, financialAid: true,
    gradeLevels: ["9", "10", "11", "12"], eligibility: {},
  },
  tasp: {
    category: "summer-program", format: "in-person", isFree: true, financialAid: null,
    gradeLevels: ["11"], eligibility: {},
  },
  "nsli-y": {
    category: "summer-program", format: "in-person", isFree: true, financialAid: null,
    gradeLevels: [], eligibility: { age_min: 15, age_max: 18, citizenship: ["US"], gpa_min: 2.5 },
  },
  "cmu-ap": null,
  "coca-cola-scholars": null,
  regeneron: {
    category: "competition", format: null, isFree: null, financialAid: null,
    gradeLevels: ["12"], eligibility: { prerequisites: "Original independent research" },
  },
};

function pocSql(p: DemoPocProgram): string | null {
  const extra = need(POC_EXTRA[p.id], `POC program ${p.id}`);
  if (extra === null) return null;
  return insertIfAbsent(
    "opportunities",
    {
      name: p.name,
      org: p.host,
      description: p.description,
      url: p.url,
      category: extra.category,
      format: extra.format,
      is_free: extra.isFree,
      financial_aid: extra.financialAid,
      grade_levels: textArr(extra.gradeLevels),
      subject_tags: textArr(p.interests.map((i) => i.toLowerCase())),
      eligibility: jsonb({
        ...extra.eligibility,
        summary: p.eligibility,
        scheduling: p.scheduling,
        deadline_note: p.deadline,
      }),
      deadline: nextOccurrence(p.deadline),
      source_url: p.url,
    },
    `name = ${lit(p.name)} and org is not distinct from ${lit(p.host)}`,
  );
}

/** The one concierge-fixture program not already in POC_PROGRAMS that is a
 *  real, generic listing. Its `why` copy is about a demo student and is not
 *  carried. */
function rsiSql(): string {
  const o = need(OPPORTUNITIES.find((x) => x.id === "op1"), "RSI opportunity op1");
  const url = o.citation.url ? `https://${o.citation.url}` : null;
  return insertIfAbsent(
    "opportunities",
    {
      name: o.name,
      org: o.org,
      url,
      category: "summer-program",
      is_free: o.cost === "Free",
      grade_levels: textArr(o.grade === "11th" ? ["11"] : []),
      subject_tags: textArr([o.axis.toLowerCase()]),
      eligibility: jsonb({ deadline_note: o.deadline }),
      deadline: nextOccurrence(o.deadline),
      source_url: url,
    },
    `name = ${lit(o.name)} and org is not distinct from ${lit(o.org)}`,
  );
}

// ---- Policy updates -----------------------------------------------------------

const POLICY_CATEGORY: Record<DemoPolicyUpdate["category"], string> = {
  Testing: "testing",
  "Financial aid": "financial-aid",
  Admissions: "admissions",
  Deadlines: "deadline",
};
const POLICY_SEVERITY: Record<DemoPolicyUpdate["impact"], string> = {
  high: "high",
  medium: "normal",
  low: "low",
};

function policySql(p: DemoPolicyUpdate): string {
  // The fixture's detail is written to one practice ("...for Evan's aid
  // needs"). Keep only the institutional claim: the first sentence, cut before
  // the dash that turns it toward a student.
  const first = (/^[^.]*\./.exec(p.detail)?.[0] ?? p.detail).split(" — ")[0].trim();
  const summary = first.endsWith(".") ? first : `${first}.`;
  assertNoRosterNames(summary, `policy update ${p.id}`);
  assertNoRosterNames(p.headline, `policy update ${p.id}`);

  const college = COLLEGES.find(
    (c) =>
      c.name.toLowerCase() === p.institution.toLowerCase() ||
      (c.aka ?? []).some((a) => a.toLowerCase() === p.institution.toLowerCase()),
  );
  return insertIfAbsent(
    "policy_updates",
    {
      college_id: college ? collegeRef(college.id) : null,
      institution: p.institution,
      title: p.headline,
      summary,
      category: POLICY_CATEGORY[p.category],
      severity: POLICY_SEVERITY[p.impact],
      source_url: p.citation.url ? `https://${p.citation.url}` : null,
    },
    `title = ${lit(p.headline)} and institution is not distinct from ${lit(p.institution)}`,
  );
}

// ---- v10: profile facts, Build College Lists, CDS, programs ------------------
//
//   npx tsx scripts/seed/generate-catalog.ts --v10 \
//     > supabase/migrations/20261005040004_seed_college_v10.sql
//
// Same rules as the catalog seed. The new tables are keyed on college_id, so
// ON CONFLICT DO NOTHING keeps a hand-corrected row; `colleges.aka` is set
// only where it is still empty. Left out on purpose:
//   * the CDS "last checked" date — the demo's is set after its own fictional
//     "today", and a check date is a claim that someone checked;
//   * the webinar tips — the demo writes them from a template, they are not
//     real sessions (college_webinar_tips starts empty);
//   * the Events Hub listings — authored against the demo's "today".

type DemoCollegeV10 = DemoCollege & {
  address: string;
  founded: number;
  setting: string;
  overview: string;
  studentFacultyRatio: string;
  graduationRate4yr: number;
  graduationRate6yr: number;
  retentionRate: number;
  roomAndBoard: number;
  netPriceByIncome: { band: string; price: number }[];
  satRange: string;
  actRange: string;
  gpaRange: string;
  commonApp: boolean;
  popularMajors: string[];
  admittedProfile: { label: string; value: number }[];
  studentLife: {
    undergrads: number;
    totalStudents: number;
    fullTimeUndergradPct: number;
    retentionPct: number;
    gender: { femalePct: number; malePct: number };
    ethnicity: { group: string; pct: number }[];
    source: string;
  };
  admissionRequirements: {
    essay: string;
    testing: string;
    subjectTests: string;
    interview: string;
    note: string;
  };
};

type DemoListSchool = {
  id: string;
  name: string;
  initials: string;
  color: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  undergrads: number;
  setting: string;
  testing: string;
  admit: number;
  satMid: number;
  gpaMid: number;
  need: number;
  largestGroup: number;
  fields: string[];
  rd: string;
  website: string;
  collegeId?: string;
};

const LIST_TESTING: Record<string, string> = {
  "Test required": "required",
  "Test optional": "optional",
  "Test blind": "blind",
  "Test flexible": "flexible",
};

function v10CollegeSql(c: DemoCollegeV10, extras: Record<string, unknown>): string[] {
  const ref = collegeRef(c.id);
  const out: string[] = [`-- ${c.name}`];

  if (c.aka?.length) {
    out.push(
      `update public.colleges set aka = ${textArr(c.aka).raw}\nwhere slug = ${lit(c.id)} and aka = '{}'::text[];`,
    );
  }

  assertNoRosterNames(c.overview, `${c.name} overview`);
  out.push(
    insert(
      "college_profile_facts",
      {
        college_id: ref,
        address: c.address,
        founded: c.founded,
        campus_setting: c.setting,
        overview: c.overview,
        student_faculty_ratio: c.studentFacultyRatio,
        graduation_rate_4yr: c.graduationRate4yr,
        graduation_rate_6yr: c.graduationRate6yr,
        retention_rate: c.retentionRate,
        room_and_board_cents: cents(c.roomAndBoard),
        sat_range: c.satRange,
        act_range: c.actRange,
        gpa_range: c.gpaRange,
        common_app: c.commonApp,
        popular_majors: textArr(c.popularMajors),
        student_life: jsonb(c.studentLife),
        admission_requirements: jsonb(c.admissionRequirements),
        net_price_by_income: jsonb(c.netPriceByIncome.map((r) => ({ band: r.band, priceCents: cents(r.price) }))),
        source_note: DATA_SOURCE_NOTE,
        provenance: "sourced",
      },
      "(college_id)",
    ),
  );

  out.push(
    insert(
      "college_admitted_profiles",
      {
        college_id: ref,
        axes: jsonb(c.admittedProfile),
        rating_kind: "meridies-curated",
        note: ADMITTED_POLYGON_NOTE,
      },
      "(college_id)",
    ),
  );

  const cdsFor = extras.cdsFor as (id: string, website: string, name: string) => {
    url: string;
    year: string;
    released: string;
  };
  const cds = cdsFor(c.id, c.website, c.name);
  // The fallback is a search link the UI can build itself, not a fact.
  if (cds.url.startsWith("https://") && !cds.url.includes("google.com/search")) {
    out.push(
      insert(
        "college_cds_editions",
        {
          college_id: ref,
          edition: cds.year,
          url: cds.url,
          released_label: cds.released,
          provenance: "sourced",
        },
        "(college_id, edition)",
      ),
    );
  }

  const programsFor = extras.programsFor as (id: string) => { combined: string[]; special: string[] } | null;
  const programs = programsFor(c.id);
  if (programs) {
    for (const kind of ["combined", "special"] as const) {
      programs[kind].forEach((name, i) => {
        out.push(
          insert(
            "college_programs",
            { college_id: ref, kind, name, sort_order: i, provenance: "curated" },
            "(college_id, kind, lower(name))",
          ),
        );
      });
    }
  }
  return out;
}

/** The filter and fit inputs, for a profiled school or a catalog one. */
function listProfileSql(s: DemoListSchool): string {
  return insert(
    "college_list_profiles",
    {
      college_id: collegeRef(s.collegeId ?? s.id),
      latitude: s.lat,
      longitude: s.lng,
      campus_setting: s.setting,
      field_areas: textArr(s.fields),
      sat_mid: Math.round(s.satMid),
      gpa_mid: Math.round(s.gpaMid * 100) / 100,
      largest_group_pct: s.largestGroup,
      provenance: "estimated",
    },
    "(college_id)",
  );
}

/** A Northeast catalog school: only what the list builder reads. */
function catalogSchoolSql(s: DemoListSchool): string[] {
  return [
    `-- ${s.name}`,
    insert(
      "colleges",
      {
        slug: s.id,
        name: s.name,
        initials: s.initials,
        brand_color: s.color,
        city: s.city,
        state: s.state,
        country: "US",
        size: s.undergrads,
        acceptance_rate: ratio(s.admit),
        test_policy: need(LIST_TESTING[s.testing], `testing ${s.testing}`),
        deadlines: jsonb(s.rd ? { "Regular Decision": s.rd } : {}),
        website: s.website,
      },
      "(slug)",
    ),
    // The Meridies need-based rating the Financial aid filter reads. Curated,
    // with no label or rationale because the fixture states none.
    insert(
      "college_aid_ratings",
      { college_id: collegeRef(s.id), kind: "need-based", rating: s.need, rating_kind: "meridies-curated" },
      "(college_id, kind)",
    ),
  ];
}

async function v10Sql(): Promise<[string, string[]][]> {
  const extras = await load("collegeExtras.ts");
  const listBuilder = await load("listBuilder.ts");
  const schools = listBuilder.LIST_SCHOOLS as DemoListSchool[];
  const profiled = COLLEGES as DemoCollegeV10[];
  return [
    ["Profile facts, the curated admitted-student shape, CDS editions and programs", profiled.flatMap((c) => v10CollegeSql(c, extras))],
    ["Build College Lists catalog schools (no profile)", schools.filter((s) => !s.collegeId).flatMap(catalogSchoolSql)],
    ["Build College Lists filter and fit inputs (estimated)", schools.map(listProfileSql)],
  ];
}

const DATA_SOURCE_NOTE = collegeData.DATA_SOURCE_NOTE as string;
const ADMITTED_POLYGON_NOTE = collegeData.ADMITTED_POLYGON_NOTE as string;

// ---- Emit ----------------------------------------------------------------------

// A function so that `--v10` runs without the fixtures the original catalog
// read (the demo dropped COMBINED_PROGRAMS and POC_PROGRAMS from llmTools.ts in
// v8; the 20260923 seed was cut before that).
const sections = (): [string, string[]][] => [
  ["Colleges, majors, CDS factors, requirements, aid profiles and the curated aid ratings", COLLEGES.flatMap(collegeSql)],
  ["High schools and their published rank bands", HIGH_SCHOOLS.flatMap(highSchoolSql)],
  ["Combined BA/MD and BS/MD programs", COMBINED.map(combinedSql)],
  ["Scholarships", SCHOLARSHIPS.map(scholarshipSql)],
  [
    "Opportunities (the concierge catalog)",
    [...POC.map(pocSql).filter((s): s is string => s !== null), rsiSql()],
  ],
  ["Policy updates", POLICY.map(policySql)],
];

const header = `-- ---------------------------------------------------------------------------
-- Catalog seed. GENERATED by scripts/seed/generate-catalog.ts from the
-- meridies-demo fixtures — edit the script, not this file, and regenerate.
--
-- Idempotent: every row is keyed on a natural key (ON CONFLICT DO NOTHING) or
-- guarded by WHERE NOT EXISTS, so applying it twice changes nothing. It never
-- updates a row that already exists, so a catalog row corrected by hand is not
-- overwritten by a re-run.
--
-- What is deliberately NOT here:
--   * scattergram_points — the demo's outcome cloud is PRNG output, not
--     reported decisions. Seeding it would put invented admits in production.
--   * college_admission_stats / college_major_admit_stats — cohort_year is
--     NOT NULL and the fixtures never say which cohort their ranges describe.
--   * Any value a fixture does not state. Those columns stay null, which is
--     what lets GET /high-schools/:id/rank return an unavailableReason.
--
-- Curated Meridies judgements are labelled as such: college_aid_ratings and
-- college_aid_band_ratings carry rating_kind = 'meridies-curated'; majors,
-- course requirements, rigor flags and band ratings carry provenance =
-- 'curated'. Nothing curated is written as provenance = 'sourced'.
--
-- source_verified_at is left null everywhere: nobody has re-verified these
-- fixtures against their sources for this seed, and a verification timestamp
-- is a claim that someone did.
-- ---------------------------------------------------------------------------
`;

const V10 = process.argv.includes("--v10");

const v10Header = `-- ---------------------------------------------------------------------------
-- Colleges v10 seed. GENERATED by scripts/seed/generate-catalog.ts --v10 from
-- the meridies-demo fixtures (collegeData.ts, collegeExtras.ts,
-- listBuilder.ts) — edit the script, not this file, and regenerate.
--
-- Idempotent and never overwrites: new rows are ON CONFLICT DO NOTHING, and
-- colleges.aka is written only where it is still empty.
--
-- Labelled as what it is: college_admitted_profiles and the catalog schools'
-- need-based college_aid_ratings are 'meridies-curated'; college_programs is
-- provenance 'curated'; college_list_profiles (coordinates, fields taught,
-- rounded score midpoints) is 'estimated' and never displayed as a published
-- figure. source_verified_at is null everywhere.
--
-- NOT here: CDS check dates, webinar tips and Events Hub listings. The demo
-- authors those against its own fictional "today".
-- ---------------------------------------------------------------------------
`;

const chosen = V10 ? await v10Sql() : sections();

const body = chosen
  .map(([title, stmts]) => `-- ===========================================================================\n-- ${title}\n-- ===========================================================================\n\n${stmts.join("\n\n")}`)
  .join("\n\n");

process.stdout.write(`${V10 ? v10Header : header}\n${body}\n`);
