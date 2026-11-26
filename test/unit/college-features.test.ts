import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import {
  buildExtractionRequest,
  embeddingHash,
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM,
  firstSentences,
  formatReport,
  groundExtraction,
  lowYieldReason,
  MISSES_TO_DEACTIVATE,
  nameIsNotUndergraduate,
  opportunityKey,
  planFeatures,
  planOpportunities,
  processCollege,
  quoteIsHeading,
  quoteNamesOpportunity,
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
import { CORE_FEATURE_KEYS, type CoreFeatureKey } from "../../src/lib/listContract.js";
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
    nameOnlyQuote: 0,
    quoteNotAbout: 0,
    headingOnly: 0,
    notUndergraduate: 0,
    offTopic: 1, // a second small_classes, quoting the senior thesis: nothing about class size
    invalid: 1, // residential 1.4
    duplicate: 1, // "the honors college" again
  });
});

// The first production run (5 colleges, 2026-11-24). Quotes are written in the shape of what that run stored.
const BERKELEY_UNITS = "https://vcresearch.berkeley.edu/research-units";
const CMU_CENTERS = "https://www.cmu.edu/research/centers-and-institutes.html";

test("an opportunity whose quote is only its name (a directory listing) is dropped, whatever the description says", () => {
  const pages = shownPages([
    {
      url: BERKELEY_UNITS,
      text:
        "Organized Research Units. Archaeological Research Facility Berkeley Center for Cosmological Physics " +
        "Berkeley Institute for Data Science (BIDS) Center for Labor Research and Education. " +
        "The Simons Institute for the Theory of Computing runs a summer program where undergraduates work with visiting researchers.",
    },
    { url: CMU_CENTERS, text: "Centers and Institutes. CyLab Security & Privacy Institute Robotics Institute Scott Institute for Energy Innovation" },
  ]);
  const opp = (name: string, quote: string, source_url: string) => ({
    name,
    category: "research",
    audience: "undergraduates",
    description: "Undergraduates can participate in its research projects.",
    quote,
    source_url,
  });
  const g = groundExtraction(
    {
      core_features: [],
      opportunities: [
        opp("Berkeley Center for Cosmological Physics", "Berkeley Center for Cosmological Physics", BERKELEY_UNITS),
        // The name and its acronym say no more than the name.
        opp("Berkeley Institute for Data Science", "Berkeley Institute for Data Science (BIDS)", BERKELEY_UNITS),
        // Case, "&" and punctuation fold.
        opp("CyLab Security & Privacy Institute", "CYLAB SECURITY & PRIVACY INSTITUTE", CMU_CENTERS),
        // A quote that says what it offers stays.
        opp(
          "Simons Institute for the Theory of Computing",
          "The Simons Institute for the Theory of Computing runs a summer program where undergraduates work",
          BERKELEY_UNITS
        ),
      ],
    },
    pages
  );
  assert.deepEqual(g.opportunities.map((o) => o.name), ["Simons Institute for the Theory of Computing"]);
  assert.equal(g.dropped.nameOnlyQuote, 3);
});

// The two re-runs after PR #212 (the same 5 colleges, 2026-11-24): what still got through.
const BC_SCHOOLS = "https://www.bc.edu/bc-web/schools.html";
const CORNELL_COURSES = "https://sha.cornell.edu/academics/courses";
const BERKELEY_PUBLIC = "https://www.berkeley.edu/about/public-programs";

/** An opportunity as the model returns it. `audience` null leaves the field out. */
const said = (name: string, quote: string, source_url: string, audience: string | null = "undergraduates") => ({
  name,
  category: "academic_program",
  ...(audience === null ? {} : { audience }),
  description: "Undergraduates can take part.",
  quote,
  source_url,
});

