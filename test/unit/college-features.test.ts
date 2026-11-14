import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import {
  buildExtractionRequest,
  embeddingHash,
  firstSentences,
  formatReport,
  groundExtraction,
  lowYieldReason,
  MISSES_TO_DEACTIVATE,
  opportunityKey,
  planOpportunities,
  processCollege,
  runCollegeFeatures,
  shownPages,
  toBatchRequest,
  type CollegeWrite,
  type ExistingOpportunity,
  type ExtractCall,
  type ExtractionRequest,
  type FeatureDeps,
  type FeatureStore,
  type GroundedOpportunity,
  type PageWrite,
} from "../../src/lib/ingest/collegeFeatures.js";
import {
  cleanPageText,
  contentHash,
  crawlCollege,
  HostThrottle,
  parseRobots,
  parseSitemap,
  pickChildSitemaps,
  pickPages,
  robotsAllows,
  robotsPatternMatches,
  type CrawlFetchers,
  type CrawlResult,
  type CrawledPage,
} from "../../src/lib/ingest/siteCrawl.js";
import { extractLinks, extractMainText, linkError, type SitePage } from "../../src/lib/links.js";
import { CORE_FEATURE_KEYS } from "../../src/lib/listContract.js";
import { BUDGET_MS, CAP_BUDGET_MS, elapsed } from "./regex-dos-helpers.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/college-features/${name}`, import.meta.url), "utf8");

const HONORS = "https://www.example.edu/academics/honors-college";
const RESEARCH = "https://www.example.edu/research/undergraduate-research";
const ABROAD = "https://www.example.edu/study-abroad";

/** A page as the crawler keeps it: main text, cleaned, hashed. */
function crawled(url: string, html: string, topic: CrawledPage["topic"] = "academics"): CrawledPage {
  const text = cleanPageText(extractMainText(html));
  return { url, title: null, text, chars: text.length, hash: contentHash(text), topic };
}

const threePages = () => [crawled(HONORS, fixture("honors.html"), "honors"), crawled(RESEARCH, fixture("research.html"), "research"), crawled(ABROAD, fixture("abroad.html"), "abroad")];
const answer = () => JSON.parse(fixture("answer.json")) as Record<string, unknown>;

// ---- Grounding ---------------------------------------------------------------------------------

test("grounding keeps what the pages quote and drops made-up quotes, unknown keys and unknown categories", () => {
  const g = groundExtraction(answer(), shownPages(threePages()));

  assert.deepEqual(
    g.features.map((f) => [f.key, f.value, f.sourceUrl]),
    [
      ["small_classes", 0.8, HONORS],
      ["undergrad_research", 0.9, RESEARCH],
    ]
  );
  assert.deepEqual(
    g.opportunities.map((o) => [o.name, o.category, o.sourceUrl]),
    [
      ["The Honors College", "academic_program", HONORS],
      ["Summer Undergraduate Research Fellowship (SURF)", "research", RESEARCH],
      ["Global Semester", "global", ABROAD],
    ]
  );
  assert.deepEqual(g.dropped, {
    unknownKey: 2, // campus_vibes, __proto__
    unknownCategory: 1, // nightlife
    unknownPage: 0,
    noQuote: 3, // a quote that is on no page, one cited to the wrong page, the Fake Fellowship
    nameNotOnPage: 1, // Ivy Leadership Institute
    madeUpFigure: 1, // "15 departments" is on the honors page, not the research page it cites
    invalid: 1, // residential 1.4
    duplicate: 2, // a second small_classes, "the honors college" again
  });
});

test("a quote must be on the page it cites, not just somewhere in the run", () => {
  const pages = shownPages(threePages());
  const raw = {
    core_features: [{ key: "small_classes", value: 0.7, quote: "small seminars of no more than 15 students", source_url: ABROAD }],
    opportunities: [{ name: "Global Semester", category: "global", description: "x", quote: "partner universities in 40 countries", source_url: HONORS }],
  };
  const g = groundExtraction(raw, pages);
  assert.equal(g.features.length, 0);
  assert.equal(g.opportunities.length, 0);
  assert.equal(g.dropped.noQuote, 2);
});

test("a page the run didn't read can't be cited, and a malformed answer is an empty one", () => {
  const pages = shownPages(threePages());
  const g = groundExtraction(
    { core_features: [{ key: "small_classes", value: 0.7, quote: "small seminars of no more than 15 students", source_url: "https://www.example.edu/elsewhere" }] },
    pages
  );
  assert.equal(g.dropped.unknownPage, 1);
  for (const bad of [null, "text", 42, [], { core_features: "x", opportunities: {} }]) {
    const e = groundExtraction(bad, pages);
    assert.equal(e.features.length + e.opportunities.length, 0);
  }
});

