/**
 * Wiring for the college features ingest (lib/ingest/collegeFeatures.ts), used by `npm run ingest:features`
 * (scripts/ingest/college-features.ts): the real crawler (lib/links.ts, the SSRF-safe fetcher, through
 * lib/ingest/siteCrawl.ts's robots.txt and per-host rate), the model on the job's own system budget (Haiku,
 * module "college-features", an ai_runs row per call), the in-process embedder, and the service-role store.
 *
 * A system job acting for no one: it reads public catalog rows and the colleges' public pages, and writes only
 * catalog tables no client can write (college_core_features, college_opportunities, college_source_pages) and the
 * run's ai_runs summary row. No student or counselor data is read except which colleges students list, as ids.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasAnthropic } from "../../env.js";
import { FAST_MODEL, runSystemStructured } from "../anthropic.js";
import { embed } from "../embeddings.js";
import { fetchCrawlFile, fetchSitePage } from "../links.js";
import { topRosterColleges } from "../rosterColleges.js";
import { serviceClient } from "../supabase.js";
import {
  MAX_PAGES,
  runCollegeFeatures,
  type CollegeInput,
  type CollegeReport,
  type ExtractCall,
  type ExtractUsage,
  type FeatureStore,
  type PageWrite,
  type RunReport,
} from "./collegeFeatures.js";
import { crawlCollege, HostThrottle } from "./siteCrawl.js";

type Row = Record<string, unknown>;
type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

const LEASE = "college-features";
/** Twenty colleges take minutes; a few hundred, an hour or two at one request a second per site. */
const LEASE_TTL_SECONDS = 6 * 60 * 60;
const MIGRATIONS = "20261119000001_list_builder_learning.sql and 20261124000001_college_source_pages.sql";

/** pgvector's text form: "[0.1,0.2,...]". */
const toVector = (v: number[] | null) => (v ? `[${v.join(",")}]` : null);

/** The real store: service role, keyed by the college id the job picked. */
export function supabaseFeatureStore(svc: SupabaseClient): FeatureStore {
  const fail = (table: string, message: string): never => {
    throw new Error(`${table}: ${message}`);
  };
  const upsertPages = async (collegeId: string, pages: PageWrite[], at: string) => {
    if (!pages.length) return;
    const { error } = await svc.from("college_source_pages").upsert(
      pages.map((p) => ({ college_id: collegeId, url: p.url, content_hash: p.hash, text_chars: p.chars, fetched_at: at })),
      { onConflict: "college_id,url" }
    );
    if (error) fail("college_source_pages", error.message);
  };

  return {
    async sourcePages(collegeId) {
      const { data, error } = await svc.from("college_source_pages").select("url, content_hash").eq("college_id", collegeId).limit(500);
      if (error) fail("college_source_pages", error.message);
      return ((data ?? []) as Row[]).map((r) => ({ url: String(r.url), content_hash: String(r.content_hash) }));
    },

    async opportunities(collegeId) {
      const { data, error } = await svc
        .from("college_opportunities")
        .select("id, name, source_url, content_hash, missed_runs, active")
        .eq("college_id", collegeId)
        .limit(2000);
      if (error) fail("college_opportunities", error.message);
      return ((data ?? []) as Row[]).map((r) => ({
        id: String(r.id),
        name: String(r.name),
        source_url: (r.source_url as string | null) ?? null,
        content_hash: (r.content_hash as string | null) ?? null,
        missed_runs: Number(r.missed_runs ?? 0),
        active: r.active !== false,
      }));
    },

    async save(collegeId, w) {
      if (w.features.length) {
        const { error } = await svc.from("college_core_features").upsert(
          w.features.map((f) => ({ college_id: collegeId, feature_key: f.key, value: f.value, quote: f.quote, source_url: f.sourceUrl, extracted_at: w.at })),
          { onConflict: "college_id,feature_key" }
        );
        if (error) fail("college_core_features", error.message);
      }
      if (w.inserts.length) {
        const { error } = await svc.from("college_opportunities").insert(
          w.inserts.map((o) => ({
            college_id: collegeId,
            name: o.name,
            category: o.category,
            description: o.description,
            quote: o.quote,
            source_url: o.sourceUrl,
            embedding: toVector(o.embedding),
            content_hash: o.contentHash,
            first_seen_at: w.at,
            last_seen_at: w.at,
            active: true,
            missed_runs: 0,
          }))
        );
        if (error) fail("college_opportunities", error.message);
      }
      for (const s of w.seen) {
        const o = s.found;
        const vector = s.reembedded ? { embedding: toVector(o.embedding), content_hash: o.contentHash } : s.stale ? { content_hash: null } : {};
        const { error } = await svc
          .from("college_opportunities")
          .update({
            name: o.name,
            category: o.category,
            description: o.description,
            quote: o.quote,
            source_url: o.sourceUrl,
            last_seen_at: w.at,
            active: true,
            missed_runs: 0,
            ...vector,
          })
          .eq("id", s.id)
          .eq("college_id", collegeId);
        if (error) fail("college_opportunities", error.message);
      }
      for (const m of w.missed) {
        const { error } = await svc
          .from("college_opportunities")
          .update({ missed_runs: m.missedRuns, ...(m.deactivate ? { active: false } : {}) })
          .eq("id", m.id)
          .eq("college_id", collegeId);
        if (error) fail("college_opportunities", error.message);
      }
      await upsertPages(collegeId, w.pages, w.at);
    },

    touchPages: upsertPages,
  };
}

