import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { buildList, listPickDto, type ListCriteria, type ListPick, type ListSchool } from "../../src/lib/collegesV10.js";
import { CORE_FEATURE_KEYS, CORE_FEATURES, MATCH_CONFIG, type CoreFeatureKey } from "../../src/lib/listContract.js";
import { learningFeatures } from "../../src/lib/listLearning.js";
import {
  RATING_VALUE,
  UNIVERSAL_DEFAULT_WEIGHT,
  cardSignals,
  combine,
  coreScore,
  finalizeMatch,
  interestParagraph,
  INTEREST_MAX_CHARS,
  opportunityRaw,
  parseVector,
  rankWithinBands,
  reasonCitesOnlyOwn,
  rescale,
  studentWeights,
  type CardRating,
  type MatchInput,
  type OpportunityHit,
} from "../../src/lib/listMatch.js";
import { INTEREST_TABLE, interestHash, loadListMatch, resetListMatchForTest, type MatchLoadDeps } from "../../src/lib/listMatchLoad.js";
import type { Rating } from "../../src/lib/preferences.js";

// List matching (lib/listMatch.ts, lib/listMatchLoad.ts). Real feature data doesn't exist yet: everything here runs
// on fixtures, with no model and no database.

const universal = CORE_FEATURE_KEYS.filter((k) => CORE_FEATURES[k].polarity === "universal");
const taste = CORE_FEATURE_KEYS.filter((k) => CORE_FEATURES[k].polarity === "taste");
const cards = (o: Record<string, Rating>): CardRating[] => Object.entries(o).map(([cardKey, rating]) => ({ cardKey, rating }));

// ---- Weights ----

test("ratings map evenly from love (+1) to really bad (-1), using the card sort's own names", () => {
  assert.deepEqual(RATING_VALUE, { love: 1, good: 0.5, okay: 0, bad: -0.5, "really-bad": -1 });
});

test("no card sort: universal features share one positive weight, taste features are 0", () => {
  const w = studentWeights([]);
  for (const k of universal) assert.equal(w[k], UNIVERSAL_DEFAULT_WEIGHT, k);
  for (const k of taste) assert.equal(w[k], 0, k);
  assert.ok(UNIVERSAL_DEFAULT_WEIGHT > 0);
  // A sort that touches no mapped card says nothing about the features either.
  assert.deepEqual(studentWeights(cards({ "food-plan": "love", winter: "really-bad" })), w);
});

test("centering: the same pattern, shifted up or down the scale, gives the same weights", () => {
  const generous = studentWeights(cards({ greek: "love", sports: "good", core: "good", winter: "okay" }));
  const harsh = studentWeights(cards({ greek: "good", sports: "okay", core: "okay", winter: "bad" }));
  for (const k of CORE_FEATURE_KEYS) assert.ok(Math.abs(generous[k] - harsh[k]) < 1e-9, k);
});

test("centering: a student who loves everything gets no inflated weights (the defaults, nothing more)", () => {
  const all: Record<string, Rating> = {};
  for (const key of ["greek", "sports", "core", "research", "large-lecture", "preprofessional", "housing", "winter"]) all[key] = "love";
  assert.deepEqual(studentWeights(cards(all)), studentWeights([]));
  for (const v of cardSignals(cards(all)).values()) assert.equal(v, 0);
});

test("centering: the student's most extreme card is +1 or -1, whatever their scale", () => {
  const signals = cardSignals(cards({ greek: "good", sports: "okay", winter: "okay", flight: "okay" }));
  assert.equal(Math.max(...[...signals.values()].map(Math.abs)), 1);
  assert.equal(signals.get("greek"), 1);
  const w = studentWeights(cards({ greek: "good", sports: "okay", winter: "okay", flight: "okay" }));
  assert.equal(w.greek_life, 1);
  assert.ok(w.athletics_culture < 0 && w.athletics_culture > -1, "a card below this student's average leans negative");
});