test("a short or folded-away quote is not evidence; quote marks, dashes, case and spacing fold", () => {
  const pages = shownPages([{ url: HONORS, text: "Students live on campus — all four years “guaranteed”." }]);
  const ok = groundExtraction(
    { core_features: [{ key: "residential", value: 1, quote: 'LIVE ON CAMPUS - all four   years "guaranteed"', source_url: HONORS }] },
    pages
  );
  assert.equal(ok.features.length, 1);
  const short = groundExtraction({ core_features: [{ key: "residential", value: 1, quote: "on campus", source_url: HONORS }] }, pages);
  assert.equal(short.dropped.noQuote, 1);
});

test("descriptions are cut to two sentences; values round to two decimals", () => {
  const g = groundExtraction(answer(), shownPages(threePages()));
  assert.equal(g.opportunities[0]!.description, "Small seminars taught by full-time faculty. Students live together in their first year.");
  const v = groundExtraction(
    { core_features: [{ key: "small_classes", value: 0.666666, quote: "small seminars of no more than 15 students", source_url: HONORS }] },
    shownPages(threePages())
  );
  assert.equal(v.features[0]!.value, 0.67);
});

test("every key the contract has is accepted and nothing else", () => {
  const page = { url: HONORS, text: "This sentence is long enough to quote on the page." };
  const raw = {
    core_features: [...CORE_FEATURE_KEYS, "toString", "constructor", "SMALL_CLASSES"].map((key) => ({
      key,
      value: 0.5,
      quote: "long enough to quote on the page",
      source_url: HONORS,
    })),
  };
  const g = groundExtraction(raw, shownPages([page]));
  assert.deepEqual(g.features.map((f) => f.key), CORE_FEATURE_KEYS);
  assert.equal(g.dropped.unknownKey, 3);
});

test("firstSentences skips abbreviations and stops after n", () => {
  assert.equal(firstSentences("Dr. Lee runs it. Students join in fall. More here.", 2), "Dr. Lee runs it. Students join in fall.");
  assert.equal(firstSentences("Ranked by U.S. News each year. It is open to all. Third.", 2), "Ranked by U.S. News each year. It is open to all.");
  assert.equal(firstSentences("One sentence only", 2), "One sentence only");
  assert.equal(firstSentences("Students go. They learn. Then more.", 1), "Students go.");
});

test("worst-case descriptions and keys are read in linear time", () => {
  const dots = "a. ".repeat(100_000);
  assert.ok(elapsed(() => firstSentences(dots, 2)) < BUDGET_MS);
  const marks = "&-'’".repeat(50_000);
  assert.ok(elapsed(() => opportunityKey(marks)) < BUDGET_MS);
});

// ---- The Batch-ready request -------------------------------------------------------------------