test("an opportunity that isn't for undergraduates is dropped: graduate and professional schools, single courses, faculty, school children and the public", () => {
  const pages = shownPages([
    {
      url: BC_SCHOOLS,
      text:
        "BC Law trains lawyers in the Jesuit tradition through its J.D. program. " +
        "Boston College Law School offers clinics for law students. " +
        "The Clough School of Theology and Ministry prepares graduate students for ministry. " +
        "The Global Faculty Seminar takes faculty members abroad each summer. " +
        "Pre-Law Advising helps undergraduates plan for law school applications. " +
        "Faculty-Led Programs Abroad let undergraduates spend three weeks abroad with a professor. " +
        "The Connell School of Nursing prepares undergraduates for nursing careers in its four-year program.",
    },
    {
      url: CORNELL_COURSES,
      text: "Introduction to Wines covers the major wine regions of the world in one semester. HADM 4300: Introduction to Wines meets twice a week in Statler Hall.",
    },
    {
      url: BERKELEY_PUBLIC,
      text:
        "The Lawrence Hall of Science is a public science center offering exhibits and programs for K-12 students and teachers. " +
        "The UC Botanical Garden is open to the public every day and holds plants from around the world. " +
        "The Pre-College Scholars program lets high school students take Berkeley courses in summer.",
    },
  ]);
  const g = groundExtraction(
    {
      core_features: [],
      opportunities: [
        // Caught by the name, whatever the model called the audience.
        said("BC Law", "BC Law trains lawyers in the Jesuit tradition through its J.D. program", BC_SCHOOLS),
        said("Boston College Law School", "Boston College Law School offers clinics for law students", BC_SCHOOLS),
        said("Clough School of Theology and Ministry", "The Clough School of Theology and Ministry prepares graduate students for ministry", BC_SCHOOLS),
        said("Global Faculty Seminar", "The Global Faculty Seminar takes faculty members abroad each summer", BC_SCHOOLS),
        said("Introduction to Wines", "Introduction to Wines covers the major wine regions of the world in one semester", CORNELL_COURSES),
        said("HADM 4300: Introduction to Wines", "HADM 4300: Introduction to Wines meets twice a week in Statler Hall", CORNELL_COURSES),
        said("Pre-College Scholars", "The Pre-College Scholars program lets high school students take Berkeley courses in summer", BERKELEY_PUBLIC),
        // Nothing in the name to check: the model's own label decides.
        said("Lawrence Hall of Science", "The Lawrence Hall of Science is a public science center offering exhibits and programs for K-12 students", BERKELEY_PUBLIC, "k12_or_public"),
        said("UC Botanical Garden", "The UC Botanical Garden is open to the public every day", BERKELEY_PUBLIC, "k12_or_public"),
        // For undergraduates, though the names hold "law", "faculty" and "school".
        said("Pre-Law Advising", "Pre-Law Advising helps undergraduates plan for law school applications", BC_SCHOOLS),
        said("Faculty-Led Programs Abroad", "Faculty-Led Programs Abroad let undergraduates spend three weeks abroad with a professor", BC_SCHOOLS),
        said("Connell School of Nursing", "The Connell School of Nursing prepares undergraduates for nursing careers in its four-year program", BC_SCHOOLS),
      ],
    },
    pages,
    { collegeName: "Boston College" }
  );
  assert.deepEqual(g.opportunities.map((o) => o.name), ["Pre-Law Advising", "Faculty-Led Programs Abroad", "Connell School of Nursing"]);
  assert.equal(g.dropped.notUndergraduate, 9);
  // The names the run judged not for undergraduates, so a stored row of the same name can be switched off.
  assert.equal(g.notForUndergraduates.length, 9);
  assert.ok(g.notForUndergraduates.includes("BC Law") && g.notForUndergraduates.includes("UC Botanical Garden"));

  // No audience, or one off the list, is a malformed item: dropped, but not a verdict that switches a stored row off.
  const unlabeled = groundExtraction(
    {
      core_features: [],
      opportunities: [
        said("Pre-Law Advising", "Pre-Law Advising helps undergraduates plan for law school applications", BC_SCHOOLS, null),
        said("Faculty-Led Programs Abroad", "Faculty-Led Programs Abroad let undergraduates spend three weeks abroad with a professor", BC_SCHOOLS, "everyone"),
      ],
    },
    pages
  );
  assert.equal(unlabeled.opportunities.length, 0);
  assert.equal(unlabeled.dropped.invalid, 2);
  assert.deepEqual(unlabeled.notForUndergraduates, []);
});

