import assert from "node:assert/strict";
import { test } from "node:test";
import type { SitePage } from "../../src/lib/links.js";
import {
  currentCycle,
  factKey,
  groundCandidates,
  onSchoolDomain,
  pickProposalPages,
  proposeForCollege,
  schoolDomain,
  validCycle,
  validateSupplementPayload,
  type ProposalStore,
  type ProposerDeps,
  type ProposalRow,
} from "../../src/lib/catalogProposals.js";

const page = (url: string, text: string, links: { href: string; text: string }[] = []): SitePage => ({
  finalUrl: url,
  title: null,
  text,
  meta: { title: null, description: null, images: [], icons: [] } as unknown as SitePage["meta"],
  links,
});

// ---- Cycle and domain ---------------------------------------------------------------------

test("the current cycle starts on August 1", () => {
  assert.equal(currentCycle(new Date("2026-11-07T12:00:00Z")), "2026-2027");
  assert.equal(currentCycle(new Date("2027-07-31T12:00:00Z")), "2026-2027");
  assert.equal(currentCycle(new Date("2027-08-01T12:00:00Z")), "2027-2028");
});

test("a cycle is YYYY-YYYY with consecutive years", () => {
  assert.equal(validCycle("2026-2027"), true);
  assert.equal(validCycle("2026-27"), false);
  assert.equal(validCycle("2026-2028"), false);
  assert.equal(validCycle("2026-2026"), false);
  assert.equal(validCycle(""), false);
  assert.equal(validCycle(null), false);
});

test("the school's domain comes from its website, without www", () => {
  assert.equal(schoolDomain("https://www.mit.edu"), "mit.edu");
  assert.equal(schoolDomain("www.Stanford.edu/"), "stanford.edu");
  assert.equal(schoolDomain("https://admissions.example.edu/apply"), "admissions.example.edu");
  assert.equal(schoolDomain(null), null);
  assert.equal(schoolDomain("not a url"), null);
  assert.equal(schoolDomain("http://localhost"), null);
});

test("only the school's own domain and its subdomains are allowed", () => {
  assert.equal(onSchoolDomain("https://mit.edu/apply", "mit.edu"), true);
  assert.equal(onSchoolDomain("https://www.mit.edu/apply", "mit.edu"), true);
  assert.equal(onSchoolDomain("https://admissions.mit.edu/x", "mit.edu"), true);
  assert.equal(onSchoolDomain("https://mitadmissions.org/x", "mit.edu"), false);
  assert.equal(onSchoolDomain("https://evilmit.edu/x", "mit.edu"), false);
  assert.equal(onSchoolDomain("https://mit.edu.evil.example/x", "mit.edu"), false);
  assert.equal(onSchoolDomain("ftp://mit.edu/x", "mit.edu"), false);
  assert.equal(onSchoolDomain("https://user@evil.example/?mit.edu", "mit.edu"), false);
});

test("pages to read: the school's admissions, application and essay pages only", () => {
  const picked = pickProposalPages(
    [
      { href: "https://www.example.edu/news/2026/story", text: "News" },
      { href: "https://www.example.edu/admissions/apply", text: "How to apply" },
      { href: "https://apply.example.edu/supplemental-essays", text: "Supplemental essays" },
      { href: "https://other.example/example-edu-essays", text: "Essay prompts for Example U" },
      { href: "https://www.example.edu/admissions/testing", text: "Testing policy" },
      { href: "https://www.example.edu/brochure.pdf", text: "Admissions brochure" },
      { href: "https://www.example.edu/athletics", text: "Athletics" },
    ],
    "example.edu"
  );
  assert.ok(picked.includes("https://www.example.edu/admissions/apply"));
  assert.ok(picked.includes("https://apply.example.edu/supplemental-essays"));
  assert.ok(picked.includes("https://www.example.edu/admissions/testing"));
  assert.ok(!picked.some((u) => u.includes("other.example")), "another domain is never picked");
  assert.ok(!picked.some((u) => u.endsWith(".pdf") || u.includes("athletics") || u.includes("/news/")));
  assert.ok(picked.length <= 4);
});

// ---- Payload validation ----------------------------------------------------------------------

