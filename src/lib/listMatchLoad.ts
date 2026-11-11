/**
 * Loading list-match scores for one Build College Lists run (LIST_MATCH_ENABLED=true; the rules are
 * lib/listMatch.ts). Called by POST /colleges/list-builder after resolveStudentId authorized the caller.
 *
 *   the student   card ratings (weights, and the loved cards' prompts), intended majors, headline and activities,
 *                 read on the caller's own client through the AI allowlist's columns()
 *   the vector    their interest paragraph embedded in this process (lib/embeddings.ts), cached in
 *                 student_interest_embeddings by the sha256 of the model and the paragraph (service role: no client
 *                 reads or writes that table), so it is embedded again only when the paragraph changes
 *   the schools   college_core_features for the candidates, and match_college_opportunities (the RPC, as the caller)
 *
 * It never fails the list builder: any read that fails is logged (codes only) and that part of the score is left
 * out; with nothing left the answer is null and the list is ordered by odds, as without the flag. While a
 * migration is missing (20261119000001 or 20261124000001) one warning says so and that part is not asked again for
 * five minutes. The embedding waits at most EMBED_DEADLINE_MS (the model may still be loading after a deploy):
 * past it this run has no opportunity score, and the vector is still cached when it arrives.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { isSchemaMissing } from "./axis/failsafe.js";
import { columns } from "./context/ai-allowlist.js";
import { CORE_FEATURE_KEYS, MATCH_CONFIG, OPPORTUNITY_CATEGORIES, type CoreFeatureKey } from "./listContract.js";
import {
  coreScore,
  interestParagraph,
  opportunityRaw,
  parseVector,
  studentWeights,
  vectorText,
  type CardRating,
  type FeatureValues,
  type MatchInput,
  type OpportunityHit,
} from "./listMatch.js";
import { RATINGS, type Rating } from "./preferences.js";
import { serviceClient } from "./supabase.js";

type Row = Record<string, unknown>;
type Log = { warn(obj: unknown, msg?: string): void };
type Db = Pick<SupabaseClient, "from" | "rpc">;

export const MATCH_MIGRATIONS = ["20261119000001_list_builder_learning", "20261124000001_list_match"];
export const INTEREST_TABLE = "student_interest_embeddings";
/** How long a list-builder answer waits for the student's vector before going on without opportunity scores. */
export const EMBED_DEADLINE_MS = 2_500;
/** Candidates per core-features read: 10 rows each, kept under PostgREST's 1,000-row cap. */
const FEATURE_CHUNK = 50;
/** Candidates per opportunities call: topK rows each. */
const OPPORTUNITY_CHUNK = 100;
const PAUSE_MS = 5 * 60_000;

export const listMatchEnabled = () => env.LIST_MATCH_ENABLED === "true";

export type MatchLoadDeps = {
  /** The caller's own client (RLS applies). */
  db: Db;
  /** The service client, for the vector cache only; null without the service key (no cache). */
  svc: Pick<SupabaseClient, "from"> | null;
  /** lib/embeddings.ts, injected so tests need no model. */
  embed: (texts: string[]) => Promise<number[][]>;
  model: string;
  dim: number;
  log: Log;
  deadlineMs?: number;
  now?: () => number;
};

// ---- A missing migration: one warning, then quiet for a while ----

const pausedUntil = { features: 0, opportunities: 0 };

function pause(part: keyof typeof pausedUntil, now: number, log: Log): void {
  pausedUntil[part] = now + PAUSE_MS;
  log.warn({ part, migrations: MATCH_MIGRATIONS }, "List match: a database update isn't applied, so this part of the score is left out. Trying again in 5 minutes.");
}

/** Tests only. */
export function resetListMatchForTest(): void {
  pausedUntil.features = 0;
  pausedUntil.opportunities = 0;
}

const codeOf = (err: unknown) =>
  err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : "unknown";

const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---- The student ----

type StudentRecord = { ratings: CardRating[]; paragraph: string };