/** Both tables and the missed_runs column are there: null, else the migrations to apply. */
async function missingSchema(svc: SupabaseClient): Promise<string | null> {
  const pages = await svc.from("college_source_pages").select("college_id").limit(0);
  const opps = await svc.from("college_opportunities").select("missed_runs").limit(0);
  const feats = await svc.from("college_core_features").select("college_id").limit(0);
  return pages.error || opps.error || feats.error ? `Apply ${MIGRATIONS} first.` : null;
}

/** The live model call: one Haiku call on the job's system budget, its ai_runs row written by runSystemStructured. */
function liveExtract(log: Log): ExtractCall {
  return async (req) => {
    let usage: ExtractUsage | null = null;
    const raw = await runSystemStructured<unknown>({
      job: "college-features",
      module: "college-features",
      model: req.model,
      system: req.system,
      prompt: req.prompt,
      schema: req.schema,
      toolName: req.toolName,
      maxTokens: req.maxTokens,
      // Grounding runs after the call (collegeFeatures.ts), the same for a live call or a batch result.
      validate: (value) => value,
      onUsage: (u) => {
        usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
      },
      log,
    });
    return { raw, usage };
  };
}

async function collegesByIds(svc: SupabaseClient, ids: string[]): Promise<{ found: CollegeInput[]; missing: string[] }> {
  const { data, error } = await svc.from("colleges").select("id, name, website").in("id", ids);
  if (error) throw new Error(`colleges: ${error.message}`);
  const byId = new Map(((data ?? []) as Row[]).map((r) => [String(r.id), r]));
  const found: CollegeInput[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) found.push({ id, name: String(r.name), website: (r.website as string | null) ?? null });
    else missing.push(id);
  }
  return { found, missing };
}