test("a supplement payload is checked: cycle, ranges, lengths", () => {
  const good = { cycle: "2026-2027", sortOrder: 1, title: "Why us", prompt: "Why do you want to attend?", wordLimit: 250 };
  assert.deepEqual(validateSupplementPayload(good), { ok: true, value: good });
  assert.deepEqual(validateSupplementPayload({ ...good, wordLimit: null }), { ok: true, value: { ...good, wordLimit: null } });
  for (const bad of [
    { ...good, cycle: "2026-27" },
    { ...good, sortOrder: -1 },
    { ...good, sortOrder: 51 },
    { ...good, sortOrder: 1.5 },
    { ...good, title: "" },
    { ...good, title: "x".repeat(121) },
    { ...good, prompt: "  " },
    { ...good, prompt: "x".repeat(2001) },
    { ...good, wordLimit: 0 },
    { ...good, wordLimit: 5001 },
    { ...good, extra: 1 },
    null,
    "a string",
  ]) {
    assert.equal(validateSupplementPayload(bad).ok, false, JSON.stringify(bad));
  }
});

// ---- Quote grounding -------------------------------------------------------------------------

const HOME = "https://www.example.edu/";
const ESSAYS = "https://apply.example.edu/essays";
const PAGES = [
  { url: HOME, text: "Welcome to Example University. Apply by January 5." },
  {
    url: ESSAYS,
    text:
      "Writing supplement for 2026-2027 applicants. Why Example. Prompt 1: Why do you want to attend Example University? (250 words) " +
      "We read the Common App personal statement carefully. " +
      "Applicants may self-report their test scores; official score reports are required only on enrolling.",
  },
];
const CTX = { domain: "example.edu", cycle: "2026-2027" };

test("a candidate is kept only when its quote is on the page it cites", () => {
  const raw = {
    personalStatementRead: { value: true, quote: "We read the Common App personal statement carefully.", sourceUrl: ESSAYS },
    testReporting: { value: "self-report", quote: "Applicants may self-report their test scores", sourceUrl: ESSAYS },
    supplements: [
      {
        sortOrder: 0,
        title: "Why Example",
        prompt: "Why do you want to attend Example University?",
        wordLimit: 250,
        quote: "Prompt 1: Why do you want to attend Example University? (250 words)",
        sourceUrl: ESSAYS,
        cycleStated: "2026-2027",
      },
      {
        sortOrder: 1,
        title: "Made up",
        prompt: "Describe a time you changed your mind.",
        wordLimit: 300,
        quote: "Prompt 2: Describe a time you changed your mind. (300 words)",
        sourceUrl: ESSAYS,
        cycleStated: null,
      },
    ],
  };
  const r = groundCandidates(raw, PAGES, CTX);
  assert.deepEqual(
    r.kept.map((c) => (c.field === "supplement" ? `supplement:${c.payload.sortOrder}` : `${c.field}:${c.value}`)),
    ["personal_statement_read:true", "test_reporting:self-report", "supplement:0"]
  );
  assert.equal(r.dropped.noQuote, 1, "the made-up prompt is dropped and counted");
  const s = r.kept.find((c) => c.field === "supplement");
  assert.ok(s && s.field === "supplement");
  assert.deepEqual(s.payload, { cycle: "2026-2027", sortOrder: 0, title: "Why Example", prompt: "Why do you want to attend Example University?", wordLimit: 250 });
  assert.equal(s.sourceUrl, ESSAYS);
});

test("a supplement title the page doesn't use is replaced with a plain one", () => {
  const r = groundCandidates(
    {
      supplements: [
        { sortOrder: 0, title: "Our invented label", prompt: "Why do you want to attend Example University?", wordLimit: 250, quote: "Prompt 1: Why do you want to attend Example University? (250 words)", sourceUrl: ESSAYS },
      ],
    },
    PAGES,
    CTX
  );
  assert.equal(r.kept.length, 1);
  const s = r.kept[0]!;
  assert.ok(s.field === "supplement" && s.payload.title === "Prompt 1");
});

test("a quote on a different page than the one cited, a missing quote or a short one is dropped", () => {
  const r = groundCandidates(
    {
      personalStatementRead: { value: true, quote: "We read the Common App personal statement carefully.", sourceUrl: HOME },
      testReporting: { value: "self-report", quote: "", sourceUrl: ESSAYS },
      supplements: [{ sortOrder: 1, title: "x", prompt: "Why", wordLimit: null, quote: "Why", sourceUrl: ESSAYS }],
    },
    PAGES,
    CTX
  );
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped.noQuote, 3);
});

test("a source off the school's domain, or a page that wasn't read, is dropped", () => {
  const r = groundCandidates(
    {
      personalStatementRead: { value: true, quote: "We read the Common App personal statement carefully.", sourceUrl: "https://essayguy.example/example-u" },
      testReporting: { value: "self-report", quote: "Applicants may self-report their test scores", sourceUrl: "https://www.example.edu/never-read" },
    },
    PAGES,
    CTX
  );
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped.offDomain, 1);
  assert.equal(r.dropped.noQuote, 1);
});

