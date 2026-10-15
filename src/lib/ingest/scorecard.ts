/**
 * College Scorecard ingest: every operating US college that mainly awards
 * associate's, bachelor's or graduate degrees, from the U.S. Department of
 * Education's API (https://collegescorecard.ed.gov/data/api/).
 *
 * One page (100 schools, only the fields below) at a time, upserted on the
 * IPEDS unitid. The rules:
 *   - A row Meridies curated (colleges.catalog_source = 'meridies') keeps its
 *     name, slug, aliases, colours, deadlines and test policy. Official data
 *     only fills facts: city, state, zip, control, size, admit rate, website.
 *   - Curated ratings, profile copy and admitted profiles live in other
 *     tables and are never touched.
 *   - Everything written is provenance 'sourced', with the Scorecard URL and
 *     this run's time as source_verified_at.
 *   - Each run is one ingest_runs row; a page that fails is recorded and the
 *     run carries on, ending 'partial'.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Raw = Record<string, unknown>;
type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export const SCORECARD_API = "https://api.data.gov/ed/collegescorecard/v1/schools.json";
export const SCORECARD_SOURCE_URL = "https://collegescorecard.ed.gov/data/";
const PER_PAGE = 100;
/** Scorecard publishes "latest" as its most recent release; label it as such. */
export const SCORECARD_DATA_YEAR = "Scorecard latest";

const PROGRAM = "latest.programs.cip_4_digit";
/** The fields every run has asked for since the catalog was first loaded. */
export const BASE_FIELDS = [
  "id", "ope8_id",
  "school.name", "school.alias", "school.city", "school.state", "school.zip", "school.school_url",
  "school.ownership", "school.locale", "school.carnegie_size_setting", "school.religious_affiliation",
  "school.women_only", "school.men_only", "school.online_only", "school.open_admissions_policy",
  "school.price_calculator_url", "school.degrees_awarded.predominant",
  "school.minority_serving.historically_black", "school.minority_serving.hispanic", "school.minority_serving.tribal",
  "location.lat", "location.lon",
  "latest.admissions.admission_rate.overall", "latest.admissions.test_requirements",
  "latest.admissions.sat_scores.25th_percentile.critical_reading", "latest.admissions.sat_scores.75th_percentile.critical_reading",
  "latest.admissions.sat_scores.25th_percentile.math", "latest.admissions.sat_scores.75th_percentile.math",
  "latest.admissions.act_scores.25th_percentile.cumulative", "latest.admissions.act_scores.75th_percentile.cumulative",
  "latest.student.size",
  "latest.cost.attendance.academic_year", "latest.cost.tuition.in_state", "latest.cost.tuition.out_of_state",
  "latest.cost.avg_net_price.overall",
  ...["0-30000", "30001-48000", "48001-75000", "75001-110000", "110001-plus"].flatMap((b) => [
    `latest.cost.net_price.public.by_income_level.${b}`,
    `latest.cost.net_price.private.by_income_level.${b}`,
  ]),
  "latest.aid.pell_grant_rate", "latest.aid.federal_loan_rate", "latest.aid.median_debt.completers.overall",
  // The graduation rate Scorecard's own site sorts and filters by. The site
  // displays Outcome Measures (an award within 8 years, all entering students)
  // where reported, else the first-time full-time rate at 150% of normal time;
  // that consumer_rate is that blend is inferred (see the field reference).
  // Never a "6-year" rate: grad_rate_150 is the timed one.
  "latest.completion.consumer_rate", "latest.earnings.10_yrs_after_entry.median",
  `${PROGRAM}.code`, `${PROGRAM}.title`, `${PROGRAM}.credential.level`, `${PROGRAM}.counts.ipeds_awards2`,
  `${PROGRAM}.earnings.4_yr.overall_median_earnings`, `${PROGRAM}.debt.staff_grad_plus.all.eval_inst.median`,
];