test("the card's sign is applied: loving the housing card (one year only) means a less residential campus", () => {
  const w = studentWeights(cards({ housing: "love", greek: "okay", sports: "okay" }));
  assert.ok(w.residential < 0);
  const v = studentWeights(cards({ housing: "really-bad", greek: "okay", sports: "okay" }));
  assert.ok(v.residential > 0);
});

test("a universal feature is never weighted against a school: a card can raise it or switch it off", () => {
  const likesLectures = studentWeights(cards({ "large-lecture": "love", greek: "bad", sports: "bad" }));
  assert.equal(likesLectures.small_classes, 0);
  const hatesLectures = studentWeights(cards({ "large-lecture": "really-bad", greek: "good", sports: "good" }));
  assert.equal(hatesLectures.small_classes, 1);
  for (const k of universal) assert.ok(likesLectures[k] >= 0 && hatesLectures[k] >= 0, k);
});

// ---- Core score ----

test("core score: unknown features are skipped, not counted as 0", () => {
  const w = studentWeights([]);
  const known = coreScore(w, { small_classes: 1, undergrad_research: 1 });
  assert.equal(known, 1);
  assert.equal(coreScore(w, { small_classes: 1, undergrad_research: 1, study_abroad: null }), known, "null is unknown");
  assert.equal(coreScore(w, { small_classes: 1, undergrad_research: 1, honors_program: undefined }), known, "absent is unknown");
  assert.ok(coreScore(w, { small_classes: 1, undergrad_research: 1, study_abroad: 0 })! < known!, "a real 0 does count");
});

test("core score: null with no known feature, or when every known feature has weight 0", () => {
  assert.equal(coreScore(studentWeights([]), {}), null);
  assert.equal(coreScore(studentWeights([]), { greek_life: 1, athletics_culture: 0 }), null, "taste features carry no weight without a card sort");
});

test("core score is 0-1 and follows the student's direction on taste features", () => {
  const wantsFixedCore = studentWeights(cards({ core: "love", greek: "okay", sports: "okay" }));
  assert.ok(wantsFixedCore.curriculum_flexibility < 0);
  const fixed = coreScore(wantsFixedCore, { curriculum_flexibility: 0 })!;
  const open = coreScore(wantsFixedCore, { curriculum_flexibility: 1 })!;
  assert.ok(fixed > 0.5 && open < 0.5, "a school with the fixed core this student wants scores above neutral");
  for (const s of [fixed, open]) assert.ok(s >= 0 && s <= 1);
  const w = studentWeights([]);
  assert.equal(coreScore(w, { small_classes: 0 }), 0);
  assert.equal(coreScore(w, { small_classes: 0.5 }), 0.5);
});

// ---- Opportunity score ----

const hit = (id: string, similarity: number, category = "academic_program", weight = 1): OpportunityHit => ({
  id,
  name: `Program ${id}`,
  category,
  quote: null,
  sourceUrl: null,
  similarity,
  weighted: similarity * weight,
});

test("top K: a school with 40 weak matches loses to one with 3 strong", () => {
  const weak = Array.from({ length: 40 }, (_, i) => hit(`w${i}`, 0.3));
  const strong = [hit("s1", 0.9), hit("s2", 0.88), hit("s3", 0.86)];
  const a = opportunityRaw(weak);
  const b = opportunityRaw(strong);
  assert.equal(a.top.length, MATCH_CONFIG.topK);
  assert.ok(b.raw! > a.raw!);
  const scores = finalizeMatch(
    new Map<string, MatchInput>([
      ["many", { core: null, opportunityRaw: a.raw, topOpportunities: a.top }],
      ["few", { core: null, opportunityRaw: b.raw, topOpportunities: b.top }],
    ]),
    ["many", "few"]
  );
  assert.equal(scores.get("few")!.matchScore, 1);
  assert.equal(scores.get("many")!.matchScore, 0);
});