test("the request is plain data and maps one to one onto a Message Batches entry", () => {
  const shown = shownPages(threePages());
  const req = buildExtractionRequest({ id: "11111111-1111-4111-8111-111111111111", name: "Example <State>" }, shown, "claude-haiku-4-5");
  assert.ok(req.prompt.includes(`<page url="${HONORS}">`));
  assert.ok(req.prompt.includes("College: Example ‹State›"), "a name can't open a tag");
  assert.ok(!/<page[^>]*>[^]*<\/?page[^>]*>[^]*<\/page>/.test(req.prompt.replace(/<page url="[^"]*">|<\/page>/g, "")), "page text can't close its block");

  const b = toBatchRequest(req);
  assert.equal(b.custom_id, req.customId);
  assert.equal(b.params.model, "claude-haiku-4-5");
  assert.equal(b.params.max_tokens, req.maxTokens);
  assert.deepEqual(b.params.tool_choice, { type: "tool", name: req.toolName });
  assert.deepEqual(b.params.messages, [{ role: "user", content: req.prompt }]);
  assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(b.custom_id), "a valid batch custom_id");
});

test("page text is defanged and cut before the model sees it, and grounding checks the same text", () => {
  const long = { url: HONORS, text: `<script>x</script> ${"word ".repeat(3000)}` };
  const [shown] = shownPages([long]);
  assert.ok(!shown!.text.includes("<"));
  assert.ok(shown!.text.length <= 6000);
});

// ---- The upsert diff ---------------------------------------------------------------------------

const opp = (name: string, sourceUrl = RESEARCH, description: string | null = "What it is."): GroundedOpportunity => ({
  name,
  category: "research",
  description,
  quote: "a quote",
  sourceUrl,
});
const row = (id: string, name: string, o: Partial<ExistingOpportunity> = {}): ExistingOpportunity => ({
  id,
  name,
  source_url: RESEARCH,
  content_hash: embeddingHash({ name, description: "What it is." }),
  missed_runs: 0,
  active: true,
  ...o,
});
const keys = (...urls: string[]) => new Set(urls.map((u) => new URL(u).hostname.replace(/^www\./, "") + new URL(u).pathname));

test("upsert diff: new, seen (by normalized name), missed once, missed twice, and rows on pages not read", () => {
  const existing = [
    row("a", "Summer Undergraduate Research Fellowship"),
    row("b", "Center for Undergraduate Research"),
    row("c", "Research Scholars", { missed_runs: 1 }),
    row("d", "Global Semester", { source_url: ABROAD }),
    row("e", "Old Program", { active: false }),
  ];
  const found = [opp("THE summer undergraduate research fellowship"), opp("Peer Mentors")];
  const plan = planOpportunities(existing, found, keys(RESEARCH));

  assert.deepEqual(plan.inserts.map((o) => o.name), ["Peer Mentors"]);
  assert.deepEqual(plan.seen.map((s) => [s.id, s.reembed]), [["a", true]]); // the name's text changed, so a new vector
  assert.deepEqual(plan.missed, [
    { id: "b", missedRuns: 1, deactivate: false },
    { id: "c", missedRuns: MISSES_TO_DEACTIVATE, deactivate: true },
  ]);
  // d: its page wasn't read this run. e: already inactive and not found. Neither moves.
});

test("a row seen with the same text keeps its vector; an inactive row seen again comes back", () => {
  const existing = [row("a", "Global Semester"), row("z", "Honors College", { active: false, missed_runs: 2 })];
  const plan = planOpportunities(existing, [opp("Global Semester"), opp("The Honors College")], keys(RESEARCH));
  assert.deepEqual(plan.seen.map((s) => [s.id, s.reembed]), [["a", false], ["z", true]]);
  assert.equal(plan.inserts.length, 0);
});

test("opportunityKey folds case, accents, punctuation, '&' and a leading 'the'", () => {
  assert.equal(opportunityKey("The Honors College"), opportunityKey("honors college"));
  assert.equal(opportunityKey("Co-op & Internships"), "co op and internships");
  assert.equal(opportunityKey("Études Program"), opportunityKey("etudes program"));
  assert.notEqual(opportunityKey("Honors College"), opportunityKey("Honors Program"));
});

// ---- One college, run after run (in-memory store) ----------------------------------------------

type StoredOpp = ExistingOpportunity & { category: string; description: string | null; embedding: number[] | null; last_seen_at: string };

function memoryStore() {
  const pages = new Map<string, string>();
  const features = new Map<string, { value: number; quote: string }>();
  const opps: StoredOpp[] = [];
  let nextId = 1;
  const writes: string[] = [];
  const store: FeatureStore = {
    async sourcePages() {
      return [...pages.entries()].map(([url, content_hash]) => ({ url, content_hash }));
    },
    async opportunities() {
      return opps.map((o) => ({ ...o }));
    },
    async save(_id, w: CollegeWrite) {
      writes.push("save");
      for (const f of w.features) features.set(f.key, { value: f.value, quote: f.quote });
      for (const o of w.inserts) {
        opps.push({ id: String(nextId++), name: o.name, category: o.category, description: o.description, source_url: o.sourceUrl, content_hash: o.contentHash, embedding: o.embedding, missed_runs: 0, active: true, last_seen_at: w.at });
      }
      for (const s of w.seen) {
        const r = opps.find((o) => o.id === s.id)!;
        Object.assign(r, { name: s.found.name, description: s.found.description, source_url: s.found.sourceUrl, last_seen_at: w.at, active: true, missed_runs: 0 });
        if (s.reembedded) Object.assign(r, { embedding: s.found.embedding, content_hash: s.found.contentHash });
        if (s.stale) r.content_hash = null;
      }
      for (const m of w.missed) {
        const r = opps.find((o) => o.id === m.id)!;
        r.missed_runs = m.missedRuns;
        if (m.deactivate) r.active = false;
      }
      for (const p of w.pages) pages.set(p.url, p.hash);
    },
    async touchPages(_id, ps: PageWrite[]) {
      writes.push("touch");
      for (const p of ps) pages.set(p.url, p.hash);
    },
  };
  return { store, pages, features, opps, writes };
}

const crawlOf = (pages: CrawledPage[]): CrawlResult => ({
  domain: "example.edu",
  robots: "read",
  sitemapUrls: 12,
  homeLinks: 40,
  candidates: 12,
  pages,
  skipped: {},
  stop: null,
});

function deps(store: FeatureStore, crawl: () => CrawlResult, answers: unknown[]) {
  const requests: ExtractionRequest[] = [];
  const embedded: string[] = [];
  const extract: ExtractCall = async (req) => {
    requests.push(req);
    return { raw: answers.shift(), usage: { inputTokens: 1000, outputTokens: 200 } };
  };
  const d: FeatureDeps = {
    store,
    crawl: async () => crawl(),
    extract,
    embed: async (texts) => {
      embedded.push(...texts);
      return texts.map(() => Array.from({ length: 384 }, () => 0.01));
    },
    model: "claude-haiku-4-5",
    now: () => new Date("2026-11-11T12:00:00Z"),
  };
  return { d, requests, embedded };
}

const college = { id: "22222222-2222-4222-8222-222222222222", name: "Example State University", website: "https://www.example.edu" };

test("a first run writes features, opportunities with vectors and the page hashes; an unchanged site costs no model call", async () => {
  const mem = memoryStore();
  const pages = threePages();
  const { d, requests, embedded } = deps(mem.store, () => crawlOf(pages), [answer()]);

  const first = await processCollege(college, d, {});
  assert.equal(first.status, "extracted");
  assert.equal(first.featuresFound, 2);
  assert.equal(first.inserted, 3);
  assert.equal(first.inputTokens, 1000);
  assert.deepEqual([...mem.features.keys()], ["small_classes", "undergrad_research"]);
  assert.equal(mem.opps.length, 3);
  assert.ok(mem.opps.every((o) => o.embedding?.length === 384 && o.content_hash));
  assert.ok(embedded.includes("Global Semester: A semester at a partner university in one of 40 countries."));
  assert.equal(mem.pages.size, 3);

  const second = await processCollege(college, d, {});
  assert.equal(second.status, "unchanged");
  assert.equal(requests.length, 1, "no second model call");
  assert.deepEqual(mem.writes, ["save", "touch"]);

  const forced = await processCollege(college, { ...d, extract: async (req) => (requests.push(req), { raw: answer(), usage: null }) }, { force: true });
  assert.equal(forced.status, "extracted");
  assert.equal(forced.seen, 3);
  assert.equal(forced.inserted, 0);
});

test("only changed pages are read; missed on two runs in a row deactivates, seen again brings it back", async () => {
  const mem = memoryStore();
  let pages = threePages();
  const { d, requests } = deps(mem.store, () => crawlOf(pages), []);
  const surfOnly = (answer().opportunities as unknown[]).filter((o) => (o as { name: string }).name.startsWith("Summer"));
  const withoutSurf = { core_features: [], opportunities: [] };

  // Run 1: everything.
  d.extract = async (req) => (requests.push(req), { raw: answer(), usage: null });
  await processCollege(college, d, {});
  const surf = () => mem.opps.find((o) => o.name.startsWith("Summer"))!;
  const global = () => mem.opps.find((o) => o.name === "Global Semester")!;

  // Run 2: the research page changed and no longer names SURF.
  const changeResearch = (extra: string) => {
    const html = fixture("research.html").replace("</main>", `<p>${extra}</p></main>`);
    pages = [pages[0]!, crawled(RESEARCH, html, "research"), pages[2]!];
  };
  changeResearch("Updated in October.");
  d.extract = async (req) => (requests.push(req), { raw: withoutSurf, usage: null });
  const r2 = await processCollege(college, d, {});
  assert.equal(r2.pagesRead, 1);
  assert.ok(requests.at(-1)!.prompt.includes(RESEARCH) && !requests.at(-1)!.prompt.includes(HONORS), "only the changed page");
  assert.deepEqual([surf().missed_runs, surf().active], [1, true]);
  assert.deepEqual([global().missed_runs, global().active], [0, true], "its page wasn't read");

  // Run 3: changed again, still not there: the second miss in a row.
  changeResearch("Updated in November.");
  const r3 = await processCollege(college, d, {});
  assert.equal(r3.deactivated, 1);
  assert.deepEqual([surf().missed_runs, surf().active], [2, false]);

  // Run 4: back on the page.
  changeResearch("Updated in December.");
  d.extract = async (req) => (requests.push(req), { raw: { core_features: [], opportunities: surfOnly }, usage: null });
  const r4 = await processCollege(college, d, {});
  assert.equal(r4.seen, 1);
  assert.deepEqual([surf().missed_runs, surf().active], [0, true]);
  assert.equal(mem.opps.length, 3, "never a second row for the same name");
});

test("an answer without both lists is a failed college: nothing is marked missed or written", async () => {
  const mem = memoryStore();
  const { d } = deps(mem.store, () => crawlOf(threePages()), [answer()]);
  await processCollege(college, d, {});
  const before = JSON.stringify(mem.opps);
  const changed = [crawled(HONORS, fixture("honors.html").replace("</main>", "<p>New line.</p></main>"), "honors"), ...threePages().slice(1)];
  for (const raw of [{ core_features: [] }, "I can't help with that.", null]) {
    const again = deps(mem.store, () => crawlOf(changed), [raw]);
    const r = await processCollege(college, again.d, {});
    assert.equal(r.status, "failed");
    assert.equal(JSON.stringify(mem.opps), before);
  }
  assert.deepEqual(mem.writes, ["save"]);
});

test("a dry run extracts and reports but writes nothing", async () => {
  const mem = memoryStore();
  const { d, embedded } = deps(mem.store, () => crawlOf(threePages()), [answer()]);
  const r = await processCollege(college, d, { dryRun: true });
  assert.equal(r.status, "extracted");
  assert.equal(r.inserted, 3);
  assert.deepEqual(mem.writes, []);
  assert.equal(embedded.length, 0);
  assert.equal(mem.pages.size, 0);
});

test("an embedding failure saves the rows without vectors, so a later run embeds them", async () => {
  const mem = memoryStore();
  const { d } = deps(mem.store, () => crawlOf(threePages()), [answer()]);
  d.embed = async () => {
    throw new Error("model download failed");
  };
  const r = await processCollege(college, d, {});
  assert.equal(r.inserted, 3);
  assert.equal(r.embedded, 0);
  assert.ok(mem.opps.every((o) => o.embedding === null && o.content_hash === null));
  const plan = planOpportunities(mem.opps, groundExtraction(answer(), shownPages(threePages())).opportunities, new Set());
  assert.ok(plan.seen.every((s) => s.reembed));
});

test("the run stops on a budget refusal and after three failures in a row; the rest read 'stopped'", async () => {
  const mem = memoryStore();
  const many = Array.from({ length: 5 }, (_, i) => ({ ...college, id: `3333333${i}-3333-4333-8333-333333333333`, name: `College ${i}` }));

  const budget = deps(mem.store, () => crawlOf(threePages()), []);
  budget.d.extract = async () => {
    throw new HttpError(429, "The college-features AI budget for this month is used up.");
  };
  const r1 = await runCollegeFeatures(many, budget.d, { concurrency: 1 });
  assert.match(r1.stoppedBy ?? "", /budget/);
  assert.deepEqual(r1.colleges.map((c) => c.status), ["stopped", "stopped", "stopped", "stopped", "stopped"]);

  const down = deps(memoryStore().store, () => crawlOf(threePages()), []);
  down.d.extract = async () => {
    throw new HttpError(503, "The AI service is unavailable right now.");
  };
  const r2 = await runCollegeFeatures(many, down.d, { concurrency: 1 });
  assert.deepEqual(r2.colleges.map((c) => c.status), ["failed", "failed", "failed", "stopped", "stopped"]);
  assert.match(r2.stoppedBy ?? "", /3 colleges failed in a row/);
});

test("the yield report totals the run and lists low-yield colleges", async () => {
  const thin = [crawled(HONORS, "<main><p>Loading…</p></main>")];
  const mem = memoryStore();
  const colleges = [college, { ...college, id: "44444444-4444-4444-8444-444444444444", name: "Script University" }];
  const { d } = deps(mem.store, () => crawlOf(threePages()), [answer()]);
  let n = 0;
  d.crawl = async () => (n++ === 0 ? crawlOf(threePages()) : { ...crawlOf(thin), homeLinks: 3 });
  const r = await runCollegeFeatures(colleges, d, { concurrency: 1 });
  assert.equal(r.totals.extracted, 1);
  assert.equal(r.totals.featuresFound, 2);
  assert.equal(r.totals.inputTokens, 1000);
  assert.deepEqual(r.lowYield.map((l) => l.name), ["Script University"]);
  const text = formatReport(r);
  assert.match(text, /Low yield \(1\)/);
  assert.match(text, /Script University .*: pages have almost no text/);
});

test("lowYieldReason names the likely cause", () => {
  const base = { status: "extracted" as const, pagesFetched: 5, textChars: 20_000, featuresFound: 3, opportunitiesFound: 4 };
  assert.equal(lowYieldReason(base, 40), null);
  assert.match(lowYieldReason({ ...base, textChars: 1_000 }, 40)!, /almost no text/);
  assert.match(lowYieldReason({ ...base, status: "no-pages", pagesFetched: 0, textChars: 0 }, 4)!, /JavaScript/);
  assert.match(lowYieldReason({ ...base, status: "no-pages", pagesFetched: 0, textChars: 0 }, 80)!, /no academics/);
  assert.match(lowYieldReason({ ...base, featuresFound: 0, opportunitiesFound: 0 }, 40)!, /found nothing/);
});

// ---- robots.txt --------------------------------------------------------------------------------

test("robots.txt: the '*' group's rules, longest match wins, an anchored Allow, Crawl-delay and Sitemap lines", () => {
  const r = parseRobots(fixture("robots.txt"));
  assert.equal(r.crawlDelaySeconds, 2);
  assert.deepEqual(r.sitemaps, ["https://www.example.edu/sitemap-index.xml", "https://cdn.other-host.com/sitemap.xml"]);
  const ok = (path: string) => robotsAllows(r, new URL(`https://www.example.edu${path}`));
  assert.equal(ok("/academics"), true);
  assert.equal(ok("/search?q=honors"), false);
  assert.equal(ok("/private/research-centers"), false);
  assert.equal(ok("/private/public-page"), true);
  assert.equal(ok("/private/public-page/more"), false);
  assert.equal(ok("/robots.txt"), true);
});

test("robots.txt: a group naming us wins over '*'; consecutive User-agent lines share a group", () => {
  const ours = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: Meridies-LinkReader/1.0\nAllow: /\nDisallow: /admin\n");
  assert.equal(robotsAllows(ours, new URL("https://x.edu/academics")), true);
  assert.equal(robotsAllows(ours, new URL("https://x.edu/admin/users")), false);
  const shared = parseRobots("User-agent: OtherBot\nUser-agent: *\nDisallow: /x # comment\n");
  assert.equal(robotsAllows(shared, new URL("https://x.edu/x/y")), false);
  const none = parseRobots("User-agent: OtherBot\nDisallow: /\n");
  assert.equal(robotsAllows(none, new URL("https://x.edu/anything")), true);
  const empty = parseRobots("User-agent: *\nDisallow:\n");
  assert.equal(robotsAllows(empty, new URL("https://x.edu/anything")), true);
  const tie = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\n");
  assert.equal(robotsAllows(tie, new URL("https://x.edu/page")), true);
});

test("robots.txt patterns: '*' and '$'", () => {
  assert.equal(robotsPatternMatches("/*.pdf$", "/a/b.pdf"), true);
  assert.equal(robotsPatternMatches("/*.pdf$", "/a/b.pdf?x=1"), false);
  assert.equal(robotsPatternMatches("/search*q=", "/search/all?q=x"), true);
  assert.equal(robotsPatternMatches("/a*b*c", "/axxbyyc"), true);
  assert.equal(robotsPatternMatches("/a*b*c", "/axxcyyb"), false);
  assert.equal(robotsPatternMatches("/fish$", "/fish"), true);
  assert.equal(robotsPatternMatches("/fish$", "/fishes"), false);
  assert.equal(robotsPatternMatches("*", "/anything"), true);
});

test("robots.txt worst cases finish in linear time", () => {
  const pattern = `/${"*a".repeat(250)}$`;
  const path = `/${"a".repeat(2000)}b`;
  assert.ok(elapsed(() => robotsPatternMatches(pattern, path)) < BUDGET_MS);
  const big = `User-agent: *\n${"Disallow: /*a*a*a*a*a*a*a*a*a*b$\n".repeat(2000)}`;
  const r = parseRobots(big);
  assert.ok(elapsed(() => robotsAllows(r, new URL(`https://x.edu/${"a".repeat(1900)}`))) < BUDGET_MS);
  assert.ok(elapsed(() => parseRobots("#".repeat(500_000) + "\n:".repeat(200_000))) < BUDGET_MS * 2);
});

// ---- Sitemaps ----------------------------------------------------------------------------------

test("a sitemap index lists child sitemaps (CDATA too); news and events children are skipped", () => {
  const idx = parseSitemap(fixture("sitemap-index.xml"));
  assert.equal(idx.kind, "index");
  assert.deepEqual(idx.urls, [
    "https://www.example.edu/sitemap-news.xml",
    "https://www.example.edu/sitemap-pages.xml",
    "https://www.example.edu/sitemap-events.xml",
  ]);
  assert.deepEqual(pickChildSitemaps(idx.urls, "example.edu"), ["https://www.example.edu/sitemap-pages.xml"]);
});

test("a urlset's <loc>s, entities decoded, image <loc>s ignored; a text sitemap's lines", () => {
  const pages = parseSitemap(fixture("sitemap-pages.xml"));
  assert.equal(pages.kind, "urlset");
  assert.equal(pages.urls.length, 12);
  assert.ok(pages.urls.includes("https://www.example.edu/academics/majors?ref=a&utm=b"));
  assert.ok(!pages.urls.some((u) => u.endsWith("lab.jpg")));
  assert.deepEqual(parseSitemap("https://a.edu/x\nnot a url\n https://a.edu/y \n").urls, ["https://a.edu/x", "https://a.edu/y"]);
  assert.deepEqual(parseSitemap("<urlset><location>https://a.edu/no</location><loc>https://a.edu/yes</loc></urlset>").urls, ["https://a.edu/yes"]);
});

test("sitemap worst cases finish in linear time", () => {
  assert.ok(elapsed(() => parseSitemap("<loc".repeat(500_000))) < BUDGET_MS);
  assert.ok(elapsed(() => parseSitemap("<locx>".repeat(300_000))) < BUDGET_MS);
  assert.ok(elapsed(() => parseSitemap(`<urlset>${"<loc>https://a.edu/p</loc>".repeat(60_000)}</urlset>`)) < CAP_BUDGET_MS);
});

// ---- Picking pages -----------------------------------------------------------------------------

test("pages are picked by topic, one of each first; news, graduate, files, other hosts and short scores are skipped", () => {
  const urls = parseSitemap(fixture("sitemap-pages.xml")).urls;
  const picks = pickPages(urls.map((url) => ({ url, text: "", from: "sitemap" as const })), "example.edu", 16);
  assert.deepEqual(
    picks.map((p) => [p.topic, new URL(p.url).pathname]),
    [
      ["research", "/research/undergraduate-research"],
      ["honors", "/academics/honors-college"],
      ["experiential", "/career-center/internships"],
      ["abroad", "/study-abroad"],
      ["research", "/private/research-centers"],
    ]
  );
  assert.equal(pickPages(urls.map((url) => ({ url, text: "", from: "sitemap" as const })), "example.edu", 2).length, 2);
});

test("link words count when the path says nothing; shallow pages beat deep ones", () => {
  const picks = pickPages(
    [
      { url: "https://www.example.edu/node/123", text: "Undergraduate Research", from: "home" },
      { url: "https://www.example.edu/a/b/c/d/research", text: "", from: "sitemap" },
      { url: "https://www.example.edu/research", text: "", from: "sitemap" },
      { url: "https://www.example.edu/node/9", text: "Faculty-led Study Abroad", from: "home" },
      { url: "https://law.example.edu/research", text: "", from: "home" },
      { url: "https://www.example.edu/summer-research", text: "", from: "sitemap" },
    ],
    "example.edu",
    10
  );
  // The link "Undergraduate Research" (7, one off for being link words) beats a bare /research path (5); the
  // deep page scores too low, and the law school's site is skipped.
  assert.deepEqual(picks.map((p) => new URL(p.url).pathname), ["/node/123", "/node/9", "/research", "/summer-research"]);
});

test("50,000 sitemap entries are picked from quickly", () => {
  const many = Array.from({ length: 50_000 }, (_, i) => ({ url: `https://www.example.edu/section-${i % 50}/research-page-${i}`, text: "", from: "sitemap" as const }));
  assert.ok(elapsed(() => pickPages(many, "example.edu", 16)) < CAP_BUDGET_MS);
});

// ---- Text --------------------------------------------------------------------------------------

test("main text drops menus, asides and footers; a page without <main> keeps its body without menus", () => {
  const honors = extractMainText(fixture("honors.html"));
  assert.match(honors, /small seminars of no more than 15 students/);
  assert.doesNotMatch(honors, /Apply|Privacy|Scholarships, Housing/);
  const noMain = extractMainText(
    `<html><head><title>T</title></head><body><nav><a href="/">Menu item</a></nav><div><p>${"Real words here. ".repeat(20)}</p></div><footer>Footer</footer></body></html>`
  );
  assert.match(noMain, /Real words here/);
  assert.doesNotMatch(noMain, /Menu item|Footer|<title>|T\n/);
  const tinyMain = extractMainText(`<body><main><p>Hi</p></main><div><p>${"Outside the main tag. ".repeat(20)}</p></div></body>`);
  assert.match(tinyMain, /Outside the main tag/);
  assert.ok(elapsed(() => extractMainText("<main".repeat(200_000))) < BUDGET_MS * 2);
});

test("the hash is of cleaned text: the same words in other markup or spacing hash the same", () => {
  const a = cleanPageText(extractMainText("<main><p>Small   classes.</p>\n\n<p>Taught by faculty.</p></main>"));
  const b = cleanPageText(extractMainText('<main class="x"><div>Small classes.</div><div>  Taught by faculty.  </div></main>'));
  assert.equal(a, "Small classes.\nTaught by faculty.");
  assert.equal(contentHash(a), contentHash(b));
  assert.match(contentHash(a), /^[0-9a-f]{64}$/);
});

// ---- Throttle ----------------------------------------------------------------------------------

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), at: () => t };
}

