/**
 * Retrieval fusion over the RAG port.
 *
 * One query misses what a counselor means as often as it hits: "ED" in the
 * question and "Early Decision" in the file, a pronoun where the document has
 * a course name. AxIS asks the port up to three ways at once (the question as
 * asked, its keywords with counselor shorthand expanded, and the named
 * schools with what is being asked about), then:
 *
 *  1. Reciprocal rank fusion: each passage scores sum(1 / (60 + rank)) over
 *     the lists it appears in, so agreement between queries beats one list's
 *     raw score, and scores from different queries never need calibrating.
 *  2. Near-duplicate removal: passages whose word 3-grams overlap more than
 *     80% (the same paragraph in two uploads, overlapping chunks) keep one.
 *  3. Maximal marginal relevance: pick passages one at a time, each time
 *     taking the best balance of relevance and difference from what is
 *     already picked (lambda 0.7), until k passages or the character budget.
 *
 * The result: fewer, more varied passages per prompt, so the model reads
 * less and misses less.
 */
import type { FastifyRequest } from "fastify";
import { TtlLru } from "./cache.js";
import type { Understanding } from "./nlu.js";
import { getRetrieval, type RetrievedChunk } from "./ports.js";
import { jaccard, shingles, tokens } from "./text.js";

const RRF_K = 60;
const DUP_THRESHOLD = 0.8;
const MMR_LAMBDA = 0.7;

export type Scored = { chunk: RetrievedChunk; score: number };

const key = (c: RetrievedChunk) => `${c.source}:${c.chunkId}`;

export function reciprocalRankFusion(lists: RetrievedChunk[][]): Scored[] {
  const acc = new Map<string, Scored>();
  for (const list of lists) {
    list.forEach((chunk, rank) => {
      const k = key(chunk);
      const prev = acc.get(k);
      const add = 1 / (RRF_K + rank + 1);
      if (prev) prev.score += add;
      else acc.set(k, { chunk, score: add });
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

export function dropNearDuplicates(items: Scored[], threshold = DUP_THRESHOLD): Scored[] {
  const kept: { item: Scored; sh: Set<string> }[] = [];
  for (const item of items) {
    const sh = shingles(item.chunk.text);
    if (kept.some((k) => jaccard(k.sh, sh) >= threshold)) continue;
    kept.push({ item, sh });
  }
  return kept.map((k) => k.item);
}

export function maximalMarginalRelevance(items: Scored[], k: number, budgetChars: number, lambda = MMR_LAMBDA): RetrievedChunk[] {
  if (!items.length) return [];
  const top = items[0]!.score || 1;
  const pool = items.map((i) => ({ ...i, rel: i.score / top, words: new Set(tokens(i.chunk.text)) }));
  const picked: typeof pool = [];
  let used = 0;
  while (picked.length < k && pool.length) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    pool.forEach((cand, idx) => {
      const sim = picked.length ? Math.max(...picked.map((p) => jaccard(p.words, cand.words))) : 0;
      const val = lambda * cand.rel - (1 - lambda) * sim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = idx;
      }
    });
    const [choice] = pool.splice(bestIdx, 1);
    if (!choice) break;
    const cost = Math.min(choice.chunk.text.length, 2_500);
    if (used + cost > budgetChars && picked.length) continue;
    picked.push(choice);
    used += cost;
  }
  return picked.map((p) => p.chunk);
}

const FILLER = /^(can you|could you|please|would you|tell me|show me|do you know|i want to know)\s+/i;

/** Up to three different ways of asking the port for the same thing. */
export function retrievalQueries(u: Understanding, studentNames: string[] = []): string[] {
  const nameWords = new Set(studentNames.flatMap((n) => tokens(n)));
  const strip = (s: string) =>
    s
      .split(/\s+/)
      .filter((w) => !nameWords.has(tokens(w)[0] ?? ""))
      .join(" ")
      .trim();
  const asked = strip(u.text.replace(FILLER, "").replace(/[?!.]+$/, ""));
  const keywords = u.keywords.filter((k) => !nameWords.has(k)).join(" ");
  const schools = u.colleges.length
    ? `${u.colleges.map((c) => c.name).join(" ")} ${u.keywords.filter((k) => !nameWords.has(k) && !u.colleges.some((c) => tokens(c.name).includes(k))).join(" ")}`
    : "";
  const seen = new Set<string>();
  return [asked, keywords, schools]
    .map((q) => q.replace(/\s+/g, " ").trim().slice(0, 300))
    .filter((q) => q.length >= 3 && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()));
}

const rawCache = new TtlLru<RetrievedChunk[]>(2_000, 120_000);

/** Raw port results for two minutes per caller, student and query, so a follow-up doesn't search again. */
async function searchCached(request: FastifyRequest, query: string, studentId: string | null, k: number, signal?: AbortSignal) {
  const ck = `${request.auth.userId}:${studentId ?? "-"}:${k}:${query.toLowerCase()}`;
  const hit = rawCache.get(ck);
  if (hit) return hit;
  const res = await getRetrieval().search(request, { query, studentId, k, signal });
  rawCache.set(ck, res);
  return res;
}

export async function fusedSearch(
  request: FastifyRequest,
  queries: string[],
  opts: { studentId: string | null; k?: number; perQuery?: number; budgetChars?: number; signal?: AbortSignal; extraLists?: RetrievedChunk[][] }
): Promise<RetrievedChunk[]> {
  const lists = await Promise.all(
    queries.map((q) => searchCached(request, q, opts.studentId, opts.perQuery ?? 8, opts.signal).catch((): RetrievedChunk[] => []))
  );
  const fused = dropNearDuplicates(reciprocalRankFusion([...lists, ...(opts.extraLists ?? [])]));
  return maximalMarginalRelevance(fused, opts.k ?? 6, opts.budgetChars ?? 12_000);
}