test("opportunity score: the K most similar count, each at its category's weight; unknown categories are left out", () => {
  const r = opportunityRaw([hit("a", 0.9, "community", 0.4), hit("b", 0.5), hit("c", 0.4), hit("d", 0.1), hit("x", 0.99, "mystery")]);
  assert.deepEqual(r.top.map((t) => t.id), ["a", "b", "c"]);
  assert.ok(Math.abs(r.raw! - (0.9 * 0.4 + 0.5 + 0.4) / 3) < 1e-9);
  assert.deepEqual(opportunityRaw([]), { raw: null, top: [] });
});

test("rescale: best 1, worst 0; no spread is 0.5", () => {
  assert.deepEqual([...rescale(new Map([["a", 1], ["b", 3], ["c", 2]]))], [["a", 0], ["b", 1], ["c", 0.5]]);
  assert.deepEqual([...rescale(new Map([["a", 0.7]]))], [["a", 0.5]]);
  assert.equal(rescale(new Map()).size, 0);
});

test("final score: the contract's shares, or one part alone when the other is missing", () => {
  assert.equal(combine(0.8, 0.4), MATCH_CONFIG.coreShare * 0.8 + MATCH_CONFIG.opportunityShare * 0.4);
  assert.equal(combine(0.8, null), 0.8);
  assert.equal(combine(null, 0.4), 0.4);
  assert.equal(combine(null, null), null);
});

// ---- Ranking in buildList ----

const school = (collegeId: string, admit: number): ListSchool => ({
  collegeId,
  slug: collegeId,
  name: `School ${collegeId}`,
  initials: null,
  brandColor: null,
  city: null,
  state: null,
  website: null,
  lat: 40,
  lng: -75,
  undergrads: 5000,
  setting: "Suburban",
  testPolicy: "optional",
  admit,
  satMid: 1400,
  gpaMid: null,
  needRating: null,
  largestGroupPct: null,
  fields: [],
  regularDeadline: null,
});

const CRITERIA: ListCriteria = {
  majors: [],
  sizes: [],
  settings: [],
  testOptional: null,
  miles: 500,
  origin: null,
  aid: "No preference",
  diversity: "No preference",
};
const STUDENT = { sat: 1400, gpaUnweighted: null };
// SAT at each school's middle, so odds = admit: reach under 35, target 35-69, likely 70+.
const SCHOOLS = [
  school("r1", 5), school("r2", 10), school("r3", 20), school("r4", 30),
  school("t1", 40), school("t2", 50), school("t3", 60), school("t4", 65),
  school("l1", 75), school("l2", 85), school("l3", 90),
];

const inputs = (o: Record<string, number>) =>
  new Map<string, MatchInput>(Object.entries(o).map(([id, core]) => [id, { core, opportunityRaw: null, topOpportunities: [] }]));

test("flag off: buildList without match data is exactly today's list (no match key on any pick)", () => {
  const today = buildList(STUDENT, SCHOOLS, CRITERIA);
  assert.deepEqual(buildList(STUDENT, SCHOOLS, CRITERIA, undefined), today);
  assert.deepEqual(today.picks.map((p) => p.school.collegeId), ["l3", "l2", "l1", "t4", "t3", "t2", "t1", "r4", "r3", "r2", "r1"]);
  for (const p of today.picks) assert.equal("match" in p, false);
});

test("flag off: a pick's answer and its learning snapshot have exactly the keys they had", () => {
  const [pick] = buildList(STUDENT, SCHOOLS, CRITERIA).picks;
  assert.deepEqual(Object.keys(listPickDto(pick)), [
    "collegeId", "slug", "name", "initials", "brandColor", "city", "state", "website", "miles", "size", "setting",
    "testPolicy", "regularDeadline", "fit",
  ]);
  assert.deepEqual(Object.keys(learningFeatures(pick, 1, 3, true)), [
    "admit", "satMid", "gpaMid", "needRating", "largestGroupPct", "undergrads", "setting", "testPolicy", "fields", "miles",
    "curated", "bandRank", "bandTotal",
  ]);
});

