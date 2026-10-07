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
export const SCORECARD_FIELDS = [
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
  "latest.completion.consumer_rate", "latest.earnings.10_yrs_after_entry.median",
  `${PROGRAM}.code`, `${PROGRAM}.title`, `${PROGRAM}.credential.level`, `${PROGRAM}.counts.ipeds_awards2`,
  `${PROGRAM}.earnings.4_yr.overall_median_earnings`, `${PROGRAM}.debt.staff_grad_plus.all.eval_inst.median`,
];

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
const text = (v: unknown, max = 300): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const flag = (v: unknown): boolean => v === 1 || v === true;

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
    },
    programs,
  };
}

// ---- Fetching ---------------------------------------------------------------------

export type FetchPage = (page: number) => Promise<{ total: number; results: Raw[] }>;

/** A real fetch against the API, with backoff on 429 and 5xx. */
export function scorecardFetcher(apiKey: string, opts: { baseUrl?: string; sleep?: (ms: number) => Promise<void> } = {}): FetchPage {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return async (page: number) => {
    const url = new URL(opts.baseUrl ?? SCORECARD_API);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("school.operating", "1");
    url.searchParams.set("school.degrees_awarded.predominant", "2,3,4");
    url.searchParams.set("fields", SCORECARD_FIELDS.join(","));
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "id");
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        const body = (await res.json()) as { metadata?: { total?: number }; results?: Raw[] };
        return { total: Number(body.metadata?.total ?? 0), results: body.results ?? [] };
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      // The body can echo the request (and so the key); report the status only.
      throw new Error(`Scorecard returned ${res.status} for page ${page}`);
    }
  };
}

// ---- Writing ----------------------------------------------------------------------

type Existing = { id: string; unitid: number | null; slug: string; catalog_source: string };

/** Upsert one page. Returns how many schools were written and skipped. */
export async function writePage(
  svc: SupabaseClient,
  schools: MappedSchool[],
  ingestedAt: string
): Promise<{ upserted: number; skipped: number }> {
  if (!schools.length) return { upserted: 0, skipped: 0 };
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
  const { error: e5 } = await svc.from("college_stats").upsert(stats, { onConflict: "college_id" });
  if (e5) throw new Error(`upsert stats: ${e5.code}`);

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

  return { upserted: stats.length, skipped: schools.length - stats.length };
}

// ---- The run ----------------------------------------------------------------------

export type IngestOutcome = {
  runId: string | null;
  status: "succeeded" | "partial" | "failed";
  upserted: number;
  skipped: number;
  pages: number;
  errors: string[];
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
      log.info({ page, total, upserted }, "scorecard ingest: page written");
      if (body.results.length === 0) break;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      errors.push(`page ${page}: ${message}`.slice(0, 300));
      log.error({ page, err: message }, "scorecard ingest: page failed");
      if (!Number.isFinite(total)) break; // the first page failed: nothing to page through
    }
  }

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
  return { runId, status, upserted, skipped, pages, errors };
}
