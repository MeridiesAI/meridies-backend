import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessibilityFakeRefusal, applyOverridePatch, fixtureDeps, groundAccessibility, isStale, levelFitsEvidence, meetsLearningSupport,
  mergeOverride, mergeResearch, overriddenFields, overrideBody, pickAccessibilityPages, researchAccessibility, toRecord, type AccessibilityRecord,
} from "../../src/lib/collegeAccessibility.js";
import { learningSupportBody } from "../../src/routes/learningSupport.js";

const NOW = new Date("2026-11-27T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const page = (url: string, text: string, links: { href: string; text: string }[] = []) => ({ finalUrl: url, text, links }) as never;
const DS = page(
  "https://www.example.edu/accessibility",
  "Accessibility Resource Center. Reach us at arc@example.edu or (555) 010-0100. Accommodations include extended time on exams and note-taking support. The Learning Success Program is a structured learning-support program with its own staff. The program costs $4,500 per semester.",
  [{ href: "https://www.example.edu/accessibility/apply", text: "Apply" }]
);

test("staleness: no row, never verified, older than 180 days, or only the IPEDS percent", () => {
  assert.equal(isStale(null, NOW), true);
  assert.equal(isStale({ last_verified_at: null, data_source: "axis", field_sources: { dsEmail: ["u"] } }, NOW), true);
  assert.equal(isStale({ last_verified_at: daysAgo(181), data_source: "axis", field_sources: { dsEmail: ["u"] } }, NOW), true);
  assert.equal(isStale({ last_verified_at: daysAgo(179), data_source: "axis", field_sources: { dsEmail: ["u"] } }, NOW), false);
  // The IPEDS import stamps last_verified_at, but nobody has read the college's pages yet.
  assert.equal(isStale({ last_verified_at: daysAgo(1), data_source: "ipeds", field_sources: {} }, NOW), true);
  // A researched college that found nothing is not researched again for 180 days.
  assert.equal(isStale({ last_verified_at: daysAgo(1), data_source: "axis", field_sources: {} }, NOW), false);
});

test("overrides: an override key wins, null clears it, \"\" and [] blank the field for that practice", () => {
  const shared = toRecord({ ds_email: "shared@example.edu", ds_phone: "555", support_level: "standard", accommodations: ["A", "B"], data_source: "axis", pct_three_or_less: true })!;
  const merged = mergeOverride(shared, { dsEmail: "own@example.edu", dsPhone: "", accommodations: [], supportLevel: "enhanced" })!;
  assert.equal(merged.dsEmail, "own@example.edu");
  assert.equal(merged.dsPhone, null);
  assert.deepEqual(merged.accommodations, []);
  assert.equal(merged.supportLevel, "enhanced");
  assert.equal(merged.pctThreeOrLess, true);
  assert.deepEqual(overriddenFields({ dsEmail: "x", dsPhone: "", bogus: 1 }).sort(), ["dsEmail", "dsPhone"]);
  // null removes an override key; the shared value shows again.
  const next = applyOverridePatch({ dsEmail: "own@example.edu", dsPhone: "" }, { dsEmail: null, programName: "P" });
  assert.deepEqual(next, { dsPhone: "", programName: "P" });
  assert.equal(mergeOverride(shared, next)!.dsEmail, "shared@example.edu");
  // With no shared row the override stands alone; with neither, null.
  assert.equal(mergeOverride(null, { programName: "P" })!.programName, "P");
  assert.equal(mergeOverride(null, {}), null);
});

test("the override body validates every field and refuses unknown keys", () => {
  const ok = (fields: unknown) => overrideBody.safeParse({ fields }).success;
  assert.ok(ok({ dsEmail: "a@b.edu", dsUrl: "https://x.edu", supportLevel: "enhanced", accommodations: ["Extended time"] }));
  assert.ok(ok({ dsEmail: null, accommodations: null, supportLevel: "" }));
  assert.ok(!ok({ dsEmail: "not an email" }));
  assert.ok(!ok({ dsUrl: "javascript:alert(1)" }));
  assert.ok(!ok({ supportLevel: "gold" }));
  assert.ok(!ok({ accommodations: Array.from({ length: 31 }, () => "x") }));
  assert.ok(!ok({ accommodations: ["x".repeat(121)] }));
  assert.ok(!ok({ pctRegisteredDs: 5 }));
});

test("the quote check: a field is kept only when its quote is on a page it fetched, and records that page", () => {
  const out = groundAccessibility(
    {
      accommodations: [
        { text: "Extended time on exams", evidence: "Accommodations include extended time on exams and note-taking support." },
        { text: "Free tutoring for everyone", evidence: "Every student gets free tutoring in any subject." },
      ],
      documentationAccepted: { text: "Any documentation is accepted", evidence: "We accept any documentation a student has." },
    },
    [DS]
  );
  assert.deepEqual(out.patch.accommodations, ["Extended time on exams"]);
  assert.deepEqual(out.fieldSources.accommodations, ["https://www.example.edu/accessibility"]);
  assert.equal("documentation_accepted" in out.patch, false);
});

test("contact details must appear verbatim: a guessed address or phone is dropped", () => {
  const out = groundAccessibility(
    { dsOfficeName: { value: "Accessibility Resource Center" }, dsEmail: { value: "arc@example.edu" }, dsPhone: { value: "(555) 010-0100" } },
    [DS]
  );
  assert.equal(out.patch.ds_office_name, "Accessibility Resource Center");
  assert.equal(out.patch.ds_email, "arc@example.edu");
  assert.equal(out.patch.ds_phone, "(555) 010-0100");
  const guessed = groundAccessibility({ dsEmail: { value: "disability@example.edu" }, dsPhone: { value: "(555) 999-9999" }, dsOfficeName: { value: "Office of Special Services" } }, [DS]);
  assert.deepEqual(guessed.patch, {});
});

test("a web address counts when it is the page itself or one of its links", () => {
  const onLink = groundAccessibility({ dsUrl: { value: "https://www.example.edu/accessibility/apply" } }, [DS]);
  assert.equal(onLink.patch.ds_url, "https://www.example.edu/accessibility/apply");
  assert.deepEqual(groundAccessibility({ dsUrl: { value: "https://www.example.edu/elsewhere" } }, [DS]).patch, {});
  assert.equal(groundAccessibility({ dsUrl: { value: "https://www.example.edu/accessibility/" } }, [DS]).patch.ds_url, "https://www.example.edu/accessibility/");
});

test("support level: the quote has to fit the level's words", () => {
  assert.equal(levelFitsEvidence("comprehensive", "The Learning Success Program is a structured learning-support program"), true);
  assert.equal(levelFitsEvidence("comprehensive", "We provide extended time on exams"), false);
  assert.equal(levelFitsEvidence("enhanced", "Our learning specialists offer one-on-one coaching"), true);
  assert.equal(levelFitsEvidence("enhanced", "We provide extended time on exams"), false);
  assert.equal(levelFitsEvidence("standard", "We provide extended time on exams"), true);
  const ok = groundAccessibility({ supportLevel: { level: "comprehensive", evidence: "The Learning Success Program is a structured learning-support program with its own staff." } }, [DS]);
  assert.equal(ok.patch.support_level, "comprehensive");
  const bad = groundAccessibility({ supportLevel: { level: "comprehensive", evidence: "Accommodations include extended time on exams and note-taking support." } }, [DS]);
  assert.equal("support_level" in bad.patch, false);
});

test("a program's cost is only what its own quote says", () => {
  const ok = groundAccessibility({ program: { name: "Learning Success Program", costText: "$4,500 per semester", costEvidence: "The program costs $4,500 per semester.", feeBased: true } }, [DS]);
  assert.equal(ok.patch.program_name, "Learning Success Program");
  assert.equal(ok.patch.program_cost_text, "$4,500 per semester");
  assert.equal(ok.patch.program_fee_based, true);
  const invented = groundAccessibility({ program: { name: "Learning Success Program", costText: "$9,000 per semester", costEvidence: "The program costs $4,500 per semester.", feeBased: true } }, [DS]);
  assert.equal(invented.patch.program_name, "Learning Success Program");
  assert.equal("program_cost_text" in invented.patch, false);
  assert.equal("program_name" in groundAccessibility({ program: { name: "Made Up Program" } }, [DS]).patch, false);
});

test("the research job never writes the IPEDS percent, and keeps what was there", () => {
  const existing = { college_id: "c", pct_registered_ds: 7, source_urls: ["https://nces.ed.gov"], field_sources: { dsEmail: ["https://old"] }, data_source: "ipeds" };
  const found = groundAccessibility({ dsEmail: { value: "arc@example.edu" } }, [DS]);
  const row = mergeResearch(existing, found, { id: "c", unitid: 123 }, ["https://www.example.edu/accessibility"], NOW);
  assert.equal("pct_registered_ds" in row, false);
  assert.equal("pct_three_or_less" in row, false);
  assert.equal(row.data_source, "axis");
  assert.deepEqual((row.field_sources as Record<string, string[]>).dsEmail, ["https://www.example.edu/accessibility"]);
  assert.ok((row.source_urls as string[]).includes("https://nces.ed.gov"));
});

test("pages: the job follows only the college's own links about disability services", () => {
  const links = [
    { href: "https://www.example.edu/accessibility", text: "Accessibility" },
    { href: "https://disability.example.edu/", text: "Disability Services" },
    { href: "https://www.example.edu/news/2026/disability-awards", text: "News" },
    { href: "https://other.org/disability", text: "Disability" },
    { href: "https://www.example.edu/admissions", text: "Admissions" },
    { href: "https://www.example.edu/files/accommodations.pdf", text: "Accommodations" },
  ];
  const picked = pickAccessibilityPages(links, "https://www.example.edu/");
  assert.deepEqual(picked.sort(), ["https://disability.example.edu/", "https://www.example.edu/accessibility"].sort());
});

test("the fixture runs the whole job with no network or model, and every field it sets has a source", async () => {
  const { home, deps } = fixtureDeps({ name: "Fixture College" });
  const out = await researchAccessibility({ name: "Fixture College" }, home, deps);
  assert.equal(out.found.patch.ds_email, "arc@fixture.example.edu");
  assert.equal(out.found.patch.support_level, "comprehensive");
  for (const [field, urls] of Object.entries(out.found.fieldSources)) assert.ok(urls.length > 0, `${field} has a source`);
});

test("with no AI the pages are not summarized, and a home page with no disability link finds nothing", async () => {
  const { home, deps } = fixtureDeps({ name: "X" });
  const noAi = await researchAccessibility({ name: "X" }, home, { ...deps, ai: null });
  assert.deepEqual(noAi.found.patch, {});
  const bare = await researchAccessibility({ name: "X" }, { ...home, links: [] }, deps);
  assert.deepEqual(bare.found.patch, {});
  assert.match(bare.note ?? "", /disability services pages/);
});

test("the fixture refuses to run in production", () => {
  assert.match(accessibilityFakeRefusal({ ACCESSIBILITY_FAKE: "fixture", NODE_ENV: "production" }) ?? "", /must not be set/);
  assert.match(accessibilityFakeRefusal({ ACCESSIBILITY_FAKE: "fixture", NODE_ENV: undefined }) ?? "", /needs NODE_ENV/);
  assert.equal(accessibilityFakeRefusal({ ACCESSIBILITY_FAKE: "fixture", NODE_ENV: "test" }), null);
  assert.equal(accessibilityFakeRefusal({ NODE_ENV: "production" }), null);
});

test("the list builder's learning support filter: a school with no record never matches", () => {
  assert.equal(meetsLearningSupport(null, "any"), true);
  assert.equal(meetsLearningSupport(undefined, undefined), true);
  assert.equal(meetsLearningSupport(null, "enhanced"), false);
  assert.equal(meetsLearningSupport("standard", "enhanced"), false);
  assert.equal(meetsLearningSupport("enhanced", "enhanced"), true);
  assert.equal(meetsLearningSupport("comprehensive", "enhanced"), true);
  assert.equal(meetsLearningSupport("enhanced", "comprehensive"), false);
  assert.equal(meetsLearningSupport("comprehensive", "comprehensive"), true);
});

test("learning support body: four levels, notes capped at 4000, nothing else", () => {
  assert.ok(learningSupportBody.safeParse({ needLevel: "none", notes: "" }).success);
  assert.ok(learningSupportBody.safeParse({ needLevel: "comprehensive", notes: "x".repeat(4000) }).success);
  assert.ok(!learningSupportBody.safeParse({ needLevel: "comprehensive", notes: "x".repeat(4001) }).success);
  assert.ok(!learningSupportBody.safeParse({ needLevel: "severe", notes: "" }).success);
  assert.ok(!learningSupportBody.safeParse({ needLevel: "none", notes: "", extra: 1 }).success);
});

test("toRecord keeps the IPEDS bucket apart from a number", () => {
  const r: AccessibilityRecord = toRecord({ pct_registered_ds: null, pct_three_or_less: true, accommodations: [], data_source: "ipeds" })!;
  assert.equal(r.pctRegisteredDs, null);
  assert.equal(r.pctThreeOrLess, true);
  assert.equal(toRecord(null), null);
});