test("nameIsNotUndergraduate reads only what a name says for certain", () => {
  const not = [
    ["BC Law", "Boston College"],
    ["Berkeley Law", "University of California-Berkeley"],
    ["Duke Divinity", "Duke University"],
    ["Graduate School of Education"],
    ["Carroll School MBA Program"],
    ["Ph.D. Program in Economics"],
    ["Master's in Finance"],
    ["Postdoctoral Fellows Program"],
    ["School of Medicine"],
    ["Intro to Programming"],
    ["CS 1110 Introduction to Computing"],
    ["K-12 Outreach"],
    ["Workshops for Teachers"],
  ];
  for (const [name, college] of not) assert.equal(nameIsNotUndergraduate(name!, college), true, name);
  const ok = [
    ["Undergraduate Research Opportunities Program"],
    ["Graduate and Undergraduate Research Symposium"],
    ["Pre-Law Society"],
    ["Pre-Med and Pre-Law Advising for Law School and Medical School"],
    ["Faculty-Led Programs Abroad"],
    ["Combined Bachelor's/Master's Program"],
    ["Connell School of Nursing"],
    ["Duke Engage", "Duke University"],
    ["Environmental Law Minor", "Boston College"],
    ["Lawrence Hall of Science"],
    ["STEM Scholars"],
  ];
  for (const [name, college] of ok) assert.equal(nameIsNotUndergraduate(name!, college), false, name);
});

test("the prompt names what isn't an undergraduate opportunity and asks who each one is for", () => {
  const items = EXTRACTION_SCHEMA.properties.opportunities.items as unknown as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.ok(items.required.includes("audience"));
  assert.deepEqual(items.properties.audience!.enum, ["undergraduates", "graduate_or_professional", "faculty_or_staff", "k12_or_public"]);
  for (const words of [/graduate and professional schools/i, /single course/i, /faculty/i, /K-12/, /general public/i, /heading/i, /name it/i]) {
    assert.match(EXTRACTION_SYSTEM, words);
  }
});

test("an opportunity whose quote doesn't name it is dropped; a word of its own name or its acronym counts, the college's name doesn't", () => {
  const pages = shownPages([
    {
      url: BERKELEY_UNITS,
      text:
        "Archaeological Research Facility. Located here: Anthropology, Archaeology. " +
        "Berkeley Center for Cosmological Physics. Berkeley researchers welcome undergraduates into labs every summer. " +
        "Berkeley Institute for Data Science. BIDS runs weekly office hours for undergraduates. " +
        "Cornell Tradition Fellowship. The fellowship rewards students who work during college.",
    },
  ]);
  const g = groundExtraction(
    {
      core_features: [],
      opportunities: [
        // The second re-run's row: a directory line about where it is.
        said("Archaeological Research Facility", "Located here: Anthropology, Archaeology", BERKELEY_UNITS),
        // Only the college's name and generic words in common.
        said("Berkeley Center for Cosmological Physics", "Berkeley researchers welcome undergraduates into labs every summer", BERKELEY_UNITS),
        said("Berkeley Institute for Data Science", "BIDS runs weekly office hours for undergraduates", BERKELEY_UNITS),
        said("Cornell Tradition Fellowship", "The fellowship rewards students who work during college", BERKELEY_UNITS),
      ],
    },
    pages,
    { collegeName: "University of California-Berkeley" }
  );
  assert.deepEqual(g.opportunities.map((o) => o.name), ["Berkeley Institute for Data Science", "Cornell Tradition Fellowship"]);
  assert.equal(g.dropped.quoteNotAbout, 2);

  assert.equal(quoteNamesOpportunity("SURF pays students to do research all summer", "Summer Undergraduate Research Fellowship (SURF)"), true);
  // A name of generic words only must be in the quote whole.
  assert.equal(quoteNamesOpportunity("The Center for Undergraduate Research funds projects", "Center for Undergraduate Research"), true);
  assert.equal(quoteNamesOpportunity("Undergraduate research is funded in every college", "Center for Undergraduate Research"), false);
});