/** Race/ethnicity keys, as Scorecard names them under student.demographics.race_ethnicity. */
export const RACE_KEYS = ["white", "black", "hispanic", "asian", "aian", "nhpi", "two_or_more", "non_resident_alien", "unknown"] as const;
export type RaceKey = (typeof RACE_KEYS)[number];
/** The completion fields spell three of the keys differently. */
const COMPLETION_RACE_SUFFIX: Record<RaceKey, string> = {
  white: "white",
  black: "black",
  hispanic: "hispanic",
  asian: "asian",
  aian: "aian",
  nhpi: "nhpi",
  two_or_more: "2ormore",
  non_resident_alien: "nonresident.alien",
  unknown: "race.unknown",
};

const COMPLETION = "latest.completion";
const RETENTION = "latest.student.retention_rate_suppressed";
const DEMOGRAPHICS = "latest.student.demographics";

/**
 * Added later, in groups. Every name is checked against the Scorecard data
 * dictionary or the field list of Scorecard's own site
 * (test/fixtures/scorecard-field-reference.json says which, with the
 * dictionary's variable name). The API refuses a whole request that names a
 * field it doesn't know, so when a run is refused the fetcher finds out which
 * groups are at fault and carries on without them (scorecardFetcher).
 */
export const EXTENDED_FIELD_GROUPS = {
  // IPEDS Graduation Rates, first-time full-time: four-year institutions
  // (C100_4, C150_4) or less-than-four-year ones (C100_L4, C150_L4).
  completion: [
    `${COMPLETION}.completion_rate_4yr_100nt`,
    `${COMPLETION}.completion_rate_4yr_150nt`,
    `${COMPLETION}.completion_rate_less_than_4yr_100nt`,
    `${COMPLETION}.completion_rate_less_than_4yr_150nt`,
  ],
  completionByRace4yr: RACE_KEYS.map((k) => `${COMPLETION}.completion_rate_4yr_150_${COMPLETION_RACE_SUFFIX[k]}`),
  completionByRaceL4: RACE_KEYS.map((k) => `${COMPLETION}.completion_rate_l4yr_150_${COMPLETION_RACE_SUFFIX[k]}`),
  students: [
    `${RETENTION}.four_year.full_time_pooled`,
    `${RETENTION}.lt_four_year.full_time_pooled`,
    "latest.student.part_time_share",
    "latest.student.grad_students",
    `${DEMOGRAPHICS}.student_faculty_ratio`,
  ],
  demographics: [`${DEMOGRAPHICS}.women`, `${DEMOGRAPHICS}.men`, ...RACE_KEYS.map((k) => `${DEMOGRAPHICS}.race_ethnicity.${k}`)],
  cost: ["latest.cost.roomboard.oncampus", "latest.cost.booksupply"],
  outcomes: [
    "latest.earnings.6_yrs_after_entry.median",
    "latest.aid.median_debt.completers.monthly_payments",
    "latest.aid.median_debt.noncompleters",
  ],
  carnegie: ["school.carnegie_basic"],
} as const satisfies Record<string, readonly string[]>;

export const EXTENDED_FIELDS: string[] = Object.values(EXTENDED_FIELD_GROUPS).flat();
export const SCORECARD_FIELDS: string[] = [...BASE_FIELDS, ...EXTENDED_FIELDS];

/** The college_stats columns the extended fields fill (migration 20261023080001). */
export const EXTENDED_STAT_COLUMNS = [
  "completion_basis", "grad_rate_on_time", "grad_rate_150", "completion_by_race",
  "retention_rate", "part_time_share", "student_faculty_ratio", "grad_students", "demographics",
  "room_board_on_campus", "books_supplies",
  "median_earnings_6yr", "median_debt_monthly", "median_debt_noncompleters",
  "carnegie_basic",
] as const;

export const INCOME_BANDS = ["0-30000", "30001-48000", "48001-75000", "75001-110000", "110001-plus"] as const;

