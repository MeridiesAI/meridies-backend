import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSentence, citationSupport, EvidenceIndex, extractFigures, LiveGrounder, type SentenceCheck } from "../../src/lib/axis/grounding.js";
import { SourceLedger } from "../../src/lib/axis/ledger.js";
import { SentenceStream } from "../../src/lib/axis/text.js";

function evidence() {
  const ev = new EvidenceIndex();
  ev.add("GPA (unweighted): 3.874 (4.0 scale)\nSAT: 1520\nACT: 34\n2026-11-01 deadline (application) · Early decision application, Cornell");
  ev.add("Admit rate: 7.3%\nSAT middle 50%: 1480–1560\nAverage net price: $31,456");
  ev.add("admit_rate 0.125");
  return ev;
}

function ledger() {
  const l = new SourceLedger();
  l.add([{ chunkId: "c", documentId: null, studentId: null, title: "Cornell University (Ithaca, NY)", text: "Admit rate: 7.3%\nSAT middle 50%: 1480–1560", score: 1, source: "catalog" }]);
  return l;
}

const status = (s: string) => checkSentence(0, s, evidence(), ledger());

test("figures are pulled out whole: money, percents, dates, ranges, decimals, scores", () => {
  assert.deepEqual(extractFigures("Net price $31,456 and 7.3% admitted by Nov 1.").map((f) => f.text), ["Nov 1", "$31,456", "7.3%"]);
  assert.deepEqual(extractFigures("SAT range 1480–1560, GPA 3.87").map((f) => f.text), ["1480", "1560", "3.87"]);
  assert.deepEqual(extractFigures("Her ACT is 34.").map((f) => f.text), ["34"]);
  assert.deepEqual(extractFigures("She has 3 tasks for the class of 2027.").map((f) => f.text), [], "counts and years aren't facts to check");
  assert.deepEqual(extractFigures("See [S12] for details.").map((f) => f.text), [], "citation markers aren't figures");
});

test("a figure on file is found at the precision written", () => {
  assert.equal(status("Her unweighted GPA is 3.87.").status, "grounded");
  assert.equal(status("Cornell admitted 7.3% of applicants [S1].").status, "grounded");
  assert.equal(status("The average net price is about $31k.").status, "grounded");
  assert.equal(status("The ED deadline is Nov 1.").status, "grounded");
  assert.equal(status("It admits 12.5% of applicants.").status, "grounded", "a fraction on file supports the percentage");
});

test("a wrong or absent figure is marked", () => {
  const wrong = status("Cornell admitted 9% of applicants [S1].");
  assert.equal(wrong.status, "unverified");
  assert.deepEqual(wrong.figures, [{ text: "9%", status: "missing" }]);
  assert.equal(status("Her ACT is 35.").status, "unverified");
  assert.equal(status("The ED deadline is Nov 15.").status, "unverified");
});

test("a difference of two figures in the sentence counts as derived", () => {
  const c = checkSentence(0, "Her 1520 is 40 points above the 1480 that marks the bottom of the SAT middle 50% at Cornell, and 1560 minus 1520 leaves 40.", evidence(), ledger());
  assert.ok(c.figures.every((f) => f.status !== "missing"), JSON.stringify(c.figures));
});

test("citation support: the share of a sentence's words found in what it cites", () => {
  assert.ok(citationSupport("Cornell admitted 7.3% of applicants", ["Admit rate: 7.3%"]) > 0);
  assert.equal(citationSupport("The orchestra tour is in March", ["Admit rate: 7.3%"]), 0);
  assert.equal(status("Her violin recital is in the spring [S1].").status, "weak-citation");
});

test("the sentence splitter keeps decimals, abbreviations and trailing citations whole, across chunk boundaries", () => {
  const s = new SentenceStream();
  const out: string[] = [];
  for (const piece of ["Her GPA is 3.", "87 on a 4.0 scale. She applied E", "D to Cornell in the U.S. last week. Cornell admitted 7.3% [S", "1]. Done"]) out.push(...s.push(piece));
  out.push(...s.flush());
  assert.deepEqual(out, [
    "Her GPA is 3.87 on a 4.0 scale.",
    "She applied ED to Cornell in the U.S. last week.",
    "Cornell admitted 7.3% [S1].",
    "Done",
  ]);
});

test("live grounding checks each sentence as it completes and reports only those with figures or citations", () => {
  const seen: SentenceCheck[] = [];
  const g = new LiveGrounder(evidence(), ledger(), (c) => seen.push(c));
  for (const piece of "Sophia is doing well. Her SAT is 1520 and her ACT is 35. Cornell admitted 7.3% [S1].".match(/.{1,5}/g)!) g.push(piece);
  const all = g.finish();
  assert.equal(seen.length, 2);
  assert.equal(all.length, 2);
  assert.deepEqual(seen[0]!.figures, [{ text: "1520", status: "found" }, { text: "35", status: "missing" }]);
  assert.equal(seen[1]!.status, "grounded");
});