test("band order never changes: match scores reorder schools only inside their band, and drop none", () => {
  const off = buildList(STUDENT, SCHOOLS, CRITERIA);
  // Scores that would scramble the bands if sorted globally: the hardest reach scores best of all.
  const on = buildList(STUDENT, SCHOOLS, CRITERIA, inputs({ r1: 0.99, r4: 0.1, t1: 0.9, t4: 0.2, l1: 0.95, l3: 0.05 }));
  assert.equal(on.picks.length, off.picks.length);
  assert.deepEqual(on.picks.map((p) => p.fit), off.picks.map((p) => p.fit), "every position keeps its band");
  for (const fit of ["reach", "target", "likely"] as const) {
    const ids = (l: { picks: ListPick[] }) => l.picks.filter((p) => p.fit === fit).map((p) => p.school.collegeId).sort();
    assert.deepEqual(ids(on), ids(off), `${fit}: same schools`);
  }
  for (const p of on.picks) assert.equal(p.fit, off.picks.find((q) => q.school.collegeId === p.school.collegeId)!.fit);
  assert.deepEqual(on.relaxed, off.relaxed);
});

test("inside a band: scored schools by score, then unscored ones in the odds order", () => {
  const { picks } = buildList(STUDENT, SCHOOLS, CRITERIA, inputs({ r1: 0.9, r3: 0.4, t2: 0.3, t1: 0.8 }));
  const band = (fit: string) => picks.filter((p) => p.fit === fit).map((p) => p.school.collegeId);
  assert.deepEqual(band("reach"), ["r1", "r3", "r4", "r2"], "r4 then r2: their odds order");
  assert.deepEqual(band("target"), ["t1", "t2", "t4", "t3"]);
  assert.deepEqual(band("likely"), ["l3", "l2", "l1"], "no data at all: the odds order");
  assert.equal(picks.find((p) => p.school.collegeId === "r1")!.match!.matchScore, 0.9);
  assert.equal(picks.find((p) => p.school.collegeId === "l1")!.match!.matchScore, null);
});

test("flag on: a pick carries its scores to the answer and to the learning snapshot (numbers only)", () => {
  const top = [{ id: "o1", name: "Co-op Program", category: "career", quote: "Every student does two co-ops.", sourceUrl: "https://x.edu/coop" }];
  const m = new Map<string, MatchInput>([["t1", { core: 0.75, opportunityRaw: 0.6, topOpportunities: top }]]);
  const pick = buildList(STUDENT, SCHOOLS, CRITERIA, m).picks.find((p) => p.school.collegeId === "t1")!;
  const dto = listPickDto(pick);
  assert.equal(dto.matchScore, MATCH_CONFIG.coreShare * 0.75 + MATCH_CONFIG.opportunityShare * 0.5);
  assert.equal(dto.coreScore, 0.75);
  assert.equal(dto.opportunityScore, 0.5, "one school with opportunities: nothing to rescale against");
  assert.deepEqual(dto.topOpportunities, [{ name: "Co-op Program", category: "career", quote: "Every student does two co-ops.", sourceUrl: "https://x.edu/coop" }]);
  const f = learningFeatures(pick, 1, 4, false);
  assert.deepEqual([f.matchScore, f.coreScore, f.opportunityScore], [dto.matchScore, 0.75, 0.5]);
  assert.equal("topOpportunities" in f, false);
});

test("rankWithinBands keeps each band's slots in the flat list", () => {
  const picks = [
    { fit: "likely", id: "a", s: 0.1 },
    { fit: "reach", id: "b", s: null },
    { fit: "likely", id: "c", s: 0.9 },
    { fit: "reach", id: "d", s: 0.5 },
  ];
  assert.deepEqual(rankWithinBands(picks, (p) => p.s).map((p) => p.id), ["c", "d", "a", "b"]);
});

// ---- The interest paragraph ----