test("values the quote doesn't support, unknown values and other cycles are dropped", () => {
  const r = groundCandidates(
    {
      // "self-report" quoted, but labelled official-only.
      testReporting: { value: "official-only", quote: "Applicants may self-report their test scores", sourceUrl: ESSAYS },
      personalStatementRead: { value: "maybe", quote: "We read the Common App personal statement carefully.", sourceUrl: ESSAYS },
      supplements: [
        {
          sortOrder: 1,
          title: "Why Example",
          prompt: "Why do you want to attend Example University?",
          wordLimit: 250,
          quote: "Prompt 1: Why do you want to attend Example University? (250 words)",
          sourceUrl: ESSAYS,
          cycleStated: "2025-2026",
        },
        {
          sortOrder: 1,
          title: "Why Example",
          prompt: "Why do you want to attend Example University?",
          // A word limit the quote doesn't state.
          wordLimit: 650,
          quote: "Prompt 1: Why do you want to attend Example University? (250 words)",
          sourceUrl: ESSAYS,
        },
      ],
    },
    PAGES,
    CTX
  );
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped.invalid + r.dropped.otherCycle, 4);
  assert.equal(r.dropped.otherCycle, 1);
});

test("a malformed answer grounds to nothing and never throws", () => {
  for (const raw of [null, 1, "x", [], { supplements: "no" }, { supplements: [null, 1] }]) {
    const r = groundCandidates(raw, PAGES, CTX);
    assert.equal(r.kept.length, 0);
  }
});

// ---- Idempotency key ---------------------------------------------------------------------------

test("the idempotency key names the fact, not the wording around it", () => {
  const a = { field: "test_reporting" as const, value: "self-report", sourceUrl: ESSAYS, evidence: "q1" };
  const b = { ...a, sourceUrl: HOME, evidence: "another quote" };
  assert.equal(factKey("c1", a, "2026-2027"), factKey("c1", b, "2026-2027"));
  assert.match(factKey("c1", a, "2026-2027"), /^[0-9a-f]{64}$/);
  assert.notEqual(factKey("c1", a, "2026-2027"), factKey("c2", a, "2026-2027"));
  assert.notEqual(factKey("c1", a, "2026-2027"), factKey("c1", a, "2027-2028"));
  assert.notEqual(factKey("c1", a, "2026-2027"), factKey("c1", { ...a, value: "official-only" }, "2026-2027"));
  const s = { field: "supplement" as const, payload: { cycle: "2026-2027", sortOrder: 1, title: "Why", prompt: "Why do you want  to attend?", wordLimit: 250 }, sourceUrl: ESSAYS, evidence: "q" };
  const s2 = { ...s, payload: { ...s.payload, prompt: "why do you want to attend?" } };
  assert.equal(factKey("c1", s, "2026-2027"), factKey("c1", s2, "2026-2027"), "white space and case don't make a new fact");
  assert.notEqual(factKey("c1", s, "2026-2027"), factKey("c1", { ...s, payload: { ...s.payload, wordLimit: 300 } }, "2026-2027"));
  assert.equal(factKey("c1", s, "2026-2027"), factKey("c1", { ...s, payload: { ...s.payload, sortOrder: 4 } }, "2026-2027"), "the slot is assigned by us, not part of the fact");
});

// ---- The run -------------------------------------------------------------------------------------

function memoryStore(over: Partial<{ policies: Record<string, unknown> | null; supplements: Record<string, unknown>[] }> = {}) {
  const rows: ProposalRow[] = [];
  const store: ProposalStore = {
    college: async (id) => (id === "c1" ? { id: "c1", name: "Example University", website: "https://www.example.edu" } : null),
    current: async () => ({
      policies: over.policies ?? null,
      supplements: over.supplements ?? [],
      pendingSupplements: rows.filter((r) => r.field === "supplement").map((r) => ({ sortOrder: r.payload!.sortOrder, prompt: r.payload!.prompt })),
    }),
    insert: async (row) => {
      if (rows.some((r) => r.college_id === row.college_id && r.fact_key === row.fact_key)) return "duplicate";
      rows.push(row);
      return "inserted";
    },
  };
  return { store, rows };
}