// ---- Mapping (pure; unit-tested) ------------------------------------------------

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const rate = (v: unknown): number | null => {
  const n = num(v);
  return n === null || n < 0 || n > 1 ? null : Math.round(n * 10000) / 10000;
};
const inRange = (v: unknown, lo: number, hi: number): number | null => {
  const n = int(v);
  return n === null || n < lo || n > hi ? null : n;
};
/** A count or dollar figure: rounded, and null when negative (the columns refuse it). */
const nonNegative = (v: unknown): number | null => {
  const n = int(v);
  return n === null || n < 0 ? null : n;
};
const text = (v: unknown, max = 300): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const flag = (v: unknown): boolean => v === 1 || v === true;

/** Named shares (0-1) from one record; anything that isn't a finite 0-1 number is left out. */
function shares(r: Raw, field: (key: RaceKey | "women" | "men") => string, keys: readonly (RaceKey | "women" | "men")[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = rate(r[field(k)]);
    if (v !== null) out[k] = v;
  }
  return out;
}

export type CompletionBasis = "four-year" | "less-than-four-year";

/**
 * The completion figures, all from one IPEDS cohort: a four-year institution
 * reports C100_4 / C150_4 (within 4 and 6 years for a bachelor's), a
 * less-than-four-year one C100_L4 / C150_L4 (100% and 150% of normal time for
 * its programs, e.g. 3 years for an associate's). The cohort with an overall
 * 150% rate wins, four-year first; the two are never mixed.
 */
export function completionOf(r: Raw): { basis: CompletionBasis | null; onTime: number | null; within150: number | null; byRace: Record<string, number> } {
  const cohort = (fourYear: boolean) => ({
    onTime: rate(r[`${COMPLETION}.completion_rate_${fourYear ? "4yr" : "less_than_4yr"}_100nt`]),
    within150: rate(r[`${COMPLETION}.completion_rate_${fourYear ? "4yr" : "less_than_4yr"}_150nt`]),
    byRace: shares(r, (k) => `${COMPLETION}.completion_rate_${fourYear ? "4yr" : "l4yr"}_150_${COMPLETION_RACE_SUFFIX[k as RaceKey]}`, RACE_KEYS),
  });
  const four = cohort(true);
  const l4 = cohort(false);
  const any = (c: typeof four) => c.onTime !== null || c.within150 !== null || Object.keys(c.byRace).length > 0;
  const pick =
    four.within150 !== null ? four : l4.within150 !== null ? l4 : any(four) ? four : any(l4) ? l4 : null;
  if (!pick) return { basis: null, onTime: null, within150: null, byRace: {} };
  return { basis: pick === four ? "four-year" : "less-than-four-year", ...pick };
}

export const CONTROL_BY_OWNERSHIP: Record<number, "public" | "private" | "private-for-profit"> = {
  1: "public",
  2: "private",
  3: "private-for-profit",
};