test("one request a second per host (www. and the bare name are one host); Crawl-delay stretches it", async () => {
  const clock = fakeClock();
  const th = new HostThrottle({ now: clock.now, sleep: clock.sleep });
  const times: string[] = [];
  for (const host of ["www.example.edu", "example.edu", "www.example.edu", "other.edu"]) {
    await th.wait(host);
    times.push(`${host}@${clock.at()}`);
  }
  assert.deepEqual(times, ["www.example.edu@0", "example.edu@1000", "www.example.edu@2000", "other.edu@2000"]);
  th.setInterval("other.edu", 5000);
  await th.wait("other.edu");
  await th.wait("other.edu");
  assert.equal(clock.at(), 2000 + 1000 + 5000);
});

// ---- The crawl, end to end on fixtures ----------------------------------------------------------

function sitePage(url: string, html: string): SitePage {
  const base = new URL(url);
  return { finalUrl: url, title: null, text: extractMainText(html), meta: {} as SitePage["meta"], links: extractLinks(html, base) };
}

function fakeSite(o: { robots?: () => string; pages?: Record<string, string>; redirects?: Record<string, string> } = {}) {
  const clock = fakeClock();
  const requests: Array<{ url: string; at: number }> = [];
  const pages: Record<string, string> = o.pages ?? {
    "https://www.example.edu/": fixture("home.html"),
    [HONORS]: fixture("honors.html"),
    [RESEARCH]: fixture("research.html"),
    [ABROAD]: fixture("abroad.html"),
  };
  const files: Record<string, string> = {
    "https://www.example.edu/sitemap-index.xml": fixture("sitemap-index.xml"),
    "https://www.example.edu/sitemap-pages.xml": fixture("sitemap-pages.xml"),
    // Where the crawler looks when robots.txt names no sitemap.
    "https://www.example.edu/sitemap.xml": fixture("sitemap-pages.xml"),
  };
  const hop = async (url: string, before: (u: URL) => Promise<void>) => {
    await before(new URL(url));
    requests.push({ url, at: clock.at() });
    const to = o.redirects?.[url];
    if (to) {
      await before(new URL(to));
      requests.push({ url: to, at: clock.at() });
      return to;
    }
    return url;
  };
  const fetchers: CrawlFetchers = {
    async fetchFile(url, kind, { beforeRequest }) {
      await hop(url, beforeRequest);
      if (kind === "robots") {
        if (!o.robots) return { finalUrl: url, text: fixture("robots.txt") };
        return { finalUrl: url, text: o.robots() };
      }
      const text = files[url];
      if (!text) throw linkError("link_not_found");
      return { finalUrl: url, text };
    },
    async fetchPage(url, { beforeRequest }) {
      const final = await hop(url, beforeRequest);
      const html = pages[final];
      if (!html) throw linkError("link_not_found");
      return sitePage(final, html);
    },
  };
  const throttle = new HostThrottle({ now: clock.now, sleep: clock.sleep });
  return { deps: { ...fetchers, throttle }, requests };
}