function deps(store: ProposalStore, fetched: string[], answer: unknown): ProposerDeps {
  const site: Record<string, SitePage> = {
    "https://www.example.edu": page(HOME, PAGES[0]!.text, [
      { href: ESSAYS, text: "Writing supplement" },
      { href: "https://essayguy.example/example-u-prompts", text: "Example U essay prompts" },
    ]),
    [ESSAYS]: page(ESSAYS, PAGES[1]!.text),
  };
  return {
    store,
    fetchPage: async (url) => {
      fetched.push(url);
      const p = site[url];
      if (!p) throw new Error(`not in the fixture: ${url}`);
      return p;
    },
    ai: async (o) => o.validate(answer),
    now: () => new Date("2026-11-07T12:00:00Z"),
  };
}

const ANSWER = {
  personalStatementRead: { value: true, quote: "We read the Common App personal statement carefully.", sourceUrl: ESSAYS },
  testReporting: { value: "self-report", quote: "Applicants may self-report their test scores", sourceUrl: ESSAYS },
  supplements: [
    { sortOrder: 0, title: "Why Example", prompt: "Why do you want to attend Example University?", wordLimit: 250, quote: "Prompt 1: Why do you want to attend Example University? (250 words)", sourceUrl: ESSAYS },
    { sortOrder: 1, title: "Invented", prompt: "Tell us about a hat.", wordLimit: 100, quote: "Prompt 2: Tell us about a hat. (100 words)", sourceUrl: ESSAYS },
  ],
};

test("a run reads only the school's own pages and writes pending proposals", async () => {
  const { store, rows } = memoryStore();
  const fetched: string[] = [];
  const r = await proposeForCollege("c1", deps(store, fetched, ANSWER));
  assert.deepEqual(fetched, ["https://www.example.edu", ESSAYS], "the link to another domain is never fetched");
  assert.equal(r.proposed, 3);
  assert.equal(r.droppedNoQuote, 1);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status ?? "pending", "pending");
    assert.equal(row.proposed_by, null);
    assert.match(row.source_url, /^https:\/\/apply\.example\.edu\//);
    assert.ok(row.evidence && row.evidence.length >= 12);
    assert.equal(row.admission_cycle, "2026-2027");
  }
  const supp = rows.find((x) => x.field === "supplement")!;
  assert.deepEqual(supp.payload, { cycle: "2026-2027", sortOrder: 0, title: "Why Example", prompt: "Why do you want to attend Example University?", wordLimit: 250 });
  assert.equal(supp.proposed_value, "2026-2027#0", "an empty school's first prompt takes slot 0");
});

test("a second run proposes nothing new", async () => {
  const { store, rows } = memoryStore();
  await proposeForCollege("c1", deps(store, [], ANSWER));
  const again = await proposeForCollege("c1", deps(store, [], ANSWER));
  assert.equal(again.proposed, 0);
  assert.equal(again.duplicates, 3);
  assert.equal(rows.length, 3);
});

test("a dry run writes nothing", async () => {
  const { store, rows } = memoryStore();
  const r = await proposeForCollege("c1", deps(store, [], ANSWER), { dryRun: true });
  assert.equal(r.proposed, 0);
  assert.equal(r.candidates.length, 3);
  assert.equal(rows.length, 0);
});

test("a fact the catalog already holds, with a source, is not proposed", async () => {
  const { store, rows } = memoryStore({
    policies: { personal_statement_read: true, test_reporting: null, sources: { personal_statement_read: { url: ESSAYS } } },
    // On file at slot 3: matched by its words, not its slot.
    supplements: [{ sort_order: 3, title: "Why Example", prompt: "why do you want to attend  Example University?", word_limit: 250, source_url: ESSAYS }],
  });
  const r = await proposeForCollege("c1", deps(store, [], ANSWER));
  assert.equal(r.unchanged, 2);
  assert.deepEqual(rows.map((x) => x.field), ["test_reporting"]);
});

