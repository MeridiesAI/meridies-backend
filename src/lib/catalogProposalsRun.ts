/**
 * Wiring for the catalog proposer (lib/catalogProposals.ts): the real fetcher (lib/links.ts `fetchSitePage`, the
 * SSRF-safe path every user-supplied URL takes), the model on the `catalog-proposals` system budget, and the
 * service-role store; or, with RESEARCH_FAKE=fixture in development/test only, the canned pages and answer.
 * Used by POST /internal/catalog/propose and scripts/ingest/propose-catalog.ts.
 */
import { env, hasAnthropic } from "../env.js";
import { FAST_MODEL, runSystemStructured } from "./anthropic.js";
import { proposeForCollege, supabaseStore, type ProposeResult, type ProposerDeps } from "./catalogProposals.js";
import { fakeAi, fakeFetchPage } from "./catalogProposalsFake.js";
import type { AiCall } from "./collegeSiteInfo.js";
import { fetchSitePage } from "./links.js";
import { researchFakeAllowed } from "./research/bootGuard.js";
import { serviceClient } from "./supabase.js";

type Log = { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };

export type ProposeOutcome =
  | { ok: true; result: ProposeResult }
  | { ok: false; reason: "no-service-role" | "no-key" | "not-found" | "no-website" | "failed"; message: string };

/** Whether this process runs the canned double: asked for, and NODE_ENV development or test (the raw value). */
export const proposerFake = () => researchFakeAllowed({ RESEARCH_FAKE: env.RESEARCH_FAKE, NODE_ENV: process.env.NODE_ENV });

export async function runCatalogProposal(collegeId: string, opts: { dryRun?: boolean }, log: Log): Promise<ProposeOutcome> {
  const svc = serviceClient();
  if (!svc) return { ok: false, reason: "no-service-role", message: "Proposals need the service role key" };
  const fake = proposerFake();
  if (!fake && !hasAnthropic) return { ok: false, reason: "no-key", message: "Set ANTHROPIC_API_KEY to read the school's pages" };

  const ai: AiCall = fake
    ? fakeAi
    : (o) =>
        runSystemStructured({
          job: "catalog-proposals",
          module: "catalog-proposals",
          model: FAST_MODEL,
          system: o.system,
          prompt: o.prompt,
          schema: o.schema,
          toolName: o.toolName,
          maxTokens: o.maxTokens,
          validate: o.validate,
          log,
        });
  const deps: ProposerDeps = {
    store: supabaseStore(svc),
    fetchPage: fake ? fakeFetchPage : fetchSitePage,
    ai,
    log: { warn: (o, m) => log.warn(o, m) },
  };
  try {
    return { ok: true, result: await proposeForCollege(collegeId, deps, opts) };
  } catch (err) {
    // The AI budget gate's refusals (429 at the system cap, 503 when it can't check) keep their status.
    if (err && typeof err === "object" && "statusCode" in err) throw err;
    const message = err instanceof Error ? err.message : "The proposal run failed";
    if (/isn't in the catalog/.test(message)) return { ok: false, reason: "not-found", message };
    if (/no website/.test(message)) return { ok: false, reason: "no-website", message };
    log.error({ err: message, collegeId }, "catalog proposals: run failed");
    return { ok: false, reason: "failed", message: "The school's pages couldn't be read for proposals. Try again later." };
  }
}
