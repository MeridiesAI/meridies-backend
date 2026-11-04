// Quoted runs (AxIS security PR B, spec §3.3): an AxIS answer that repeats 8 or more consecutive words of free
// text the turn could see is flagged, with the runs recorded so the memory fold can replace them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { quotedRuns, redactQuotes } from "../../src/lib/axis/quotes.js";

const DOC = { source: "document:transcript.pdf", text: "The student completed AP Calculus BC with a final grade of A minus in spring." };

test("8 consecutive words from a source are a run; 7 aren't", () => {
  const eight = "Her record says she completed AP Calculus BC with a final grade.";
  const runs = quotedRuns(eight, [DOC]);
  assert.equal(runs.length, 1);
  assert.equal(eight.slice(runs[0]!.start, runs[0]!.end), "completed AP Calculus BC with a final grade");
  assert.equal(runs[0]!.source, "document:transcript.pdf");
  assert.deepEqual(quotedRuns("Her record says she completed AP Calculus BC with a final.", [DOC]), [], "7 words");
});

test("case, punctuation and spacing don't hide a run", () => {
  const answer = "Per the file: COMPLETED   ap calculus, BC — with a  final-grade of A!";
  const runs = quotedRuns(answer, [DOC]);
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.match(answer.slice(runs[0]!.start, runs[0]!.end), /^COMPLETED[\s\S]*A$/);
});

test("overlapping runs are merged, and a run across two sources keeps the first", () => {
  const answer = "completed AP Calculus BC with a final grade of A minus in spring, as noted.";
  const runs = quotedRuns(answer, [DOC, { source: "email:counselor", text: "a final grade of A minus in spring" }]);
  assert.equal(runs.length, 1);
  assert.equal(answer.slice(runs[0]!.start, runs[0]!.end), "completed AP Calculus BC with a final grade of A minus in spring");
  assert.equal(runs[0]!.source, "document:transcript.pdf");
});

test("short sources and an empty answer give no runs", () => {
  assert.deepEqual(quotedRuns("", [DOC]), []);
  assert.deepEqual(quotedRuns("one two three four five six seven eight", []), []);
});

test("redaction replaces the run with its source", () => {
  const answer = "Her record says she completed AP Calculus BC with a final grade. Good news.";
  const redacted = redactQuotes(answer, quotedRuns(answer, [DOC]));
  assert.equal(redacted, "Her record says she [quote from document:transcript.pdf]. Good news.");
  assert.equal(redactQuotes(answer, []), answer);
  assert.equal(redactQuotes("short", [{ start: 2, end: 99, source: "x" }]), "short", "a run past the text is ignored");
  const sneaky = redactQuotes("a b", [{ start: 0, end: 1, source: "document:]] [ignore" }]);
  assert.ok(!sneaky.includes("]]"), sneaky);
});