/** "www.harvard.edu/" -> "https://www.harvard.edu" */
export function normalizeUrl(v: unknown): string | null {
  const s = text(v, 500);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** A unique, readable slug: the name, then the state, then the unitid if both collide. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function initialsOf(name: string): string {
  const skip = new Set(["of", "the", "and", "at", "in", "for", "&"]);
  return name
    .split(/[\s\-–,]+/)
    .filter((w) => w && !skip.has(w.toLowerCase()))
    .slice(0, 4)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export type MappedSchool = {
  unitid: number;
  college: {
    name: string;
    aka: string[];
    city: string | null;
    state: string | null;
    zip: string | null;
    ope_id: string | null;
    control: "public" | "private" | "private-for-profit" | null;
    size: number | null;
    acceptance_rate: number | null;
    website: string | null;
  };
  stats: Record<string, unknown>;
  programs: {
    cip_code: string;
    title: string;
    credential_level: number;
    awards: number | null;
    earnings_4yr: number | null;
    median_debt: number | null;
  }[];
};

/** One Scorecard result -> the rows we keep. Null for a school we don't list (online-only, no name). */
export function mapScorecardSchool(r: Raw): MappedSchool | null {
  const unitid = int(r.id);
  const name = text(r["school.name"], 200);
  if (!unitid || !name) return null;
  if (flag(r["school.online_only"])) return null;

  const ownership = int(r["school.ownership"]);
  const control = ownership ? CONTROL_BY_OWNERSHIP[ownership] ?? null : null;
  const netPrice: Record<string, number> = {};
  for (const band of INCOME_BANDS) {
    const v =
      int(r[`latest.cost.net_price.public.by_income_level.${band}`]) ??
      int(r[`latest.cost.net_price.private.by_income_level.${band}`]);
    if (v !== null) netPrice[band] = v;
  }
  const aliases = (text(r["school.alias"], 500) ?? "")
    .split(/[,|;]/)
    .map((a) => a.trim())
    .filter((a) => a && a.length <= 120 && a.toLowerCase() !== name.toLowerCase())
    .slice(0, 8);

  const programs: MappedSchool["programs"] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(r[PROGRAM]) ? (r[PROGRAM] as Raw[]) : []) {
    const code = text(p.code, 10);
    const title = text(p.title, 300)?.replace(/\.$/, "");
    const level = int((p.credential as Raw | undefined)?.level);
    if (!code || !/^\d{4}$/.test(code) || !title || !level || level < 1 || level > 8) continue;
    const key = `${code}:${level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const earnings = (((p.earnings as Raw | undefined)?.["4_yr"] as Raw | undefined) ?? {}).overall_median_earnings;
    const debt = ((((p.debt as Raw | undefined)?.staff_grad_plus as Raw | undefined)?.all as Raw | undefined)?.eval_inst as Raw | undefined)?.median;
    programs.push({
      cip_code: code,
      title,
      credential_level: level,
      awards: int((p.counts as Raw | undefined)?.ipeds_awards2),
      earnings_4yr: int(earnings),
      median_debt: int(debt),
    });
  }

  const completion = completionOf(r);
  const admit = rate(r["latest.admissions.admission_rate.overall"]);
  const size = int(r["latest.student.size"]);
  const opeRaw = text(r.ope8_id, 10);
  return {
    unitid,
    college: {
      name,
      aka: aliases,
      city: text(r["school.city"], 120),
      state: text(r["school.state"], 2),
      zip: text(r["school.zip"], 10),
      ope_id: opeRaw && /^\d{6,8}$/.test(opeRaw) ? opeRaw : null,
      control,
      size: size !== null && size >= 0 ? size : null,
      acceptance_rate: admit,
      website: normalizeUrl(r["school.school_url"]),
    },
    stats: {
      unitid,
      admit_rate: admit,
      open_admissions: int(r["school.open_admissions_policy"]) === 1 ? true : int(r["school.open_admissions_policy"]) === 2 ? false : null,
      test_requirements: inRange(r["latest.admissions.test_requirements"], 1, 5),
      sat_ebrw_25: inRange(r["latest.admissions.sat_scores.25th_percentile.critical_reading"], 200, 800),
      sat_ebrw_75: inRange(r["latest.admissions.sat_scores.75th_percentile.critical_reading"], 200, 800),
      sat_math_25: inRange(r["latest.admissions.sat_scores.25th_percentile.math"], 200, 800),
      sat_math_75: inRange(r["latest.admissions.sat_scores.75th_percentile.math"], 200, 800),
      act_25: inRange(r["latest.admissions.act_scores.25th_percentile.cumulative"], 1, 36),
      act_75: inRange(r["latest.admissions.act_scores.75th_percentile.cumulative"], 1, 36),
      undergrad_enrollment: size !== null && size >= 0 ? size : null,
      control,
      predominant_degree: inRange(r["school.degrees_awarded.predominant"], 0, 4),
      locale: int(r["school.locale"]),
      carnegie_size_setting: int(r["school.carnegie_size_setting"]),
      religious_affiliation: int(r["school.religious_affiliation"]),
      hbcu: flag(r["school.minority_serving.historically_black"]),
      hsi: flag(r["school.minority_serving.hispanic"]),
      tribal: flag(r["school.minority_serving.tribal"]),
      women_only: flag(r["school.women_only"]),
      men_only: flag(r["school.men_only"]),
      latitude: num(r["location.lat"]),
      longitude: num(r["location.lon"]),
      cost_of_attendance: int(r["latest.cost.attendance.academic_year"]),
      tuition_in_state: int(r["latest.cost.tuition.in_state"]),
      tuition_out_of_state: int(r["latest.cost.tuition.out_of_state"]),
      avg_net_price: int(r["latest.cost.avg_net_price.overall"]),
      net_price_by_income: netPrice,
      price_calculator_url: normalizeUrl(r["school.price_calculator_url"]),
      pell_rate: rate(r["latest.aid.pell_grant_rate"]),
      federal_loan_rate: rate(r["latest.aid.federal_loan_rate"]),
      median_debt: int(r["latest.aid.median_debt.completers.overall"]),
      grad_rate: rate(r["latest.completion.consumer_rate"]),
      median_earnings_10yr: int(r["latest.earnings.10_yrs_after_entry.median"]),
      // Extended fields (EXTENDED_STAT_COLUMNS; migration 20261023080001).
      completion_basis: completion.basis,
      grad_rate_on_time: completion.onTime,
      grad_rate_150: completion.within150,
      completion_by_race: completion.byRace,
      retention_rate:
        rate(r[`${RETENTION}.four_year.full_time_pooled`]) ?? rate(r[`${RETENTION}.lt_four_year.full_time_pooled`]),
      part_time_share: rate(r["latest.student.part_time_share"]),
      student_faculty_ratio: inRange(r[`${DEMOGRAPHICS}.student_faculty_ratio`], 1, 200),
      grad_students: nonNegative(r["latest.student.grad_students"]),
      demographics: shares(
        r,
        (k) => (k === "women" || k === "men" ? `${DEMOGRAPHICS}.${k}` : `${DEMOGRAPHICS}.race_ethnicity.${k}`),
        ["women", "men", ...RACE_KEYS]
      ),
      room_board_on_campus: nonNegative(r["latest.cost.roomboard.oncampus"]),
      books_supplies: nonNegative(r["latest.cost.booksupply"]),
      median_earnings_6yr: nonNegative(r["latest.earnings.6_yrs_after_entry.median"]),
      median_debt_monthly: nonNegative(r["latest.aid.median_debt.completers.monthly_payments"]),
      median_debt_noncompleters: nonNegative(r["latest.aid.median_debt.noncompleters"]),
      // -2 not applicable and 0 not classified carry no class: null.
      carnegie_basic: inRange(r["school.carnegie_basic"], 1, 99),
    },
    programs,
  };
}

// ---- Fetching ---------------------------------------------------------------------

export type FetchPage = (page: number) => Promise<{ total: number; results: Raw[] }>;
/** A FetchPage that may have left out extended field groups Scorecard refused. */
export type ScorecardFetchPage = FetchPage & { refusedGroups: () => string[] };

/** A refused request. The message names the status and page only, never the body (it can echo the key). */
export class ScorecardHttpError extends Error {
  constructor(
    readonly status: number,
    page: number
  ) {
    super(`Scorecard returned ${status} for page ${page}`);
    this.name = "ScorecardHttpError";
  }
}

/**
 * A real fetch against the API, with backoff on 429 and 5xx.
 *
 * The API answers 400 to a request that names any field it doesn't know, so a
 * renamed or retired extended field would otherwise stop the whole load. On
 * the first 400, the fetcher asks once for the base fields alone (a 400 there
 * is a genuine failure and is thrown as before), then for the base fields plus
 * each extended group in turn (one school each), keeps the groups that pass and
 * re-asks for the page. `refusedGroups()` names what was left out, so the run
 * records it and its heartbeat is not counted clean.
 */
export function scorecardFetcher(
  apiKey: string,
  opts: { baseUrl?: string; sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch } = {}
): ScorecardFetchPage {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const doFetch = opts.fetchImpl ?? fetch;
  let fields: string[] = SCORECARD_FIELDS;
  let probed = false;
  const refused: string[] = [];

  const get = async (page: number, list: readonly string[], perPage = PER_PAGE) => {
    const url = new URL(opts.baseUrl ?? SCORECARD_API);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("school.operating", "1");
    url.searchParams.set("school.degrees_awarded.predominant", "2,3,4");
    url.searchParams.set("fields", list.join(","));
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "id");
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        const body = (await res.json()) as { metadata?: { total?: number }; results?: Raw[] };
        return { total: Number(body.metadata?.total ?? 0), results: body.results ?? [] };
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      throw new ScorecardHttpError(res.status, page);
    }
  };

  const fetchPage = async (page: number) => {
    try {
      return await get(page, fields);
    } catch (err) {
      if (probed || !(err instanceof ScorecardHttpError) || err.status !== 400) throw err;
      await get(0, BASE_FIELDS, 1);
      const accepted: string[] = [];
      const left: string[] = [];
      for (const [name, group] of Object.entries(EXTENDED_FIELD_GROUPS)) {
        try {
          await get(0, [...BASE_FIELDS, ...group], 1);
          accepted.push(...group);
        } catch (e) {
          if (!(e instanceof ScorecardHttpError) || e.status !== 400) throw e;
          left.push(name);
        }
      }
      // Only a probe that finished decides; one cut short by an outage is tried again on the next page.
      probed = true;
      refused.push(...left);
      fields = [...BASE_FIELDS, ...accepted];
      return get(page, fields);
    }
  };
  return Object.assign(fetchPage, { refusedGroups: () => [...refused] });
}

function refusedGroupsOf(fetchPage: FetchPage): string[] {
  const f = fetchPage as Partial<ScorecardFetchPage>;
  return typeof f.refusedGroups === "function" ? f.refusedGroups() : [];
}

// ---- Writing ----------------------------------------------------------------------

/**
 * The college_stats upsert, surviving a database without migration
 * 20261023080001 (applied by hand, possibly after the code). An upsert naming a
 * missing column fails whole, which would stop every existing figure from
 * refreshing; so when it is refused for one of the extended columns, it is
 * retried once without them, and the miss is remembered for a few minutes so
 * the run's later pages leave them out up front (the lib/deliveryInsert.ts
 * pattern). `stripped` tells the run, which records it as degraded.
 */
type PgError = { code?: string; message: string };
export type StatsUpsert = (rows: Raw[]) => PromiseLike<{ error: PgError | null }>;

export const MISSING_STATS_COLUMNS_TTL_MS = 5 * 60_000;
let statsColumnsMissingUntil = 0;

/** For tests. */
export function resetStatsColumnCache(): void {
  statsColumnsMissingUntil = 0;
}

/** Postgres "undefined column" or PostgREST's schema-cache miss, naming one of the extended columns. */
export function isMissingStatsColumn(error: PgError | null): boolean {
  if (!error || (error.code !== "42703" && error.code !== "PGRST204")) return false;
  return EXTENDED_STAT_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(error.message));
}

const withoutExtended = (row: Raw): Raw => {
  const out = { ...row };
  for (const c of EXTENDED_STAT_COLUMNS) delete out[c];
  return out;
};

export async function upsertStats(
  upsert: StatsUpsert,
  rows: Raw[],
  now: number = Date.now()
): Promise<{ error: PgError | null; stripped: boolean }> {
  if (now < statsColumnsMissingUntil) {
    const { error } = await upsert(rows.map(withoutExtended));
    return { error, stripped: true };
  }
  const first = await upsert(rows);
  if (!isMissingStatsColumn(first.error)) return { error: first.error, stripped: false };
  statsColumnsMissingUntil = now + MISSING_STATS_COLUMNS_TTL_MS;
  const { error } = await upsert(rows.map(withoutExtended));
  return { error, stripped: true };
}


type Existing = { id: string; unitid: number | null; slug: string; catalog_source: string };

/** Upsert one page. Returns how many schools were written and skipped. */
export async function writePage(
  svc: SupabaseClient,
  schools: MappedSchool[],
  ingestedAt: string
): Promise<{ upserted: number; skipped: number; extendedColumnsMissing: boolean }> {
  if (!schools.length) return { upserted: 0, skipped: 0, extendedColumnsMissing: false };
  const unitids = schools.map((s) => s.unitid);
  const { data: found, error } = await svc
    .from("colleges")
    .select("id, unitid, slug, catalog_source")
    .in("unitid", unitids);
  if (error) throw new Error(`read colleges: ${error.code}`);
  const byUnitid = new Map(((found ?? []) as Existing[]).map((c) => [Number(c.unitid), c]));

  // Slugs for new schools, unique against the catalog and each other.
  const fresh = schools.filter((s) => !byUnitid.has(s.unitid));
  const wanted = fresh.map((s) => slugify(s.college.name));
  const candidates = [...new Set(wanted.flatMap((w, i) => [w, `${w}-${(fresh[i]!.college.state ?? "").toLowerCase()}`]))];
  const taken = new Set<string>();
  if (candidates.length) {
    const { data: clash, error: e2 } = await svc.from("colleges").select("slug").in("slug", candidates);
    if (e2) throw new Error(`read slugs: ${e2.code}`);
    for (const c of clash ?? []) taken.add(String((c as Raw).slug));
  }

  const facts = (s: MappedSchool) => ({
    city: s.college.city,
    state: s.college.state,
    zip: s.college.zip,
    ope_id: s.college.ope_id,
    control: s.college.control,
    size: s.college.size,
    acceptance_rate: s.college.acceptance_rate,
    last_ingested_at: ingestedAt,
    data_year: SCORECARD_DATA_YEAR,
  });

  const inserts: Raw[] = [];
  for (const [i, s] of fresh.entries()) {
    const base = wanted[i] || `college-${s.unitid}`;
    const state = (s.college.state ?? "").toLowerCase();
    const slug = [base, state ? `${base}-${state}` : null, `${base}-${s.unitid}`].find((c) => c && !taken.has(c))!;
    taken.add(slug);
    inserts.push({
      ...facts(s),
      unitid: s.unitid,
      name: s.college.name,
      slug,
      aka: s.college.aka,
      initials: initialsOf(s.college.name) || null,
      website: s.college.website,
      catalog_source: "scorecard",
    });
  }
  if (inserts.length) {
    const { data: made, error: e3 } = await svc.from("colleges").insert(inserts).select("id, unitid, slug, catalog_source");
    if (e3) throw new Error(`insert colleges: ${e3.code}`);
    for (const c of (made ?? []) as Existing[]) byUnitid.set(Number(c.unitid), c);
  }

  // Existing rows: facts always; the name and aliases only on rows Scorecard owns;
  // the website only where the catalog has none.
  for (const s of schools) {
    const row = byUnitid.get(s.unitid);
    if (!row || inserts.some((x) => x.unitid === s.unitid)) continue;
    const update: Raw = facts(s);
    if (row.catalog_source === "scorecard") {
      update.name = s.college.name;
      update.aka = s.college.aka;
    }
    const { error: e4 } = await svc.from("colleges").update(update).eq("id", row.id);
    if (e4) throw new Error(`update college ${s.unitid}: ${e4.code}`);
    if (s.college.website) {
      await svc.from("colleges").update({ website: s.college.website }).eq("id", row.id).is("website", null);
    }
  }

  const stats = schools
    .filter((s) => byUnitid.has(s.unitid))
    .map((s) => ({
      college_id: byUnitid.get(s.unitid)!.id,
      ...s.stats,
      data_year: SCORECARD_DATA_YEAR,
      provenance: "sourced",
      source_url: `https://collegescorecard.ed.gov/school/?${s.unitid}`,
      source_verified_at: ingestedAt,
      updated_at: ingestedAt,
    }));
  const written = await upsertStats((rows) => svc.from("college_stats").upsert(rows, { onConflict: "college_id" }), stats);
  if (written.error) throw new Error(`upsert stats: ${written.error.code}`);

  // Fields of study: replace each school's set, so a program Scorecard dropped goes.
  const ids = stats.map((s) => s.college_id as string);
  const { error: e6 } = await svc.from("college_fields_of_study").delete().in("college_id", ids);
  if (e6) throw new Error(`clear fields: ${e6.code}`);
  const programs = schools.flatMap((s) =>
    byUnitid.has(s.unitid)
      ? s.programs.map((p) => ({ ...p, college_id: byUnitid.get(s.unitid)!.id, source_verified_at: ingestedAt }))
      : []
  );
  for (let i = 0; i < programs.length; i += 1000) {
    const { error: e7 } = await svc.from("college_fields_of_study").insert(programs.slice(i, i + 1000));
    if (e7) throw new Error(`insert fields: ${e7.code}`);
  }

  return { upserted: stats.length, skipped: schools.length - stats.length, extendedColumnsMissing: written.stripped };
}

