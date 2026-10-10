/**
 * A research run: access -> brief (identity filter on the focus) -> cache -> limits -> record the run -> research ->
 * identity post-check -> keep only citations really seen in the run -> match -> store.
 *
 * The seam (`ResearchSeam`) is the one place the model, the web and the link check are called, so the test double
 * replaces all three at once and nothing else in this file knows about it.
 */
import type { FastifyRequest } from "fastify";
import { env } from "../../env.js";
import { FAST_MODEL, RESEARCH_MODEL, researchDomains, runStructured, runWebResearch, type ResearchResult } from "../anthropic.js";
import { buildStudentContext, type ContextUsage, type StudentContext } from "../context/index.js";
import { loadWorkspace } from "../crm.js";
import { assertAiAllowed } from "../practiceSettings.js";
import { badRequest, conflict, fromPostgrest, HttpError, unavailable } from "../errors.js";
import { enforceRateLimit } from "../limits.js";
import { checkLink } from "../links.js";
import { serviceClient } from "../supabase.js";
import { assertNoIdentity, briefHash, identityTokens, IdentityLeakError, toResearchBrief, type ResearchBrief } from "./brief.js";
import { researchFakeAllowed, type FakeEnv } from "./bootGuard.js";
import { keepCandidates } from "./citations.js";
import { fakeSeam } from "./fake.js";
import {
  buildMatchPrompt, buildResearchQuestion, dropStudentInfoInSuggestions, replaceWhysNamingStudent, MATCH_SCHEMA, MATCH_SYSTEM, parseCandidatesCounted, RESEARCH_CANDIDATES_SYSTEM,
  validatePicks, type RecommendationDraft, type ResearchCandidate,
} from "./prompt.js";

export type Feature = ResearchBrief["feature"];

export type RecommendationDto = {
  id: string;
  feature: string;
  title: string;
  why: string;
  details: { deadline?: string; cost?: string; effort?: string; collegeId?: string; verify: true };
  sources: { url: string; title: string | null; checkedAt: string }[];
  status: "suggested" | "accepted" | "dismissed";
  acceptedAs: { type: "student_college" | "task"; id: string } | null;
};

export type ResearchResponse = {
  runId: string;
  checkedAt: string;
  cached: boolean;
  recommendations: RecommendationDto[];
  contextUsed: ContextUsage;
};

type Kept = ResearchCandidate & { checkedAt: string };

/** The three calls a run makes to the outside world. */
export type ResearchSeam = {
  /** Stored on the run row. */
  model: string;
  /** Receives the brief and nothing else about the student (`studentId` only labels the audit row). */
  research(a: { request: FastifyRequest; feature: Feature; brief: ResearchBrief; blocked: string[]; studentId: string }): Promise<ResearchResult>;
  match(a: { request: FastifyRequest; ctx: StudentContext; kept: Kept[]; studentId: string }): Promise<unknown>;
  check(url: string): Promise<{ status: "ok" | "broken" | "blocked" }>;
};

export const realSeam: ResearchSeam = {
  model: RESEARCH_MODEL,
  research: ({ request, feature, brief, blocked, studentId }) =>
    runWebResearch({
      request,
      module: feature === "college_list" ? "college-research" : "activity-research",
      question: buildResearchQuestion(brief),
      domains: feature === "college_list" ? researchDomains([]) : undefined,
      blockedDomains: feature === "activities" ? blocked : undefined,
      system: RESEARCH_CANDIDATES_SYSTEM,
      studentId,
      maxSearches: 5,
    }),
  match: ({ request, ctx, kept, studentId }) =>
    runStructured<unknown>({
      request,
      module: "research-match",
      model: FAST_MODEL,
      system: MATCH_SYSTEM,
      prompt: buildMatchPrompt(ctx.text, kept),
      toolName: "pick",
      schema: MATCH_SCHEMA,
      contextUsage: { used: ctx.used, omitted: ctx.omitted },
      studentId,
    }),
  check: checkLink,
};

/** The test double only when asked for and NODE_ENV is development or test (the server also refuses to boot otherwise). */
export function seamFor(e: FakeEnv): ResearchSeam {
  return e.RESEARCH_FAKE === "fixture" && researchFakeAllowed(e) ? fakeSeam : realSeam;
}

/** NODE_ENV as the process has it: `env.NODE_ENV` defaults to development when unset, which must not unlock the fake. */
const rawEnv = (): FakeEnv => ({ RESEARCH_FAKE: env.RESEARCH_FAKE, NODE_ENV: process.env.NODE_ENV });

type Row = Record<string, unknown>;

/** What a run did at each step: numbers only, logged with the run id and never any text. */
export type RunCounts = { parts: number; objects: number; parsed: number; kept: number; picked: number; stored: number };

const WEEK_MS = 7 * 86_400_000;