test("the crawl reads robots.txt, the sitemap index, the home page's links and the topic pages, politely", async () => {
  const site = fakeSite();
  const r = await crawlCollege("https://www.example.edu", site.deps, { maxPages: 10 });

  assert.equal(r.robots, "read");
  assert.equal(r.stop, null);
  assert.equal(r.sitemapUrls, 12);
  assert.ok(r.homeLinks! >= 4);
  assert.deepEqual(r.pages.map((p) => p.url).sort(), [ABROAD, HONORS, RESEARCH].sort());
  // /academics (from the home page) and /career-center/internships 404; /private/research-centers is disallowed.
  assert.deepEqual(r.skipped, { "not-found": 2, robots: 1 });
  assert.ok(!site.requests.some((q) => q.url.includes("/private/")), "a disallowed page is never requested");
  assert.ok(!site.requests.some((q) => q.url.includes("sitemap-news") || q.url.includes("other-host")));

  // Never two requests to one host less than a second apart, and two seconds once Crawl-delay: 2 is known.
  const www = site.requests.filter((q) => new URL(q.url).hostname === "www.example.edu").map((q) => q.at);
  for (let i = 1; i < www.length; i++) assert.ok(www[i]! - www[i - 1]! >= (i === 1 ? 1000 : 2000), `gap ${i}: ${www[i]! - www[i - 1]!}`);

  for (const p of r.pages) {
    assert.equal(p.hash, contentHash(p.text));
    assert.doesNotMatch(p.text, /Privacy|Home Academics/);
  }
});