test("a quote that is only a heading is dropped, for a feature or an opportunity", () => {
  const CMU_ABROAD = "https://www.cmu.edu/studyabroad/";
  const pages = shownPages([
    {
      url: CMU_ABROAD,
      text:
        "Study Abroad\nGlobal Engagement and Study Abroad\nOver 60% of undergraduates study abroad before they graduate.\n" +
        "Research Units: Archaeological Research Facility\nArchaeological Research Facility",
    },
  ]);
  const g = groundExtraction(
    {
      core_features: [
        // The re-run's row: CMU study_abroad 0.5 on the page's title alone.
        { key: "study_abroad", value: 0.5, quote: "Study Abroad", source_url: CMU_ABROAD },
        { key: "study_abroad", value: 0.6, quote: "Global Engagement and Study Abroad", source_url: CMU_ABROAD },
        { key: "study_abroad", value: 0.8, quote: "Over 60% of undergraduates study abroad before they graduate.", source_url: CMU_ABROAD },
      ],
      opportunities: [said("Archaeological Research Facility", "Research Units: Archaeological Research Facility", CMU_ABROAD)],
    },
    pages
  );
  assert.deepEqual(g.features.map((f) => [f.key, f.value]), [["study_abroad", 0.8]]);
  assert.equal(g.opportunities.length, 0);
  assert.equal(g.dropped.headingOnly, 3);
  assert.equal(g.dropped.duplicate, 0);

  for (const h of ["Study Abroad", "STUDY ABROAD", "Global Engagement and Study Abroad", "Housing", "Undergraduate Research Opportunities Program (UROP)"]) {
    assert.equal(quoteIsHeading(h), true, h);
  }
  for (const s of ["Over 60% study abroad.", "Co-op is required.", "Class Size: 18", "Most classes have fewer than 20 students."]) {
    assert.equal(quoteIsHeading(s), false, s);
  }
});

test("a feature whose quote isn't about that feature is dropped; the first on-topic quote for a key wins", () => {
  const CMU = "https://www.cmu.edu/academics/interdisciplinary-programs.html";
  const CORNELL = "https://www.cornell.edu/about/";
  const BC = "https://www.bc.edu/bc-web/about.html";
  const pages = shownPages([
    {
      url: CMU,
      text: "Carnegie Mellon students can pursue a double major or an additional major in another college. Every undergraduate completes general education requirements set by their home college.",
    },
    {
      url: CORNELL,
      text: "Cornell is a privately endowed research university and a partner of the State University of New York. All first-year students live on campus in residence halls on North Campus.",
    },
    {
      url: BC,
      text: "Boston College is committed to the formation of the whole person, intellectually, socially and spiritually. More than half of undergraduates study abroad before they graduate.",
    },
  ]);
  const g = groundExtraction(
    {
      core_features: [
        // The three the first run stored: a double-major sentence, and two sentences about something else entirely.
        { key: "curriculum_flexibility", value: 1, quote: "students can pursue a double major or an additional major in another college", source_url: CMU },
        { key: "residential", value: 0.7, quote: "Cornell is a privately endowed research university and a partner of the State University of New York", source_url: CORNELL },
        { key: "study_abroad", value: 0.8, quote: "committed to the formation of the whole person, intellectually, socially and spiritually", source_url: BC },
        // On-topic quotes for the same keys.
        { key: "curriculum_flexibility", value: 0.3, quote: "completes general education requirements set by their home college", source_url: CMU },
        { key: "residential", value: 0.9, quote: "All first-year students live on campus in residence halls", source_url: CORNELL },
        { key: "study_abroad", value: 0.9, quote: "More than half of undergraduates study abroad before they graduate", source_url: BC },
      ],
      opportunities: [],
    },
    pages
  );
  assert.deepEqual(
    g.features.map((f) => [f.key, f.value]),
    [
      ["curriculum_flexibility", 0.3],
      ["residential", 0.9],
      ["study_abroad", 0.9],
    ]
  );
  assert.equal(g.dropped.offTopic, 3);
  assert.equal(g.dropped.duplicate, 0);
});

