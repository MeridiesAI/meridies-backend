/**
 * List-match scoring: how well a school fits one student beyond their odds, for ranking schools inside each Build
 * College Lists band (reach / target / likely). The band is still the fit model's (odds); this only orders schools
 * within it, and never removes one. Used only while LIST_MATCH_ENABLED=true (the loading is lib/listMatchLoad.ts).
 *
 * Everything here is pure: the student's feature weights from their card sort, a school's core score from its
 * `college_core_features` values, its opportunity score from its best-matching `college_opportunities`, the final
 * score, the order inside a band, the interest paragraph that is embedded, and the check on the explain step's
 * reasons. The vocabulary and numbers are lib/listContract.ts's; this file adds only the rules below.
 */

import {
  CARD_FEATURE_MAP,
  CORE_FEATURES,
  CORE_FEATURE_KEYS,
  MATCH_CONFIG,
  OPPORTUNITY_CATEGORIES,
  type CoreFeatureKey,
} from "./listContract.js";
import { RATINGS, type Rating } from "./preferences.js";

// ---- 1. The student's weights ----

/** A rating as a number: the strongest positive (love) +1 down to the strongest negative (really bad) -1, evenly. */
export const RATING_VALUE: Readonly<Record<Rating, number>> = Object.fromEntries(
  RATINGS.map((rating, i) => [rating, 1 - (2 * i) / (RATINGS.length - 1)])
) as Record<Rating, number>;

/**
 * A universal feature's weight when the student's cards say nothing about it, and the base their card moves. Half
 * of the strongest card's weight, so a student's stated preference counts for more than the default.
 */
export const UNIVERSAL_DEFAULT_WEIGHT = 0.5;

export type CardRating = { cardKey: string; rating: Rating };
export type FeatureWeights = Record<CoreFeatureKey, number>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Each rated card's value relative to the student's own average rating, rescaled so their most extreme card is
 * +1 or -1. A student who rates everything the same (loves everything) gets 0 on every card: nothing stands out.
 * Every rated card counts toward the average, mapped to a feature or not.
 */
export function cardSignals(ratings: CardRating[]): Map<string, number> {
  const byCard = new Map<string, number>();
  for (const r of ratings) {
    const v = RATING_VALUE[r.rating];
    if (typeof v === "number") byCard.set(r.cardKey, v);
  }
  if (byCard.size === 0) return new Map();
  const avg = mean([...byCard.values()]);
  const centered = [...byCard].map(([card, v]) => [card, v - avg] as const);
  const spread = Math.max(...centered.map(([, c]) => Math.abs(c)));
  if (spread < 1e-9) return new Map(centered.map(([card]) => [card, 0]));
  return new Map(centered.map(([card, c]) => [card, c / spread]));
}

/**
 * One weight per core feature, -1..1.
 *
 *   taste      the student's card for it (sign from CARD_FEATURE_MAP times the card's signal); 0 with no card, so
 *              no taste is guessed
 *   universal  UNIVERSAL_DEFAULT_WEIGHT plus the card's say, held to 0..1: a card can raise it or switch it off,
 *              never turn it against a school ("can only help a match")
 *
 * With no card sort every universal feature has the same positive weight and every taste feature 0. Two cards on
 * one feature are averaged.
 */
export function studentWeights(ratings: CardRating[]): FeatureWeights {
  const signals = cardSignals(ratings);
  const said = new Map<CoreFeatureKey, number[]>();
  for (const [card, link] of Object.entries(CARD_FEATURE_MAP)) {
    const s = signals.get(card);
    if (s === undefined) continue;
    said.set(link.feature, [...(said.get(link.feature) ?? []), link.sign * s]);
  }
  const weights = {} as FeatureWeights;
  for (const key of CORE_FEATURE_KEYS) {
    const card = said.has(key) ? mean(said.get(key)!) : 0;
    weights[key] = CORE_FEATURES[key].polarity === "universal" ? clamp(UNIVERSAL_DEFAULT_WEIGHT + card, 0, 1) : card;
  }
  return weights;
}

// ---- 2. A school's scores ----

/** A school's core feature values, 0-1; null or absent means unknown. */
export type FeatureValues = Partial<Record<CoreFeatureKey, number | null>>;

/**
 * Sum of weight x value over the features the school has a value for, over the sum of |weight| on those features,
 * mapped to 0-1. Unknown features are skipped (never read as 0). Null with no known feature or all weights 0.
 *
 * A value is centred first (2v - 1): 0 means the feature's absence or opposite (lib/listContract.ts), so a student
 * who wants less of something (a negative weight) scores a school that lacks it high. Uncentred, a student who
 * wants a fixed core curriculum (curriculum_flexibility 0) could never score any school above neutral.
 */