test("a redirect off the school's site is refused before the request; a missing robots.txt allows all", async () => {
  const site = fakeSite({
    robots: () => {
      throw linkError("link_not_found");
    },
    redirects: { [ABROAD]: "https://evil.example.com/abroad" },
  });
  const r = await crawlCollege("www.example.edu", site.deps, { maxPages: 10 });
  assert.equal(r.robots, "missing");
  assert.ok(!r.pages.some((p) => p.url.includes("evil")));
  assert.equal(r.skipped["off-domain"], 1);
  assert.ok(!site.requests.some((q) => q.url.includes("evil")), "the off-site hop is never sent");
  // With no robots.txt the /private/ page is allowed (and 404s here).
  assert.equal(r.skipped.robots ?? 0, 0);
});

test("robots.txt that disallows us, that can't be read, or that asks for a long delay stops the crawl", async () => {
  const blocked = await crawlCollege("https://www.example.edu", fakeSite({ robots: () => "User-agent: meridies\nDisallow: /\n" }).deps, { maxPages: 10 });
  assert.equal(blocked.stop, "robots");
  assert.equal(blocked.pages.length, 0);

  const down = await crawlCollege(
    "https://www.example.edu",
    fakeSite({
      robots: () => {
        throw linkError("link_http_error");
      },
    }).deps,
    { maxPages: 10 }
  );
  assert.equal(down.robots, "unreadable");
  assert.equal(down.stop, "robots");

  const slow = await crawlCollege("https://www.example.edu", fakeSite({ robots: () => "User-agent: *\nCrawl-delay: 120\n" }).deps, { maxPages: 10 });
  assert.equal(slow.stop, "crawl-delay");

  const none = await crawlCollege(null, fakeSite().deps, { maxPages: 10 });
  assert.equal(none.stop, "no-website");
});

test("the crawl stops at maxPages", async () => {
  const r = await crawlCollege("https://www.example.edu", fakeSite().deps, { maxPages: 2 });
  assert.equal(r.pages.length, 2);
});
