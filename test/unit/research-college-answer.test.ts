import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keepCandidates } from "../../src/lib/research/citations.js";
import {
  dropStudentInfoInSuggestions, parseCandidatesCounted, replaceWhysNamingStudent, sourcesByTitle, validatePicks, FITS,
} from "../../src/lib/research/prompt.js";

/**
 * A whole college_list answer as a live run returns it, through the same steps run.ts takes (parse with the
 * title-matched fallback, keep, match, the student-info checks): the counselor must get at least five schools, spread
 * over reach, target and likely, with none of the model's markup (cite wrappers, [S#] markers) in any field.
 */
type Part = { text: string; citations: { url: string; title: string | null }[] };
const fixture: {
  parts: Part[];
  seenPages: { url: string; title: string }[];
  seenUrls: string[];
  match: unknown;
} = JSON.parse(readFileSync(new URL("../fixtures/research/college-list-answer.json", import.meta.url), "utf8"));

const MARKUP = /<\/?[A-Za-z]|cite index|\(cite|\[S\d/;
const identity = { name: "Avery Quinlan", email: "avery.q@example.com" };

async function run() {
  const parsed = parseCandidatesCounted(fixture.parts, { fallbackSources: (t) => sourcesByTitle(t, fixture.seenPages) });
  const kept = await keepCandidates(parsed.candidates, fixture, ["niche.com"], async () => ({ status: "ok" as const }));
  const drafts = dropStudentInfoInSuggestions(replaceWhysNamingStudent(validatePicks(fixture.match, kept), identity), identity);
  return { parsed, kept, drafts };
}

test("a realistic college answer: every school is read, the listicle one dropped, the uncited one recovered", async () => {
  const { parsed, kept } = await run();
  assert.equal(parsed.objects, 8);
  assert.equal(parsed.candidates.length, 8, "a leaked cite tag with bare quotes must not break its object");
  assert.equal(parsed.recovered, 1);
  assert.deepEqual(kept.map((k) => k.title), [
    "Carleton College", "Grinnell College", "University of Rochester", "Case Western Reserve University",
    "University of Pittsburgh", "Macalester College", "Colorado State University",
  ]);
  assert.equal(kept.find((k) => k.title === "University of Pittsburgh")!.sources[0]!.url, "https://admissions.pitt.edu/");
});

test("a realistic college answer: at least five suggestions, spread over reach, target and likely", async () => {
  const { drafts } = await run();
  assert.ok(drafts.length >= 5, `only ${drafts.length} suggestions`);
  const byFit = new Map(FITS.map((f) => [f, drafts.filter((d) => d.details.fit === f).length]));
  for (const f of FITS) assert.ok(byFit.get(f)! >= 1, `no ${f} school in ${JSON.stringify([...byFit])}`);
  // The match model's order is kept, so the bands stay mixed rather than grouped.
  assert.deepEqual(drafts.slice(0, 3).map((d) => d.details.fit), ["reach", "target", "likely"]);
});

test("a realistic college answer: no model markup in any stored field, and the words inside a tag are kept", async () => {
  const { drafts } = await run();
  for (const d of drafts) {
    for (const v of [d.title, d.why, d.details.deadline ?? "", d.details.cost ?? "", ...d.sources.map((s) => s.title ?? "")]) {
      assert.doesNotMatch(v, MARKUP, `${d.title}: ${v}`);
    }
  }
  const by = (t: string) => drafts.find((d) => d.title === t)!;
  assert.equal(by("Grinnell College").details.deadline, "January 15");
  assert.equal(by("Case Western Reserve University").details.deadline, "January 15");
  assert.equal(by("Macalester College").details.cost, "No application fee for online applications.");
  assert.equal(by("Carleton College").why, "A selective college with the biology depth the student wants.");
  assert.equal(by("Grinnell College").why, "Full-need aid and research in the sciences.");
});