export function coreScore(weights: FeatureWeights, values: FeatureValues): number | null {
  let num = 0;
  let den = 0;
  for (const key of CORE_FEATURE_KEYS) {
    const v = values[key];
    const w = weights[key];
    if (v == null || !Number.isFinite(v) || !w) continue;
    num += w * (2 * clamp(v, 0, 1) - 1);
    den += Math.abs(w);
  }
  return den === 0 ? null : (num / den + 1) / 2;
}

/** One row of match_college_opportunities: an opportunity, its cosine similarity, and that times its prior weight. */
export type OpportunityHit = {
  id: string;
  name: string;
  category: string;
  quote: string | null;
  sourceUrl: string | null;
  similarity: number;
  weighted: number;
};

export type TopOpportunity = { id: string; name: string; category: string; quote: string | null; sourceUrl: string | null };

/**
 * A school's raw opportunity score: the average weighted similarity of its MATCH_CONFIG.topK most similar
 * opportunities, so forty weak matches can't outscore three strong ones. Only categories the contract knows count.
 * Null with none.
 */
export function opportunityRaw(hits: OpportunityHit[], topK: number = MATCH_CONFIG.topK): { raw: number | null; top: TopOpportunity[] } {
  const usable = hits
    .filter((h) => h.category in OPPORTUNITY_CATEGORIES && Number.isFinite(h.similarity) && Number.isFinite(h.weighted))
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(1, topK));
  if (usable.length === 0) return { raw: null, top: [] };
  return {
    raw: mean(usable.map((h) => h.weighted)),
    top: usable.map(({ id, name, category, quote, sourceUrl }) => ({ id, name, category, quote, sourceUrl })),
  };
}

/**
 * Min-max across the candidates: the best 1, the worst 0. When every candidate has the same raw score (or there is
 * one), there is nothing to tell them apart and each gets 0.5.
 */
export function rescale(raw: Map<string, number>): Map<string, number> {
  const values = [...raw.values()];
  if (values.length === 0) return new Map();
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  return new Map([...raw].map(([id, v]) => [id, span < 1e-12 ? 0.5 : (v - lo) / span]));
}

/** coreShare x core + opportunityShare x opportunity; one alone when the other is null; null when both are. */
export function combine(core: number | null, opportunity: number | null): number | null {
  if (core == null && opportunity == null) return null;
  if (core == null) return opportunity;
  if (opportunity == null) return core;
  return MATCH_CONFIG.coreShare * core + MATCH_CONFIG.opportunityShare * opportunity;
}

/** What the loader finds for one school, before the opportunity score is rescaled across the list. */
export type MatchInput = { core: number | null; opportunityRaw: number | null; topOpportunities: TopOpportunity[] };

/** What a pick carries: every score 0-1 (4 decimals), or null without data. */
export type MatchScore = {
  matchScore: number | null;
  coreScore: number | null;
  opportunityScore: number | null;
  topOpportunities: TopOpportunity[];
};

const round4 = (v: number | null) => (v == null ? null : Math.round(v * 10_000) / 10_000);

/** The scores of `ids` (the schools on this list), the opportunity score rescaled across them. */
export function finalizeMatch(inputs: ReadonlyMap<string, MatchInput>, ids: string[]): Map<string, MatchScore> {
  const raw = new Map<string, number>();
  for (const id of ids) {
    const r = inputs.get(id)?.opportunityRaw;
    if (r != null && Number.isFinite(r)) raw.set(id, r);
  }
  const scaled = rescale(raw);
  const out = new Map<string, MatchScore>();
  for (const id of ids) {
    const input = inputs.get(id);
    const core = input?.core ?? null;
    const opportunity = scaled.get(id) ?? null;
    out.set(id, {
      matchScore: round4(combine(core, opportunity)),
      coreScore: round4(core),
      opportunityScore: round4(opportunity),
      topOpportunities: input?.topOpportunities ?? [],
    });
  }
  return out;
}

/**
 * Orders schools inside each band by match score, best first; schools with no score follow in the order they came
 * (the odds order), and ties keep it too. A school never changes band, and each band keeps the same places in the
 * list, so the bands interleave exactly as before.
 */