/** The run as one ai_runs row: totals, the low-yield list and a line per college (public catalog facts only). */
async function writeSummary(svc: SupabaseClient, report: RunReport, selection: "roster" | "ids", log: Log): Promise<void> {
  const compact = (c: CollegeReport) => ({
    collegeId: c.collegeId,
    name: c.name,
    status: c.status,
    pagesFetched: c.pagesFetched,
    pagesRead: c.pagesRead,
    textChars: c.textChars,
    featuresFound: c.featuresFound,
    opportunitiesFound: c.opportunitiesFound,
    inserted: c.inserted,
    seen: c.seen,
    missed: c.missed,
    deactivated: c.deactivated,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    lowYield: c.lowYield,
    note: c.note,
  });
  const { error } = await svc.from("ai_runs").insert({
    actor_id: null,
    student_id: null,
    module: "college-features",
    model: report.model,
    status: report.stoppedBy ? "failed" : "succeeded",
    input: { kind: "run-summary", selection, dryRun: report.dryRun, force: report.force, colleges: report.colleges.length },
    output: { totals: report.totals, lowYield: report.lowYield, stoppedBy: report.stoppedBy, colleges: report.colleges.map(compact) },
    input_tokens: report.totals.inputTokens,
    output_tokens: report.totals.outputTokens,
    latency_ms: Math.max(0, Date.parse(report.finishedAt) - Date.parse(report.startedAt)),
    error: report.stoppedBy ? report.stoppedBy.slice(0, 500) : null,
    completed_at: report.finishedAt,
  });
  if (error) log.warn({ code: error.code }, "college features: the summary row wasn't written");
}

export type FeaturesJobOptions = { limit?: number; collegeIds?: string[]; dryRun?: boolean; force?: boolean; concurrency?: number };

export type FeaturesJobOutcome =
  | { ok: true; report: RunReport; missing: string[] }
  | { ok: false; reason: "no-service-role" | "no-key" | "migration-missing" | "locked" | "lease-error" | "no-colleges"; message: string };

export async function runCollegeFeaturesJob(
  opts: FeaturesJobOptions,
  log: Log,
  onCollege?: (r: CollegeReport) => void
): Promise<FeaturesJobOutcome> {
  const svc = serviceClient();
  if (!svc) return { ok: false, reason: "no-service-role", message: "SUPABASE_SERVICE_ROLE_KEY is required." };
  if (!hasAnthropic) return { ok: false, reason: "no-key", message: "ANTHROPIC_API_KEY is required to read the pages." };
  const schema = await missingSchema(svc);
  if (schema) return { ok: false, reason: "migration-missing", message: schema };

  // A dry run writes nothing, so two of them (or one beside a real run) can't step on each other.
  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  if (!opts.dryRun) {
    const { data: acquired, error } = await svc.rpc("acquire_job_lease", { p_name: LEASE, p_holder: holder, p_ttl_seconds: LEASE_TTL_SECONDS });
    if (error) return { ok: false, reason: "lease-error", message: `The job lease couldn't be taken (${error.code ?? "error"}).` };
    if (!acquired) return { ok: false, reason: "locked", message: "Another college features run is in progress." };
  }

  try {
    let colleges: CollegeInput[];
    let missing: string[] = [];
    if (opts.collegeIds?.length) {
      ({ found: colleges, missing } = await collegesByIds(svc, opts.collegeIds));
    } else {
      colleges = await topRosterColleges(svc, opts.limit ?? 20);
    }
    if (!colleges.length) {
      return { ok: false, reason: "no-colleges", message: opts.collegeIds?.length ? "None of those ids is in the catalog." : "No college is on any student's list yet." };
    }

    const throttle = new HostThrottle();
    const report = await runCollegeFeatures(
      colleges,
      {
        store: supabaseFeatureStore(svc),
        crawl: (website) =>
          crawlCollege(
            website,
            {
              throttle,
              fetchFile: (url, kind, o) => fetchCrawlFile(url, kind, o),
              fetchPage: (url, o) => fetchSitePage(url, { ...o, mainContent: true }),
            },
            { maxPages: MAX_PAGES }
          ),
        extract: liveExtract(log),
        embed,
        model: FAST_MODEL,
        log,
      },
      { dryRun: opts.dryRun, force: opts.force, concurrency: opts.concurrency, onCollege }
    );
    await writeSummary(svc, report, opts.collegeIds?.length ? "ids" : "roster", log);
    return { ok: true, report, missing };
  } finally {
    if (!opts.dryRun) await svc.rpc("release_job_lease", { p_name: LEASE, p_holder: holder });
  }
}