test("a college with no website, or one not in the catalog, is refused before anything is fetched", async () => {
  const { store } = memoryStore();
  const fetched: string[] = [];
  await assert.rejects(proposeForCollege("nope", deps(store, fetched, ANSWER)), /isn't in the catalog/);
  const noSite: ProposalStore = { ...store, college: async () => ({ id: "c1", name: "X", website: null }) };
  await assert.rejects(proposeForCollege("c1", deps(noSite, fetched, ANSWER)), /no website/);
  assert.deepEqual(fetched, []);
});

test("without a model nothing is proposed", async () => {
  const { store, rows } = memoryStore();
  const d = { ...deps(store, [], ANSWER), ai: null };
  await assert.rejects(proposeForCollege("c1", d), /model/);
  assert.equal(rows.length, 0);
});

// ---- Slots: assigned by us, never by the model ---------------------------------------------------------

const P = ["Why do you want to attend Example University?", "Describe a community you belong to.", "What is an idea that excites you?", "Tell us about a challenge you faced.", "What would you study, and why?"];
const quoteOf = (i: number) => `Prompt ${i + 1}: ${P[i]} (200 words)`;

/** A run over one essay page listing `order` (indexes into P), against curated rows on file. */
async function slotRun(order: number[], onFile: number[], store?: ReturnType<typeof memoryStore>) {
  const m = store ?? memoryStore({ supplements: onFile.map((i, slot) => ({ sort_order: slot, title: `Prompt ${slot + 1}`, prompt: P[i], word_limit: 200, source_url: ESSAYS })) });
  const text = `Supplemental essays. ${order.map((i) => quoteOf(i)).join(" ")}`;
  const site: Record<string, SitePage> = {
    "https://www.example.edu": page(HOME, "Home", [{ href: ESSAYS, text: "Supplemental essays" }]),
    [ESSAYS]: page(ESSAYS, text),
  };
  const answer = {
    supplements: order.map((i, at) => ({ sortOrder: at, title: "x", prompt: P[i], wordLimit: 200, quote: quoteOf(i), sourceUrl: ESSAYS })),
  };
  const r = await proposeForCollege("c1", {
    store: m.store,
    fetchPage: async (url) => site[url]!,
    ai: async (o) => o.validate(answer),
    now: () => new Date("2026-11-07T12:00:00Z"),
  });
  return { r, rows: m.rows, m };
}

test("a school with curated slots 0-3 and one new prompt on the page gets exactly one proposal, at slot 4", async () => {
  const { r, rows } = await slotRun([0, 1, 2, 3, 4], [0, 1, 2, 3]);
  assert.equal(r.unchanged, 4, "the four on file are recognised by their words");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payload!.sortOrder, 4);
  assert.equal(rows[0]!.payload!.prompt, P[4]);
  assert.equal(rows[0]!.proposed_value, "2026-2027#4");
});

test("a page that lists the same prompts in another order proposes no duplicates", async () => {
  const { r, rows } = await slotRun([4, 3, 2, 1, 0], [0, 1, 2, 3]);
  assert.equal(r.unchanged, 4);
  assert.deepEqual(rows.map((x) => [x.payload!.sortOrder, x.payload!.prompt]), [[4, P[4]]]);
});

test("an empty school gets slots 0..n-1 in the page's order", async () => {
  const { rows } = await slotRun([2, 0, 1], []);
  assert.deepEqual(rows.map((x) => [x.payload!.sortOrder, x.payload!.prompt]), [[0, P[2]], [1, P[0]], [2, P[1]]]);
});

test("a prompt already waiting for review isn't proposed again, and its slot isn't reused", async () => {
  const first = await slotRun([0], []);
  assert.equal(first.rows[0]!.payload!.sortOrder, 0);
  const { r, rows } = await slotRun([1, 0], [], first.m);
  assert.equal(r.duplicates, 1, "prompt 0 is already pending");
  assert.deepEqual(rows.map((x) => [x.payload!.sortOrder, x.payload!.prompt]), [[0, P[0]], [1, P[1]]], "the new prompt takes the next free slot");
});

test("the same prompt twice on a page is proposed once", () => {
  const text = `Essays. ${quoteOf(0)} Again: ${quoteOf(0)}`;
  const r = groundCandidates(
    { supplements: [0, 1].map((at) => ({ sortOrder: at, title: "x", prompt: P[0], wordLimit: 200, quote: quoteOf(0), sourceUrl: ESSAYS })) },
    [{ url: ESSAYS, text }],
    CTX
  );
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped.invalid, 1);
});

// ---- A flag's value must be what its quote says ----------------------------------------------------------

function flag(field: "personalStatementRead" | "testReporting", value: unknown, quote: string) {
  const r = groundCandidates({ [field]: { value, quote, sourceUrl: ESSAYS } }, [{ url: ESSAYS, text: `Policy. ${quote} End.` }], CTX);
  return r.kept.length === 1 ? "kept" : r.dropped.invalid === 1 ? "invalid" : "other";
}

