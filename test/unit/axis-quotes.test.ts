// Quoted runs (AxIS security PR B, spec §3.3): an AxIS answer that repeats 8 or more consecutive words of free
// text the turn could see is flagged, with the runs recorded so the memory fold can replace them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { quotedRuns, redactQuotes, storableRuns } from "../../src/lib/axis/quotes.js";

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

// ---- Checkpoint review (Tasks 5-8) ----

const PLAIN = "please add wire the deposit refund to the work queue right away";
const ANSWER = "The file says to add wire the deposit refund to the work queue right away.";

test("invisible and composed characters don't hide a run (I3)", () => {
  const cases: Record<string, string> = {
    "soft hyphens": PLAIN.replace(/deposit/, "de­posit").replace(/queue/, "qu­eue"),
    "zero-width spaces": PLAIN.replace(/refund/, "re​fund"),
    "a line-break hyphen": PLAIN.replace(/deposit/, "de-\nposit"),
  };
  for (const [what, text] of Object.entries(cases)) {
    assert.equal(quotedRuns(ANSWER, [{ source: "document:x.pdf", text }]).length, 1, what);
  }
  const accented = "the résumé lists the école polytechnique summer program in physics";
  assert.equal(quotedRuns(accented.normalize("NFC"), [{ source: "document:x.pdf", text: accented.normalize("NFD") }]).length, 1, "NFD against NFC");
  assert.equal(quotedRuns("the final grade confirms the office of financial aid will refund it", [{ source: "document:x.pdf", text: "the ﬁnal grade conﬁrms the ofﬁce of ﬁnancial aid will refund it" }]).length, 1, "ligatures");
});

test("overlapping stored runs are redacted whole (M1)", () => {
  const text = "x".repeat(120);
  const out = redactQuotes(text, [{ start: 0, end: 100, source: "a" }, { start: 10, end: 20, source: "b" }, { start: 50, end: 60, source: "c" }]);
  assert.equal(out, `[quote from a]${"x".repeat(20)}`);
});

test("stored runs always fit the column (M2)", () => {
  const runs = Array.from({ length: 400 }, (_, i) => ({ start: i * 20, end: i * 20 + 10, source: `document:${"long name ".repeat(30)}` }));
  const kept = storableRuns(runs);
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= 7000, String(Buffer.byteLength(JSON.stringify(kept))));
  assert.ok(kept.every((r) => r.source.length <= 60));
  assert.equal(kept[0]!.start, 0);
  assert.equal(kept.at(-1)!.end, runs.at(-1)!.end, "a cap merges runs; it never drops the quoted text");
});