test("the topic check folds case and dashes, and reads a worst-case quote in linear time", () => {
  const page = { url: HONORS, text: "Nearly every student LIVES ON‑CAMPUS for four years. " + "a".repeat(400) };
  const g = groundExtraction(
    { core_features: [{ key: "residential", value: 0.9, quote: "every student LIVES ON‑CAMPUS for four years", source_url: HONORS }], opportunities: [] },
    shownPages([page])
  );
  assert.equal(g.features.length, 1);
  const worst = "1".repeat(290);
  const pageW = { url: HONORS, text: `fewer than ${worst} ${"seminar ".repeat(5)}` };
  assert.ok(
    elapsed(() => groundExtraction({ core_features: [{ key: "small_classes", value: 0.5, quote: `fewer than ${worst}`, source_url: HONORS }] }, shownPages([pageW]))) < BUDGET_MS
  );
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

/** One on-topic sentence per feature: each must pass its own topic check. */
const ON_TOPIC: Record<CoreFeatureKey, string> = {
  small_classes: "Most classes have fewer than 20 students.",
  undergrad_research: "Undergraduates join faculty research labs from their first year.",
  coop_internships: "Every engineering student completes two co-op terms.",
  honors_program: "The Honors Program offers its own seminars and housing.",
  study_abroad: "Students can spend a semester overseas at a partner school.",
  curriculum_flexibility: "There is no core curriculum outside the major.",
  greek_life: "About a third of students join a fraternity or sorority.",
  athletics_culture: "Football Saturdays fill the stadium with fans.",
  preprofessional: "Employers recruit on campus every fall through the career center.",
  residential: "Housing is guaranteed for all four years.",
};

test("every key the contract has is accepted and nothing else", () => {
  const page = { url: HONORS, text: `${Object.values(ON_TOPIC).join(" ")} This sentence is long enough to quote on the page.` };
  const raw = {
    core_features: [
      ...CORE_FEATURE_KEYS.map((key) => ({ key, value: 0.5, quote: ON_TOPIC[key], source_url: HONORS })),
      ...["toString", "constructor", "SMALL_CLASSES"].map((key) => ({ key, value: 0.5, quote: "long enough to quote on the page", source_url: HONORS })),
    ],
  };
  const g = groundExtraction(raw, shownPages([page]));
  assert.deepEqual(g.features.map((f) => f.key), CORE_FEATURE_KEYS);
  assert.equal(g.dropped.unknownKey, 3);
  assert.equal(g.dropped.offTopic, 0);
});

test("no feature passes on a sentence about none of them", () => {
  const page = { url: HONORS, text: "This sentence is long enough to quote on the page." };
  const raw = { core_features: CORE_FEATURE_KEYS.map((key) => ({ key, value: 0.5, quote: "long enough to quote on the page", source_url: HONORS })) };
  const g = groundExtraction(raw, shownPages([page]));
  assert.equal(g.features.length, 0);
  assert.equal(g.dropped.offTopic, CORE_FEATURE_KEYS.length);
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

test("worst-case names and quotes for the audience, heading and naming checks are read in linear time", () => {
  const near = "graduat school of la faculty semina pre colleg ".repeat(5_000);
  assert.ok(elapsed(() => nameIsNotUndergraduate(near, near)) < BUDGET_MS);
  assert.ok(elapsed(() => nameIsNotUndergraduate(`AB${"1".repeat(100_000)}`)) < BUDGET_MS);
  const title = "Study Abroad and ".repeat(20_000);
  assert.ok(elapsed(() => quoteIsHeading(title)) < BUDGET_MS);
  const words = "Archaeological Research Facility ".repeat(10_000);
  assert.ok(elapsed(() => quoteNamesOpportunity(words, words, words)) < BUDGET_MS);
});

// ---- The Batch-ready request -------------------------------------------------------------------

test("the request is plain data and maps one to one onto a Message Batches entry", () => {
  const shown = shownPages(threePages());
  const req = buildExtractionRequest({ id: "11111111-1111-4111-8111-111111111111", name: "Example <State>" }, shown, "claude-haiku-4-5");
  assert.ok(req.prompt.includes(`<page url="${HONORS}">`));
  assert.ok(req.prompt.includes("College: Example ‹State›"), "a name can't open a tag");
  assert.ok(!/<page[^>]*>[^]*<\/?page[^>]*>[^]*<\/page>/.test(req.prompt.replace(/<page url="[^"]*">|<\/page>/g, "")), "page text can't close its block");

  // Temperature 0: repeat runs over the same pages should read them the same way.
  assert.equal(req.temperature, 0);

  const b = toBatchRequest(req);
  assert.equal(b.custom_id, req.customId);
  assert.equal(b.params.model, "claude-haiku-4-5");
  assert.equal(b.params.temperature, 0);
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

test("a stored row the run judged not for undergraduates is switched off at once, whatever page it was on", () => {
  const existing = [
    row("a", "BC Law", { source_url: "https://www.bc.edu/law" }),
    row("b", "Global Faculty Seminar"),
    row("c", "Honors Program"),
    row("d", "Lawrence Hall of Science"),
  ];
  // d is also found for undergraduates this run (under another page's wording): seen wins.
  const plan = planOpportunities(existing, [opp("Lawrence Hall of Science")], keys(), ["BC Law", "the global faculty seminar", "Lawrence Hall of Science"]);
  assert.deepEqual(plan.missed, [
    { id: "a", missedRuns: MISSES_TO_DEACTIVATE, deactivate: true },
    { id: "b", missedRuns: MISSES_TO_DEACTIVATE, deactivate: true },
  ]);
  assert.deepEqual(plan.seen.map((s) => s.id), ["d"]);
  // c: neither found nor judged, and its page wasn't read: untouched.
});

test("a stored feature whose page was read again and didn't confirm it is cleared; one on a page not read stays", () => {
  const existing = [
    { feature_key: "study_abroad", source_url: ABROAD },
    { feature_key: "small_classes", source_url: HONORS },
    { feature_key: "undergrad_research", source_url: RESEARCH },
    { feature_key: "residential", source_url: null },
  ];
  const found = [{ key: "undergrad_research" as const, value: 0.9, quote: "a quote", sourceUrl: RESEARCH }];
  // study_abroad: its page was read and nothing confirmed it. small_classes: its page wasn't read. undergrad_research:
  // confirmed. residential: no page on file to judge by.
  assert.deepEqual(planFeatures(existing, found, keys(ABROAD, RESEARCH)), ["study_abroad"]);
  // Confirmed from another page than the one on file: not cleared (the upsert moves it).
  assert.deepEqual(planFeatures([{ feature_key: "undergrad_research", source_url: HONORS }], found, keys(HONORS, RESEARCH)), []);
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
  const features = new Map<string, { value: number; quote: string; sourceUrl: string }>();
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
    async features() {
      return [...features.entries()].map(([feature_key, f]) => ({ feature_key, source_url: f.sourceUrl }));
    },
    async save(_id, w: CollegeWrite) {
      writes.push("save");
      for (const f of w.features) features.set(f.key, { value: f.value, quote: f.quote, sourceUrl: f.sourceUrl });
      for (const k of w.clearedFeatures) features.delete(k);
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

test("a re-read page that no longer supports a feature clears it; a dry run only counts it", async () => {
  const mem = memoryStore();
  let pages = threePages();
  const { d } = deps(mem.store, () => crawlOf(pages), []);
  d.extract = async () => ({ raw: answer(), usage: null });
  await processCollege(college, d, {});
  assert.deepEqual([...mem.features.keys()], ["small_classes", "undergrad_research"]);

  // The research page changed, and the answer no longer has undergrad_research (here: nothing at all).
  pages = [pages[0]!, crawled(RESEARCH, fixture("research.html").replace("</main>", "<p>Updated.</p></main>"), "research"), pages[2]!];
  d.extract = async () => ({ raw: { core_features: [], opportunities: [] }, usage: null });
  const dry = await processCollege(college, d, { dryRun: true });
  assert.equal(dry.featuresCleared, 1);
  assert.deepEqual([...mem.features.keys()], ["small_classes", "undergrad_research"], "a dry run writes nothing");

  const r = await processCollege(college, d, {});
  assert.equal(r.featuresCleared, 1);
  assert.deepEqual([...mem.features.keys()], ["small_classes"], "small_classes' page wasn't read: it stays");

  const run = await runCollegeFeatures([college], { ...d, crawl: async () => crawlOf(pages) }, { force: true });
  assert.equal(run.totals.featuresCleared, 1, "a forced re-read of the honors page without small_classes clears it too");
  assert.match(formatReport(run), /1 cleared/);
  assert.equal(mem.features.size, 0);
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