test("personal statement: true needs a plain statement, false needs a negation", () => {
  assert.equal(flag("personalStatementRead", true, "We do not read the personal statement."), "invalid", "the reviewer's counter-example");
  assert.equal(flag("personalStatementRead", false, "We do not read the personal statement."), "kept");
  assert.equal(flag("personalStatementRead", false, "The personal statement isn't read by our committee."), "kept");
  assert.equal(flag("personalStatementRead", false, "We no longer review the Common App essay."), "kept");
  assert.equal(flag("personalStatementRead", false, "Applications are reviewed without the personal statement."), "kept");
  assert.equal(flag("personalStatementRead", false, "We never consider the personal essay."), "kept");
  assert.equal(flag("personalStatementRead", true, "Every reader reviews your personal statement closely."), "kept");
  assert.equal(flag("personalStatementRead", false, "Every reader reviews your personal statement closely."), "invalid");
  assert.equal(flag("personalStatementRead", true, "Our readers review every application closely."), "invalid", "no mention of the statement");
});

test("self-report: a self-report mention that isn't negated", () => {
  assert.equal(flag("testReporting", "self-report", "Applicants may self-report their scores on the application."), "kept");
  assert.equal(flag("testReporting", "self-report", "Self reported scores are accepted for review."), "kept");
  assert.equal(flag("testReporting", "self-report", "We do not accept self-reported scores."), "invalid");
  assert.equal(flag("testReporting", "self-report", "Official score reports are required from every applicant."), "invalid");
});

test("official-only: self-report refused, or scores must come officially, with no self-report accepted", () => {
  assert.equal(flag("testReporting", "official-only", "We do not accept self-reported test scores."), "kept");
  assert.equal(flag("testReporting", "official-only", "Scores must be sent directly from the testing agency."), "kept");
  assert.equal(flag("testReporting", "official-only", "Official score reports are required for every applicant."), "kept");
  assert.equal(flag("testReporting", "official-only", "Applicants may self-report; official score reports are required only on enrolling."), "invalid");
  assert.equal(flag("testReporting", "official-only", "Official transcripts arrive from your high school."), "invalid", "official, but not about scores being required");
});

test("score-send: needs score-sending wording", () => {
  assert.equal(flag("testReporting", "score-send", "Send your official scores through the College Board."), "kept");
  assert.equal(flag("testReporting", "score-send", "Test scores must be sent by the testing agency."), "kept");
  assert.equal(flag("testReporting", "score-send", "Applicants may self-report their scores and send them later."), "invalid", "self-report accepted");
  assert.equal(flag("testReporting", "score-send", "Official score reports are required for admission."), "invalid", "no sending wording");
});

test("not-applicable: needs a test-blind or test-free statement that isn't negated", () => {
  assert.equal(flag("testReporting", "not-applicable", "Our admissions process is test-blind for all applicants."), "kept");
  assert.equal(flag("testReporting", "not-applicable", "We are a test free institution for first-year applicants."), "kept");
  assert.equal(flag("testReporting", "not-applicable", "We are no longer test-blind for first-year applicants."), "invalid");
  assert.equal(flag("testReporting", "not-applicable", "Scores are optional for all applicants this year."), "invalid");
});

// ---- Redirects off the school's domain -------------------------------------------------------------------

test("a home page that redirects off the school's domain ends the run before the model", async () => {
  const { store, rows } = memoryStore();
  let modelCalled = false;
  await assert.rejects(
    proposeForCollege("c1", {
      store,
      fetchPage: async () => page("https://parked-domains.example/landing", "For sale"),
      ai: async (o) => ((modelCalled = true), o.validate(ANSWER)),
    }),
    /redirected to another domain/
  );
  assert.equal(modelCalled, false);
  assert.equal(rows.length, 0);
});

test("a subpage that redirects off the school's domain is dropped, and so is anything cited from it", async () => {
  const { store, rows } = memoryStore();
  const offsite = "https://essays-hub.example/example-u";
  const site: Record<string, SitePage> = {
    "https://www.example.edu": page(HOME, PAGES[0]!.text, [{ href: ESSAYS, text: "Writing supplement" }]),
    // Asked for apply.example.edu/essays, answered from another domain.
    [ESSAYS]: page(offsite, PAGES[1]!.text),
  };
  let prompt = "";
  const r = await proposeForCollege("c1", {
    store,
    fetchPage: async (url) => site[url]!,
    ai: async (o) => {
      prompt = o.prompt;
      return o.validate({ ...ANSWER, personalStatementRead: { ...ANSWER.personalStatementRead, sourceUrl: offsite } });
    },
  });
  assert.deepEqual(r.pagesRead, [HOME]);
  assert.ok(!prompt.includes(offsite), "the off-domain page never reaches the model");
  assert.equal(rows.length, 0);
  assert.ok(r.droppedOffDomain >= 1);
});

// ---- Fix round 2: negations scoped to what they negate ---------------------------------------------------