// ---- The run ----------------------------------------------------------------------

export type IngestOutcome = {
  runId: string | null;
  status: "succeeded" | "partial" | "failed";
  upserted: number;
  skipped: number;
  pages: number;
  errors: string[];
  /**
   * Why the run loaded less than it should every time, not a passing fault:
   * Scorecard refused extended fields, or college_stats lacks their columns.
   * Also the first entries of `errors`. A run with any is not a clean heartbeat.
   */
  degraded: string[];
};

export async function runScorecardIngest(
  svc: SupabaseClient,
  fetchPage: FetchPage,
  log: Log,
  opts: { trigger?: "manual" | "cron" | "script"; maxPages?: number; now?: () => Date } = {}
): Promise<IngestOutcome> {
  const started = Date.now();
  const ingestedAt = (opts.now?.() ?? new Date()).toISOString();
  const { data: run } = await svc
    .from("ingest_runs")
    .insert({ source: "scorecard", trigger: opts.trigger ?? "manual" })
    .select("id")
    .single();
  const runId = (run as Raw | null)?.id ? String((run as Raw).id) : null;

  const errors: string[] = [];
  let upserted = 0;
  let skipped = 0;
  let pages = 0;
  let total = Infinity;
  let extendedColumnsMissing = false;
  for (let page = 0; page * PER_PAGE < total; page++) {
    if (opts.maxPages !== undefined && pages >= opts.maxPages) break;
    pages++;
    try {
      const body = await fetchPage(page);
      total = body.total;
      const mapped = body.results.map(mapScorecardSchool);
      const keep = mapped.filter((m): m is MappedSchool => m !== null);
      skipped += mapped.length - keep.length;
      const w = await writePage(svc, keep, ingestedAt);
      upserted += w.upserted;
      skipped += w.skipped;
      if (w.extendedColumnsMissing) extendedColumnsMissing = true;
      log.info({ page, total, upserted }, "scorecard ingest: page written");
      if (body.results.length === 0) break;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      errors.push(`page ${page}: ${message}`.slice(0, 300));
      log.error({ page, err: message }, "scorecard ingest: page failed");
      if (!Number.isFinite(total)) break; // the first page failed: nothing to page through
    }
  }

  const degraded: string[] = [];
  const refused = refusedGroupsOf(fetchPage);
  if (refused.length) {
    degraded.push(`Scorecard refused extended fields (${refused.join(", ")}); loaded without them`);
    log.error({ refused: refused.map((g) => [g, ...EXTENDED_FIELD_GROUPS[g as keyof typeof EXTENDED_FIELD_GROUPS]]) }, "scorecard ingest: extended fields refused");
  }
  if (extendedColumnsMissing) {
    degraded.push("college_stats lacks the extended columns; apply migration 20261023080001");
    log.error({}, "scorecard ingest: college_stats extended columns missing; apply 20261023080001");
  }
  errors.unshift(...degraded);
  const status: IngestOutcome["status"] = errors.length === 0 ? "succeeded" : upserted > 0 ? "partial" : "failed";
  if (runId) {
    await svc
      .from("ingest_runs")
      .update({
        status,
        rows_upserted: upserted,
        rows_skipped: skipped,
        errors: errors.slice(0, 50),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
      })
      .eq("id", runId);
  }
  return { runId, status, upserted, skipped, pages, errors, degraded };
}