/**
 * When a finished run stops being served from the cache. A run that stored something, or whose answer held no
 * candidate objects at all (the web really had nothing), is reusable for 7 days, so a repeat click doesn't pay for the
 * same empty search. A run whose answer DID hold candidates but stored nothing lost them downstream (a dead link, the
 * citation keeper, the match step, a bad reason): that looks the same as "nothing found" to the counselor but usually
 * isn't, so it is stored as succeeded with an empty list and expires at once, and the next request runs again.
 */
export function expiryFor(counts: RunCounts, now = Date.now()): string {
  const lostDownstream = counts.stored === 0 && counts.objects > 0;
  return new Date(lostDownstream ? now : now + WEEK_MS).toISOString();
}

/** A run still `running` after this long is treated as dead: nothing sweeps them, so the age is the only signal. */
export const RUNNING_STALE_MS = 10 * 60_000;

export function toDto(r: Row): RecommendationDto {
  return {
    id: r.id as string,
    feature: r.feature as string,
    title: r.title as string,
    why: r.why as string,
    details: r.details as RecommendationDto["details"],
    sources: r.sources as RecommendationDto["sources"],
    status: r.status as RecommendationDto["status"],
    acceptedAs: (r.accepted_as as RecommendationDto["acceptedAs"]) ?? null,
  };
}

export const REC_COLUMNS = "id, feature, title, why, details, sources, status, accepted_as";