test("interest paragraph: majors first, then headline, activities and loved cards; empty when the record is", () => {
  const text = interestParagraph({
    majors: ["Mechanical Engineering", "  Physics "],
    headline: "Builds robots...",
    activities: [{ name: "Robotics Club", position: "Captain", category: "Robotics", description: "Led a team of 12 to state." }],
    lovedCards: ["Undergraduate research from first year, but you have to go and ask for it."],
  });
  assert.equal(
    text,
    "Intended majors: Mechanical Engineering, Physics. Builds robots. Activities: Robotics Club, Captain (Robotics): Led a team of 12 to state. " +
      "Loves: Undergraduate research from first year, but you have to go and ask for it."
  );
  assert.equal(interestParagraph({ majors: [], headline: null, activities: [], lovedCards: [] }), "");
});

test("interest paragraph: cut at a word before the model's limit", () => {
  const long = interestParagraph({ majors: ["Biology"], headline: null, activities: [], lovedCards: Array(200).fill("A card about something.") });
  assert.ok(long.length <= INTEREST_MAX_CHARS);
  assert.ok(long.startsWith("Intended majors: Biology."));
  assert.ok(!long.endsWith(" "));
  // A headline of nothing but punctuation is trimmed in a loop, not by a regular expression.
  const t0 = performance.now();
  interestParagraph({ majors: [], headline: `${".".repeat(50_000)}x${".".repeat(50_000)}`, activities: [], lovedCards: [] });
  assert.ok(performance.now() - t0 < 100);
});

test("parseVector reads pgvector's text form and refuses the wrong size", () => {
  assert.deepEqual(parseVector("[0.5,-1,2]", 3), [0.5, -1, 2]);
  assert.deepEqual(parseVector([1, 2, 3], 3), [1, 2, 3]);
  assert.equal(parseVector("[1,2]", 3), null);
  assert.equal(parseVector("not a vector", 3), null);
  assert.equal(parseVector(null, 3), null);
});

// ---- The explain step's check ----

const own = [{ key: "p1", name: "Cooperative Education Program" }];
const others = [{ key: "p2", name: "Honors College" }, { key: "p3", name: "Global Scholars" }];

test("explain: a reason may cite only programs in its own school's payload", () => {
  assert.equal(reasonCitesOnlyOwn("Admit rate near 40% and a suburban campus suit this student.", [], own, others), true);
  assert.equal(reasonCitesOnlyOwn("The Cooperative Education Program fits an engineering major.", ["p1"], own, others), true);
  assert.equal(reasonCitesOnlyOwn("Fits; see the cooperative  education program.", [], own, others), true, "named without a key, still its own");
  assert.equal(reasonCitesOnlyOwn("Strong fit through Global Scholars.", ["p3"], own, others), false, "another school's key");
  assert.equal(reasonCitesOnlyOwn("Strong fit through the Honors College.", [], own, others), false, "another school's program by name");
  assert.equal(reasonCitesOnlyOwn("Its research labs suit a physics major.", [], own, others), false, "a program it wasn't given");
  assert.equal(reasonCitesOnlyOwn("A big study abroad program.", [], [], others), false, "no payload: no programs at all");
  assert.equal(reasonCitesOnlyOwn("Fits the student's numbers.", ["p9"], own, others), false, "an unknown key");
});

// ---- Loading (fixtures for the database and the model) ----

type Answer = { data: unknown; error: unknown };
type Query = { table: string; filters: [string, unknown][] };