const isRating = (v: unknown): v is Rating => typeof v === "string" && (RATINGS as string[]).includes(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const nstr = (v: unknown) => (typeof v === "string" ? v : null);

/** Card ratings and the interest paragraph. A read that fails counts as empty (the weights fall back to defaults). */
async function readStudent(deps: MatchLoadDeps, studentId: string): Promise<StudentRecord> {
  const { db, log } = deps;
  const soft = async (what: string, q: PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown> => {
    const { data, error } = await q;
    if (error) {
      log.warn({ part: what, code: codeOf(error) }, "List match: a student read failed; going on without it");
      return null;
    }
    return data;
  };
  const [cards, profile, personal, activities] = await Promise.all([
    soft(
      "cards",
      db
        .from("student_preference_cards")
        .select(`${columns("student_preference_cards", ["rating"])}, card:preference_cards(${columns("preference_cards", ["card_key", "prompt"])})`)
        .eq("student_id", studentId)
        .limit(200)
    ),
    soft("profile", db.from("profiles").select(columns("profiles", ["headline"])).eq("id", studentId).maybeSingle()),
    soft(
      "personal",
      db.from("student_personal_details").select(columns("student_personal_details", ["intended_majors"])).eq("student_id", studentId).maybeSingle()
    ),
    soft(
      "activities",
      db
        .from("activities")
        .select(columns("activities", ["name", "position", "category", "description"]))
        .eq("student_id", studentId)
        .order("sort_order")
        .limit(12)
    ),
  ]);

  const ratings: CardRating[] = [];
  const loved: string[] = [];
  for (const r of (Array.isArray(cards) ? cards : []) as Row[]) {
    const card = (Array.isArray(r.card) ? r.card[0] : r.card) as Row | null | undefined;
    const key = nstr(card?.card_key);
    if (!key || !isRating(r.rating)) continue;
    ratings.push({ cardKey: key, rating: r.rating });
    const prompt = nstr(card?.prompt);
    if (r.rating === "love" && prompt) loved.push(prompt);
  }
  const paragraph = interestParagraph({
    majors: strings((personal as Row | null)?.intended_majors),
    headline: nstr((profile as Row | null)?.headline),
    activities: ((Array.isArray(activities) ? activities : []) as Row[]).map((a) => ({
      name: nstr(a.name),
      position: nstr(a.position),
      category: nstr(a.category),
      description: nstr(a.description),
    })),
    lovedCards: loved,
  });
  return { ratings, paragraph };
}

// ---- The vector ----

export const interestHash = (model: string, paragraph: string) => createHash("sha256").update(`${model}\n${paragraph}`).digest("hex");

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The student's interest vector: the cached one when the paragraph is unchanged, else embedded (and cached). */
export async function interestVector(deps: MatchLoadDeps, studentId: string, paragraph: string): Promise<number[] | null> {
  if (!paragraph) return null;
  const { svc, log } = deps;
  const hash = interestHash(deps.model, paragraph);
  if (svc) {
    const { data, error } = await svc.from(INTEREST_TABLE).select("content_hash, embedding").eq("student_id", studentId).maybeSingle();
    if (error) {
      if (!isSchemaMissing(error)) log.warn({ code: codeOf(error) }, "List match: the interest vector cache couldn't be read");
    } else if (data && (data as Row).content_hash === hash) {
      const v = parseVector((data as Row).embedding, deps.dim);
      if (v) return v;
    }
  }
  const save = async (v: number[]) => {
    if (!svc) return;
    try {
      const { error } = await svc
        .from(INTEREST_TABLE)
        .upsert({ student_id: studentId, content_hash: hash, model: deps.model, embedding: vectorText(v), updated_at: new Date().toISOString() }, { onConflict: "student_id" });
      if (error && !isSchemaMissing(error)) log.warn({ code: codeOf(error) }, "List match: the interest vector wasn't cached");
    } catch (err) {
      log.warn({ code: codeOf(err) }, "List match: the interest vector wasn't cached");
    }
  };
  // The embedding goes on after the deadline and is still cached, so the next run has it.
  const pending = deps.embed([paragraph]).then(([v]) => {
    if (!v || v.length !== deps.dim) throw new Error("embed: unexpected vector");
    void save(v);
    return v;
  });
  pending.catch((err: unknown) => log.warn({ code: codeOf(err) }, "List match: the interest paragraph couldn't be embedded"));
  return withDeadline(pending.catch(() => null), deps.deadlineMs ?? EMBED_DEADLINE_MS);
}

// ---- The schools ----

/** Each candidate's known core feature values (unknown values are left out). */
async function readFeatures(db: Db, ids: string[]): Promise<Map<string, FeatureValues>> {
  const out = new Map<string, FeatureValues>();
  const keys = new Set<string>(CORE_FEATURE_KEYS);
  for (const part of chunks(ids, FEATURE_CHUNK)) {
    const { data, error } = await db
      .from("college_core_features")
      .select("college_id, feature_key, value")
      .in("college_id", part)
      .in("feature_key", CORE_FEATURE_KEYS)
      .limit(1000);
    if (error) throw error;
    for (const r of (data ?? []) as Row[]) {
      const key = String(r.feature_key);
      const value = r.value == null ? null : Number(r.value);
      if (!keys.has(key) || value == null || !Number.isFinite(value)) continue;
      const id = String(r.college_id);
      out.set(id, { ...(out.get(id) ?? {}), [key as CoreFeatureKey]: value });
    }
  }
  return out;
}

const PRIOR_WEIGHTS = Object.fromEntries(Object.entries(OPPORTUNITY_CATEGORIES).map(([key, c]) => [key, c.priorWeight]));

/** Each candidate's best-matching opportunities (match_college_opportunities, as the caller). */
async function readOpportunities(db: Db, ids: string[], vector: number[]): Promise<Map<string, OpportunityHit[]>> {
  const out = new Map<string, OpportunityHit[]>();
  const embedding = vectorText(vector);
  for (const part of chunks(ids, OPPORTUNITY_CHUNK)) {
    const { data, error } = await db.rpc("match_college_opportunities", {
      p_college_ids: part,
      p_embedding: embedding,
      p_weights: PRIOR_WEIGHTS,
      p_top_k: MATCH_CONFIG.topK,
    });
    if (error) throw error;
    for (const r of (data ?? []) as Row[]) {
      const id = String(r.college_id);
      out.set(id, [
        ...(out.get(id) ?? []),
        {
          id: String(r.opportunity_id),
          name: String(r.name ?? ""),
          category: String(r.category ?? ""),
          quote: nstr(r.quote),
          sourceUrl: nstr(r.source_url),
          similarity: Number(r.similarity),
          weighted: Number(r.weighted),
        },
      ]);
    }
  }
  return out;
}

// ---- One run ----

/**
 * The raw match data for each candidate that has any (lib/listMatch.ts finalizeMatch turns it into scores across
 * the list), or null when nothing could be read. Never throws.
 */
export async function loadListMatch(deps: MatchLoadDeps, studentId: string, collegeIds: string[]): Promise<Map<string, MatchInput> | null> {
  const { db, log } = deps;
  const now = deps.now?.() ?? Date.now();
  const ids = [...new Set(collegeIds)];
  if (ids.length === 0) return null;
  try {
    // The schools' features don't depend on the student: read them while the student's record is read.
    const features = now < pausedUntil.features
      ? null
      : readFeatures(db, ids).catch((err: unknown) => {
          if (isSchemaMissing(err)) pause("features", now, log);
          else log.warn({ code: codeOf(err) }, "List match: core features couldn't be read");
          return null;
        });
    const student = await readStudent(deps, studentId);
    const weights = studentWeights(student.ratings);
    const opportunities = now < pausedUntil.opportunities
      ? null
      : interestVector(deps, studentId, student.paragraph).then((vector) =>
          vector
            ? readOpportunities(db, ids, vector).catch((err: unknown) => {
                if (isSchemaMissing(err)) pause("opportunities", now, log);
                else log.warn({ code: codeOf(err) }, "List match: opportunities couldn't be read");
                return null;
              })
            : null
        );
    const [values, hits] = await Promise.all([features, opportunities]);
    if (!values && !hits) return null;

    const out = new Map<string, MatchInput>();
    for (const id of ids) {
      const core = values?.has(id) ? coreScore(weights, values.get(id)!) : null;
      const opp = hits?.has(id) ? opportunityRaw(hits.get(id)!) : { raw: null, top: [] };
      if (core == null && opp.raw == null) continue;
      out.set(id, { core, opportunityRaw: opp.raw, topOpportunities: opp.top });
    }
    return out;
  } catch (err) {
    log.warn({ code: codeOf(err) }, "List match: scores couldn't be loaded; the list is ordered by odds");
    return null;
  }
}

/**
 * Production dependencies: the caller's client, the service client, and the in-process model. The model's library
 * is imported here, not at the top, so an instance with the flag off never loads it; if it can't be loaded at all,
 * every embed fails and the list is ranked by core features alone.
 */
export async function defaultMatchDeps(db: Db, log: Log): Promise<MatchLoadDeps> {
  const base = { db, svc: serviceClient(), log };
  try {
    const { embed, EMBEDDING_MODEL, EMBEDDING_DIM } = await import("./embeddings.js");
    return { ...base, embed, model: EMBEDDING_MODEL, dim: EMBEDDING_DIM };
  } catch (err) {
    log.warn({ code: codeOf(err) }, "List match: the embedding library couldn't be loaded; ranking by core features only");
    return { ...base, embed: () => Promise.reject(new Error("embedding library unavailable")), model: "unavailable", dim: 384 };
  }
}