test("reviewer probes: a negated requirement or send is never kept as official-only or score-send", () => {
  for (const q of [
    "Official test scores are not required for admission.",
    "Official score reports are not required until you enroll.",
    "Applicants may self-report their scores, and we do not require official score reports until enrollment.",
    "Self-reported scores are not accepted, and official scores are not required until you enroll.",
  ]) {
    assert.equal(flag("testReporting", "official-only", q), "invalid", q);
  }
  for (const q of [
    "You do not need to send your scores to us.",
    "You may self-report your scores; you do not need to send official scores until you enroll.",
    "We will not accept scores sent by applicants.",
  ]) {
    assert.equal(flag("testReporting", "score-send", q), "invalid", q);
  }
});

test("reviewer probes: a bare 'no' negates the personal statement", () => {
  for (const q of ["There is no personal statement at this school.", "No personal statement is required for admission."]) {
    assert.equal(flag("personalStatementRead", true, q), "invalid", q);
  }
});

test("plain statements of each value are still kept", () => {
  assert.equal(flag("testReporting", "official-only", "Self-reported scores are not accepted; official score reports must come directly from the testing agency."), "kept");
  assert.equal(flag("testReporting", "self-report", "We accept self-reported test scores."), "kept");
  assert.equal(flag("testReporting", "score-send", "Applicants must send official scores from the testing agency."), "kept");
  assert.equal(flag("personalStatementRead", true, "We read the personal statement as part of every application."), "kept");
  assert.equal(flag("personalStatementRead", false, "We do not read the personal statement."), "kept");
});

// ---- Fix round 3: the reviewer's table, every row through groundCandidates ----------------------------------

const ROUND3_DROP: [Parameters<typeof flag>[0], unknown, string][] = [
  ["personalStatementRead", false, "We do not require a personal statement, but we read it if you submit one."],
  ["personalStatementRead", false, "No personal statement is required; if you send one, our readers will review it."],
  ["personalStatementRead", false, "Personal statement: not required, but we do read it if you submit one."],
  ["personalStatementRead", false, "No personal statement is required."],
  ["personalStatementRead", false, "A personal statement is not required."],
  ["personalStatementRead", true, "Personal statements are optional and rarely read."],
  ["personalStatementRead", true, "We rarely read the personal statement."],
  ["personalStatementRead", true, "We seldom read the personal statement."],
  ["personalStatementRead", true, "The personal statement carries little weight."],
  ["personalStatementRead", true, "The personal statement is optional."],
  ["personalStatementRead", true, "Please upload your personal statement through the Common App."],
  ["testReporting", "official-only", "We do not accept self-reported scores for merit scholarships, but we do for admission."],
  ["testReporting", "official-only", "We do not accept self-reported scores for merit scholarships."],
  ["testReporting", "official-only", "We do not accept self-reported scores for the honors program."],
  ["testReporting", "official-only", "Self-reported scores will not be accepted from applicants outside the United States."],
  ["testReporting", "official-only", "We do not accept self-reported scores unless you applied before January 1."],
  ["testReporting", "official-only", "Official score reports are required only upon enrollment."],
  ["testReporting", "official-only", "Official scores are required only after you are admitted and enroll."],
  ["testReporting", "official-only", "Self-report is not an option, though official score reports are not mandatory at the time of application."],
  ["testReporting", "score-send", "International applicants should send TOEFL scores."],
];
const ROUND3_KEEP: [Parameters<typeof flag>[0], unknown, string][] = [
  ["personalStatementRead", false, "We do not read the personal statement."],
  ["personalStatementRead", false, "We never consider the personal essay."],
  ["personalStatementRead", false, "Applications are reviewed without the personal statement."],
  ["personalStatementRead", false, "We neither require nor read the personal statement."],
  ["personalStatementRead", true, "We read the personal statement as part of every application."],
  ["testReporting", "official-only", "Self-reported scores are not accepted; official score reports must come directly from the testing agency."],
  ["testReporting", "official-only", "Students may not self-report scores; official scores are required."],
  ["testReporting", "official-only", "Applicants who do not self-report must send official scores directly from the testing agency."],
  ["testReporting", "self-report", "We accept self-reported test scores."],
  ["testReporting", "self-report", "Self-reported scores are accepted, but official scores are required after admission."],
  ["testReporting", "score-send", "Applicants must send official scores from the testing agency."],
];