/** When the sources were checked: the earliest check on the run's recommendations, else when the run was made. */
function checkedAtOf(recs: RecommendationDto[], fallback: string): string {
  const all = recs.flatMap((r) => r.sources.map((s) => s.checkedAt)).sort();
  return all[0] ?? fallback;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The catalog id when exactly one college has this name (case-insensitive); never a guess. */
async function collegeIdFor(request: FastifyRequest, title: string): Promise<string | undefined> {
  const { data } = await request.db.from("colleges").select("id, name").ilike("name", likeEscape(title)).limit(3);
  const hits = (data ?? []).filter((c) => String(c.name).trim().toLowerCase() === title.trim().toLowerCase());
  return hits.length === 1 ? (hits[0]!.id as string) : undefined;
}

/** Only the counselor's focus can trip the identity filter (a major that does is dropped from the brief), so the 400 says so. */
function briefOrRefuse(ctx: StudentContext, feature: Feature, focus: string | null): ResearchBrief {
  try {
    return toResearchBrief(ctx.facts, feature, focus);
  } catch (err) {
    if (!(err instanceof IdentityLeakError)) throw err;
    throw badRequest("The focus contains the student's name, school or hometown. Take it out and try again.");
  }
}

export async function runResearch(
  request: FastifyRequest,
  studentId: string,
  feature: Feature,
  opts: { refresh: boolean; focus: string | null },
  seam: ResearchSeam = seamFor(rawEnv())
): Promise<ResearchResponse> {
  // 1. Access: counselors only, on the case (403 / 404).
  const ctx = await buildStudentContext(request, studentId, feature === "college_list" ? "college-list" : "activities");
  const contextUsed: ContextUsage = { used: ctx.used, omitted: ctx.omitted };

  // 2. The brief, with the identity filter on the focus. Refused here: no quota, no run row, no model call.
  const brief = briefOrRefuse(ctx, feature, opts.focus);
  const hash = briefHash(brief);

  // 3. Cache: the newest unexpired run for this brief that produced something.
  if (!opts.refresh) {
    const { data: runs, error } = await request.db
      .from("research_runs")
      .select("id, created_at")
      .eq("student_id", studentId)
      .eq("feature", feature)
      .eq("status", "succeeded")
      .eq("inputs_hash", hash)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw fromPostgrest(error);
    const hit = runs?.[0];
    if (hit) {
      const { data: rows, error: recError } = await request.db
        .from("recommendations")
        .select(REC_COLUMNS)
        .eq("run_id", hit.id as string)
        .order("created_at", { ascending: false });
      if (recError) throw fromPostgrest(recError);
      // A run whose answer held no candidates at all is cached too (see expiryFor); one that lost them downstream isn't.
      const recommendations = (rows ?? []).map((r) => toDto(r as Row));
      return { runId: hit.id as string, checkedAt: checkedAtOf(recommendations, hit.created_at as string), cached: true, recommendations, contextUsed };
    }
  }

  // 4. The practice's AI switches (a refusal here leaves no run row and spends no cap), then its daily cap on runs
  // (the per-minute limit is the route's preHandler). The check is the one the model wrappers make, run up front.
  await assertAiAllowed(request, feature === "college_list" ? "college-research" : "activity-research");
  await assertAiAllowed(request, "research-match");
  const svc = serviceClient();
  if (!svc) throw unavailable("Research is unavailable right now. Try again shortly.");

  // The same request is already running (a double click, a proxy retry): runs are long and paid, so refuse before the
  // daily cap is spent. Read on the caller's client. A `running` row older than 10 minutes is treated as dead and
  // ignored; nothing sweeps them, so a crashed run would otherwise block this student and feature for good.
  const { data: inFlight, error: inFlightError } = await request.db
    .from("research_runs")
    .select("id")
    .eq("student_id", studentId)
    .eq("feature", feature)
    .eq("inputs_hash", hash)
    .eq("status", "running")
    .gt("created_at", new Date(Date.now() - RUNNING_STALE_MS).toISOString())
    .limit(1);
  if (inFlightError) throw fromPostgrest(inFlightError);
  if (inFlight?.length) throw conflict("Research is already running for this student. Try again in a minute.");

  const workspace = await loadWorkspace(request);
  await enforceRateLimit(
    `research-day:${workspace.firmId ?? request.auth.userId}`,
    50,
    86_400,
    "Your practice has used today's research runs. Try again tomorrow."
  );

  // 5. Record the run.
  const { data: created, error: insertError } = await svc
    .from("research_runs")
    .insert({
      student_id: studentId,
      counselor_id: request.auth.userId,
      firm_id: workspace.firmId,
      feature,
      inputs_hash: hash,
      brief,
      status: "running",
      model: seam.model,
      created_by: request.auth.userId,
      expires_at: new Date(Date.now() + WEEK_MS).toISOString(),
    })
    .select("id, created_at")
    .single();
  if (insertError || !created) {
    request.log.error({ code: insertError?.code }, "research run insert failed");
    throw unavailable("Research is unavailable right now. Try again shortly.");
  }
  const runId = created.id as string;
  let settled = false;
  const finish = async (status: "failed" | "discarded" | "succeeded", error: string | null, expiresAt?: string) => {
    settled = true;
    const { error: e } = await svc.from("research_runs").update({ status, error, ...(expiresAt ? { expires_at: expiresAt } : {}) }).eq("id", runId);
    if (e) request.log.error({ runId, code: e.code }, "research run status update failed");
  };

  try {
    // 6. Research. The seam gets the brief; ctx text, facts and the student's name never go with it.
    const { data: blockedRows, error: blockedError } = await svc.from("research_blocked_domains").select("domain");
    if (blockedError) throw fromPostgrest(blockedError);
    const blocked = (blockedRows ?? []).map((r) => r.domain as string);
    const result = await seam.research({ request, feature, brief, blocked, studentId });
    if (result.refused) {
      await finish("failed", "refused");
      throw unavailable("Research couldn't run for this request. Try again with a different focus.");
    }

    // 7. Identity post-check on every query the model issued.
    const tokens = identityTokens(ctx.facts.identity);
    try {
      for (const q of result.queries) assertNoIdentity(q, tokens);
    } catch (err) {
      if (!(err instanceof IdentityLeakError)) throw err;
      await finish("discarded", "identity-filter");
      request.log.error({ runId }, "research discarded: a search query held the student's identity");
      throw badRequest("Research couldn't run safely for this student. Try again with a different focus.");
    }

    // 8. Keep only what was really seen in this run, isn't blocked and still answers.
    const { candidates, objects } = parseCandidatesCounted(result.parts);
    const kept = await keepCandidates(candidates, result, blocked, seam.check);

    // 9. Match: a cheap model picks the fits. Nothing to match means an empty, successful run.
    const drafts: RecommendationDraft[] = kept.length
      ? dropStudentInfoInSuggestions(
          replaceWhysNamingStudent(validatePicks(await seam.match({ request, ctx, kept, studentId }), kept), ctx.facts.identity),
          ctx.facts.identity)
      : [];

    // 10. Store.
    const collegeIds = feature === "college_list" ? await Promise.all(drafts.map((d) => collegeIdFor(request, d.title))) : [];
    const base = Date.now();
    let recommendations: RecommendationDto[] = [];
    if (drafts.length) {
      const { data: rows, error: recError } = await svc
        .from("recommendations")
        .insert(
          drafts.map((d, i) => ({
            run_id: runId,
            student_id: studentId,
            feature,
            title: d.title,
            details: collegeIds[i] ? { ...d.details, collegeId: collegeIds[i] } : d.details,
            why: d.why,
            sources: d.sources,
            // Earlier picks are newer, so a newest-first read keeps the match order.
            created_at: new Date(base - i).toISOString(),
          }))
        )
        .select(REC_COLUMNS);
      if (recError) throw fromPostgrest(recError);
      recommendations = (rows ?? []).map((r) => toDto(r as Row));
      const order = new Map(drafts.map((d, i) => [d.title, i]));
      recommendations.sort((a, b) => (order.get(a.title) ?? 0) - (order.get(b.title) ?? 0));
    }
    const counts: RunCounts = { parts: result.parts.length, objects, parsed: candidates.length, kept: kept.length, picked: drafts.length, stored: recommendations.length };
    request.log.info({ runId, counts }, "research run counts");
    await finish("succeeded", null, expiryFor(counts));
    return { runId, checkedAt: checkedAtOf(recommendations, created.created_at as string), cached: false, recommendations, contextUsed };
  } catch (err) {
    // Discarded and refused runs are already settled; anything else is a failure with a code, never a message.
    if (!settled) await finish("failed", err instanceof HttpError ? `http-${err.statusCode}` : "run-failed");
    throw err;
  }
}