function fakeClient(answer: (q: Query) => Answer, rpc: (name: string, args: Record<string, unknown>) => Answer = () => ({ data: [], error: null })) {
  const store = new Map<string, Record<string, unknown>>();
  const calls = { rpc: 0, upserts: 0 };
  const builder = (q: Query) => {
    const b = {
      eq: (c: string, v: unknown) => (q.filters.push([c, v]), b),
      in: (c: string, v: unknown) => (q.filters.push([c, v]), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(answer(q)),
      then: (ok: (a: Answer) => unknown, no: (e: unknown) => unknown) => Promise.resolve(answer(q)).then(ok, no),
    };
    return b;
  };
  const client = {
    from: (table: string) => ({
      select: () => builder({ table, filters: [] }),
      upsert: (row: Record<string, unknown>) => {
        calls.upserts++;
        store.set(String(row.student_id), row);
        return Promise.resolve({ data: null, error: null });
      },
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.rpc++;
      return Promise.resolve(rpc(name, args));
    },
  };
  return { client: client as never, store, calls };
}

const STUDENT_ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A student with a headline, one activity and two rated cards; colleges A and B with features and opportunities. */
function world(opts: { headline?: string; featuresError?: unknown; rpcError?: unknown } = {}) {
  const db = fakeClient(
    (q) => {
      const first = q.filters[0]?.[1];
      switch (q.table) {
        case "student_preference_cards":
          return { data: [{ rating: "love", card: { card_key: "research", prompt: "Research from first year." } }, { rating: "bad", card: { card_key: "greek", prompt: "Greek life." } }], error: null };
        case "profiles":
          return { data: { headline: opts.headline ?? "Loves building robots" }, error: null };
        case "student_personal_details":
          return { data: { intended_majors: ["Mechanical Engineering"] }, error: null };
        case "activities":
          return { data: [{ name: "Robotics", position: "Captain", category: "Robotics", description: null }], error: null };
        case "college_core_features":
          if (opts.featuresError) return { data: null, error: opts.featuresError };
          assert.deepEqual(first, [A, B]);
          return {
            data: [
              { college_id: A, feature_key: "undergrad_research", value: 1 },
              { college_id: A, feature_key: "greek_life", value: 0 },
              { college_id: B, feature_key: "undergrad_research", value: 0.2 },
              { college_id: B, feature_key: "greek_life", value: null },
            ],
            error: null,
          };
        default:
          throw new Error(`unexpected table ${q.table}`);
      }
    },
    (name, args) => {
      assert.equal(name, "match_college_opportunities");
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      assert.equal(args.p_top_k, MATCH_CONFIG.topK);
      assert.equal((args.p_weights as Record<string, number>).academic_program, 1);
      return {
        data: [
          { college_id: B, opportunity_id: "o1", name: "Robotics Institute", category: "research", quote: "q", source_url: "https://b.edu", similarity: 0.9, weighted: 0.81 },
          { college_id: A, opportunity_id: "o2", name: "Marching Band", category: "arts_athletics", quote: null, source_url: null, similarity: 0.5, weighted: 0.2 },
        ],
        error: null,
      };
    }
  );
  return db;
}

function deps(db: ReturnType<typeof fakeClient>, svc: ReturnType<typeof fakeClient>, over: Partial<MatchLoadDeps> = {}) {
  const embedded: string[] = [];
  const d: MatchLoadDeps = {
    db: db.client,
    svc: svc.client,
    embed: async (texts) => {
      embedded.push(...texts);
      return texts.map(() => [1, 0, 0, 0]);
    },
    model: "test-model",
    dim: 4,
    log: { warn: () => {} },
    ...over,
  };
  return { d, embedded };
}

beforeEach(() => resetListMatchForTest());

test("loading: core and opportunity scores per college, from the student's own record", async () => {
  const db = world();
  const svc = fakeClient(() => ({ data: null, error: null }));
  const { d, embedded } = deps(db, svc);
  const m = (await loadListMatch(d, STUDENT_ID, [A, B, A]))!;
  assert.ok(m);
  assert.equal(embedded.length, 1);
  assert.match(embedded[0], /^Intended majors: Mechanical Engineering\. Loves building robots\. Activities: Robotics, Captain \(Robotics\)\. Loves: Research from first year\.$/);
  assert.ok(m.get(A)!.core! > m.get(B)!.core!, "research 1 and no Greek life beats research 0.2");
  assert.equal(m.get(A)!.opportunityRaw, 0.2);
  assert.equal(m.get(B)!.opportunityRaw, 0.81);
  assert.deepEqual(m.get(B)!.topOpportunities.map((o) => o.name), ["Robotics Institute"]);
});

test("loading: the vector is cached by student and content hash, and embedded again only when the profile changes", async () => {
  const svc = fakeClient((q) => ({ data: svcStore.get(String(q.filters[0]?.[1])) ?? null, error: null }));
  const svcStore = svc.store;
  const first = deps(world(), svc);
  await loadListMatch(first.d, STUDENT_ID, [A, B]);
  assert.equal(first.embedded.length, 1);
  const row = svcStore.get(STUDENT_ID)!;
  assert.equal(row.content_hash, interestHash("test-model", first.embedded[0]));
  assert.equal(row.embedding, "[1,0,0,0]");
  assert.equal(row.model, "test-model");

  const again = deps(world(), svc);
  await loadListMatch(again.d, STUDENT_ID, [A, B]);
  assert.equal(again.embedded.length, 0, "same paragraph: the cached vector");

  const changed = deps(world({ headline: "Now into marine biology" }), svc);
  await loadListMatch(changed.d, STUDENT_ID, [A, B]);
  assert.equal(changed.embedded.length, 1, "the profile changed: embedded again");
  assert.equal(svc.calls.upserts, 2);
  assert.equal(INTEREST_TABLE, "student_interest_embeddings");
});

test("loading: a slow model leaves this run without opportunity scores, and the vector is still cached", async () => {
  const svc = fakeClient(() => ({ data: null, error: null }));
  const { d } = deps(world(), svc, {
    deadlineMs: 5,
    embed: (texts) => new Promise((resolve) => setTimeout(() => resolve(texts.map(() => [0, 1, 0, 0])), 40)),
  });
  const m = (await loadListMatch(d, STUDENT_ID, [A, B]))!;
  assert.equal(m.get(A)!.opportunityRaw, null);
  assert.ok(m.get(A)!.core != null, "core scores still there");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(svc.store.get(STUDENT_ID)?.embedding, "[0,1,0,0]");
});

test("loading: one part failing leaves the other; both failing is null (the odds order); it never throws", async () => {
  const svc = fakeClient(() => ({ data: null, error: null }));
  const noFeatures = (await loadListMatch(deps(world({ featuresError: { code: "XX000" } }), svc).d, STUDENT_ID, [A, B]))!;
  assert.equal(noFeatures.get(A)!.core, null);
  assert.equal(noFeatures.get(B)!.opportunityRaw, 0.81);

  const noOpportunities = (await loadListMatch(deps(world({ rpcError: { code: "XX000" } }), svc).d, STUDENT_ID, [A, B]))!;
  assert.equal(noOpportunities.get(A)!.opportunityRaw, null);
  assert.ok(noOpportunities.get(A)!.core != null);

  const neither = await loadListMatch(deps(world({ featuresError: { code: "XX000" }, rpcError: { code: "XX000" } }), svc).d, STUDENT_ID, [A, B]);
  assert.equal(neither, null);

  const throwing = deps(world(), svc, { embed: () => Promise.reject(new Error("no model")) });
  const m = await loadListMatch(throwing.d, STUDENT_ID, [A, B]);
  assert.ok(m && m.get(A)!.core != null, "no model: core only");
});

test("loading: a missing migration warns once and that part isn't asked again for a while", async () => {
  const svc = fakeClient(() => ({ data: null, error: null }));
  const warnings: unknown[] = [];
  const log = { warn: (o: unknown) => void warnings.push(o) };
  const missing = world({ rpcError: { code: "PGRST202" } });
  await loadListMatch(deps(missing, svc, { log }).d, STUDENT_ID, [A, B]);
  assert.equal(missing.calls.rpc, 1);
  assert.equal(warnings.length, 1);
  await loadListMatch(deps(missing, svc, { log }).d, STUDENT_ID, [A, B]);
  assert.equal(missing.calls.rpc, 1, "paused");
});

test("loading: nothing to score is null", async () => {
  const svc = fakeClient(() => ({ data: null, error: null }));
  assert.equal(await loadListMatch(deps(world(), svc).d, STUDENT_ID, []), null);
});

test("every core feature key used in the fixtures is a real one", () => {
  for (const k of ["undergrad_research", "greek_life", "small_classes", "curriculum_flexibility"] as CoreFeatureKey[]) assert.ok(k in CORE_FEATURES);
});