for (const [field, value, q] of ROUND3_DROP) {
  test(`round 3 drops (${field}=${String(value)}): ${q}`, () => assert.equal(flag(field, value, q), "invalid"));
}
for (const [field, value, q] of ROUND3_KEEP) {
  test(`round 3 keeps (${field}=${String(value)}): ${q}`, () => assert.equal(flag(field, value, q), "kept"));
}

test("English-proficiency scores alone are not SAT/ACT reporting", () => {
  assert.equal(flag("testReporting", "self-report", "Applicants may self-report TOEFL or IELTS scores."), "invalid");
  assert.equal(flag("testReporting", "score-send", "Send your Duolingo English Test scores directly."), "invalid");
});

// ---- Fix round 4: scope on every value, imperative read verbs ----------------------------------------------

const ROUND4_DROP: [Parameters<typeof flag>[0], unknown, string][] = [
  // A: a statement flag scoped to scholarships, honors, transfers, a condition.
  ["personalStatementRead", false, "We do not consider the personal statement for scholarship decisions."],
  ["personalStatementRead", false, "We do not read the personal statement unless the application is borderline."],
  ["personalStatementRead", false, "The personal statement is not read by the scholarship committee."],
  ["personalStatementRead", true, "If you are applying to the honors program, we read your personal statement."],
  ["personalStatementRead", true, "Transfer applicants: we review your personal statement."],
  ["personalStatementRead", true, "The personal statement is read by the scholarship committee."],
  ["personalStatementRead", true, "We use your personal statement to decide scholarship awards."],
  // B: a read verb used as an instruction is not the school reading it.
  ["personalStatementRead", true, "Please use the Common App to submit your personal statement."],
  ["personalStatementRead", true, "Be sure to read the personal statement instructions carefully."],
  ["personalStatementRead", true, "Please consider writing a personal statement."],
  ["personalStatementRead", true, "Read our tips for writing a strong personal statement."],
  // C: test reporting scoped to some applicants, a program or a plan.
  ["testReporting", "official-only", "We do not accept self-reported scores from homeschooled applicants."],
  ["testReporting", "official-only", "Applicants from China may not self-report scores."],
  ["testReporting", "official-only", "We do not accept self-reported scores for Early Decision applicants."],
  ["testReporting", "official-only", "Official SAT or ACT scores must be sent directly from the testing agency for students applying to engineering."],
  ["testReporting", "self-report", "We accept self-reported scores for scholarship consideration."],
  ["testReporting", "self-report", "We accept self-reported SAT scores from international applicants only."],
  ["testReporting", "score-send", "Scholarship applicants should send ACT scores to our office by December 1."],
  ["testReporting", "not-applicable", "The Honors College is test-blind."],
  ["testReporting", "not-applicable", "We are neither test-blind nor test-free."],
  ["testReporting", "not-applicable", "Unlike test-blind schools, we consider SAT scores."],
];
for (const [field, value, q] of ROUND4_DROP) {
  test(`round 4 drops (${field}=${String(value)}): ${q}`, () => assert.equal(flag(field, value, q), "invalid"));
}

test("round 4: every earlier keep case, and the fake's two quotes, are still kept", () => {
  const keeps: [Parameters<typeof flag>[0], unknown, string][] = [
    ...ROUND3_KEEP,
    ["personalStatementRead", false, "The personal statement isn't read by our committee."],
    ["personalStatementRead", false, "We no longer review the Common App essay."],
    ["personalStatementRead", true, "Every reader reviews your personal statement closely."],
    ["personalStatementRead", true, "We read the Common App personal statement carefully."],
    ["personalStatementRead", true, "Our readers review every applicant's Common App personal statement in full."],
    ["testReporting", "self-report", "Applicants may self-report their scores on the application."],
    ["testReporting", "self-report", "Self reported scores are accepted for review."],
    ["testReporting", "self-report", "Applicants may self-report their test scores"],
    ["testReporting", "self-report", "Applicants may self-report their SAT or ACT scores; official"],
    ["testReporting", "official-only", "We do not accept self-reported test scores."],
    ["testReporting", "official-only", "Scores must be sent directly from the testing agency."],
    ["testReporting", "official-only", "Official score reports are required for every applicant."],
    ["testReporting", "score-send", "Send your official scores through the College Board."],
    ["testReporting", "score-send", "Test scores must be sent by the testing agency."],
    ["testReporting", "not-applicable", "Our admissions process is test-blind for all applicants."],
    ["testReporting", "not-applicable", "We are a test free institution for first-year applicants."],
  ];
  const lost = keeps.filter(([f, v, q]) => flag(f, v, q) !== "kept").map(([, , q]) => q);
  assert.deepEqual(lost, []);
});
