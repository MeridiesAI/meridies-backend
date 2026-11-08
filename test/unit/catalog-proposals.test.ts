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
        sortOrder: 1,
        title: "Why Example",
        prompt: "Why do you want to attend Example University?",
        wordLimit: 250,
        quote: "Prompt 1: Why do you want to attend Example University? (250 words)",
        sourceUrl: ESSAYS,
        cycleStated: "2026-2027",
      },
      {
        sortOrder: 2,
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
    ["personal_statement_read:true", "test_reporting:self-report", "supplement:1"]
  );
  assert.equal(r.dropped.noQuote, 1, "the made-up prompt is dropped and counted");
  const s = r.kept.find((c) => c.field === "supplement");
  assert.ok(s && s.field === "supplement");
  assert.deepEqual(s.payload, { cycle: "2026-2027", sortOrder: 1, title: "Why Example", prompt: "Why do you want to attend Example University?", wordLimit: 250 });
  assert.equal(s.sourceUrl, ESSAYS);
});

test("a supplement title the page doesn't use is replaced with a plain one", () => {
  const r = groundCandidates(
    {
      supplements: [
        { sortOrder: 1, title: "Our invented label", prompt: "Why do you want to attend Example University?", wordLimit: 250, quote: "Prompt 1: Why do you want to attend Example University? (250 words)", sourceUrl: ESSAYS },
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
});

// ---- The run -------------------------------------------------------------------------------------

function memoryStore(over: Partial<{ policies: Record<string, unknown> | null; supplements: Record<string, unknown>[] }> = {}) {
  const rows: ProposalRow[] = [];
  const store: ProposalStore = {
    college: async (id) => (id === "c1" ? { id: "c1", name: "Example University", website: "https://www.example.edu" } : null),
    current: async () => ({ policies: over.policies ?? null, supplements: over.supplements ?? [] }),
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
    { sortOrder: 1, title: "Why Example", prompt: "Why do you want to attend Example University?", wordLimit: 250, quote: "Prompt 1: Why do you want to attend Example University? (250 words)", sourceUrl: ESSAYS },
    { sortOrder: 2, title: "Invented", prompt: "Tell us about a hat.", wordLimit: 100, quote: "Prompt 2: Tell us about a hat. (100 words)", sourceUrl: ESSAYS },
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
  assert.deepEqual(supp.payload, { cycle: "2026-2027", sortOrder: 1, title: "Why Example", prompt: "Why do you want to attend Example University?", wordLimit: 250 });
  assert.equal(supp.proposed_value, "2026-2027#1");
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
    supplements: [{ sort_order: 1, title: "Why Example", prompt: "Why do you want to attend Example University?", word_limit: 250, source_url: ESSAYS }],
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