export function rankWithinBands<T extends { fit: string }>(picks: T[], scoreOf: (p: T) => number | null): T[] {
  const slots = new Map<string, number[]>();
  picks.forEach((p, i) => slots.set(p.fit, [...(slots.get(p.fit) ?? []), i]));
  const out = picks.slice();
  for (const idx of slots.values()) {
    const ordered = idx
      .map((i) => ({ p: picks[i], i, s: scoreOf(picks[i]) }))
      .sort((a, b) => Number(a.s === null) - Number(b.s === null) || (b.s ?? 0) - (a.s ?? 0) || a.i - b.i);
    idx.forEach((slot, k) => (out[slot] = ordered[k].p));
  }
  return out;
}

// ---- 3. The interest paragraph ----

/** The model reads about 400 words; the paragraph is cut well before, most telling parts first. */
export const INTEREST_MAX_CHARS = 1600;
export const INTEREST_MAX_ACTIVITIES = 8;

export type InterestInput = {
  majors: string[];
  /** The student's own one-line headline: the only free-text preference on the AI allowlist. */
  headline: string | null;
  activities: { name: string | null; position: string | null; category: string | null; description: string | null }[];
  /** The prompts of the cards the student rated "love". */
  lovedCards: string[];
};

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** `s` without any of `chars` at its end (a loop, not a regular expression: linear on any input). */
function trimEnd(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end).trimEnd();
}

/**
 * A short paragraph about what the student is drawn to: intended majors, their headline, activities, and the card
 * situations they loved. Empty when the record says nothing. It is only embedded in this process (never sent to a
 * model or stored); its hash keys the cached vector.
 */
export function interestParagraph(input: InterestInput): string {
  const parts: string[] = [];
  const majors = input.majors.map(clean).filter(Boolean);
  if (majors.length) parts.push(`Intended majors: ${majors.join(", ")}.`);
  const headline = trimEnd(clean(input.headline), ".!?");
  if (headline) parts.push(`${headline}.`);
  const activities = input.activities
    .slice(0, INTEREST_MAX_ACTIVITIES)
    .map((a) => {
      const kind = clean(a.category);
      const head = [[clean(a.name), clean(a.position)].filter(Boolean).join(", "), kind && `(${kind})`].filter(Boolean).join(" ");
      const desc = trimEnd(clean(a.description), ".;");
      return head && desc ? `${head}: ${desc}` : head || desc;
    })
    .filter(Boolean);
  if (activities.length) parts.push(`Activities: ${activities.join("; ")}.`);
  const loved = input.lovedCards.map(clean).filter(Boolean);
  if (loved.length) parts.push(`Loves: ${loved.join(" ")}`);
  const text = parts.join(" ");
  if (text.length <= INTEREST_MAX_CHARS) return text;
  const cut = text.slice(0, INTEREST_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > INTEREST_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trim();
}

/** pgvector's text form of a vector. */
export const vectorText = (v: number[]) => `[${v.join(",")}]`;

/** A vector back from PostgREST (pgvector's text form, or an array); null when it isn't `dim` finite numbers. */
export function parseVector(value: unknown, dim: number): number[] | null {
  let v: unknown = value;
  if (typeof value === "string") {
    try {
      v = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(v) || v.length !== dim) return null;
  const nums = v.map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

// ---- 4. The explain step's reasons ----

/**
 * Words that name a program, a facility or an opportunity. A reason that still holds one after the school's own
 * payload names are taken out is citing something it wasn't given. Whole words, a fixed alternation: linear time.
 */
const PROGRAM_WORDS =
  /\b(?:programs?|programmes?|institutes?|cent(?:er|re)s?|labs?|laborator(?:y|ies)|scholars?|fellowships?|initiatives?|co-?ops?|internships?|honou?rs|abroad|research|clinics?|incubators?|accelerators?|academ(?:y|ies)|concentrations?)\b/i;

const fold = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** One school's programs as the explain step's prompt names them: a key (unique in the prompt) and the name. */
export type ExplainProgram = { key: string; name: string };

/**
 * Whether a reason cites only its own school's programs: every key in `cites` is one of `own`, no other school's
 * program name appears in it, and with its own program names taken out it names no program at all. A reason for a
 * school with no programs in the payload may mention none.
 */
export function reasonCitesOnlyOwn(reason: string, cites: string[], own: ExplainProgram[], others: ExplainProgram[]): boolean {
  const ownKeys = new Set(own.map((p) => p.key));
  if (cites.some((c) => !ownKeys.has(c))) return false;
  const ownNames = new Set(own.map((p) => fold(p.name)).filter(Boolean));
  let text = fold(reason);
  for (const p of others) {
    const name = fold(p.name);
    if (name.length >= 4 && !ownNames.has(name) && text.includes(name)) return false;
  }
  for (const name of [...ownNames].sort((a, b) => b.length - a.length)) text = text.split(name).join(" ");
  return !PROGRAM_WORDS.test(text);
}
