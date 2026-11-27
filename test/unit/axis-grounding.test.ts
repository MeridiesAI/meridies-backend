import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSentence, citationSupport, EvidenceIndex, extractFigures, LiveGrounder, type SentenceCheck } from "../../src/lib/axis/grounding.js";
import { SourceLedger } from "../../src/lib/axis/ledger.js";
import { SentenceStream } from "../../src/lib/axis/text.js";

function evidence() {
  const ev = new EvidenceIndex();
  ev.add("GPA (unweighted): 3.874 (4.0 scale)\nSAT: 1520\nACT: 34\n2026-11-01 deadline (application) · Early decision application, Cornell");
  // A catalog passage is indexed with its title (lib/axis/planner.ts), so its figures sit next to the school.
  ev.add("Cornell University (Ithaca, NY)\nAdmit rate: 7.3%\nSAT middle 50%: 1480–1560\nAverage net price: $31,456");
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

// ---- Nearness: a figure must sit near the same school or student in the evidence ----

/** Two schools as the planner and the tools index them: each passage with its title. */
function twoSchools(subject: string | null = null, others: string[] = []) {
  const ev = new EvidenceIndex();
  if (subject || others.length) ev.setNames(subject, others);
  ev.add("Cornell University (Ithaca, NY)\nSource: U.S. Department of Education College Scorecard, data year 2023\nAdmit rate: 7.3%\nSAT middle 50%: 1480–1560\nACT middle 50%: 33–35\nAverage net price: $31,456\nUndergraduates: 15,735");
  ev.add("Brown University (Providence, RI)\nSource: U.S. Department of Education College Scorecard, data year 2023\nAdmit rate: 5.1%\nSAT middle 50%: 1500–1570\nACT middle 50%: 34–36\nAverage net price: $29,870\nUndergraduates: 7,222");
  ev.add("What are the admit rates at Brown and Cornell?", { counselor: true });
  return ev;
}
const near = (s: string, ev = twoSchools()) => checkSentence(0, s, ev, new SourceLedger());
const missing = (s: string, ev = twoSchools()) => near(s, ev).figures.filter((f) => f.status === "missing").map((f) => f.text);

test("nearness: a school's figure is found only next to that school", () => {
  assert.deepEqual(missing("Brown's admit rate is 5.1%."), []);
  assert.deepEqual(missing("Cornell's admit rate is 7.3%."), []);
  assert.deepEqual(missing("Brown's admit rate is 7.3%."), ["7.3%"], "Cornell's figure given to Brown");
  assert.deepEqual(missing("Cornell admits 7.3% of applicants and Brown admits 5.1%."), []);
  assert.deepEqual(missing("Cornell admits 5.1% of applicants and Brown admits 7.3%."), ["5.1%", "7.3%"], "values swapped between two schools");
  assert.deepEqual(missing("Brown's admit rate is lower than Cornell's 7.3%."), [], "the figure goes with the school right before it");
  assert.deepEqual(missing("At 5.1%, Brown is more selective than Cornell."), [], "a figure before its school in the clause");
  assert.deepEqual(missing("For Brown, the average net price is $29,870."), []);
  assert.deepEqual(missing("For Brown, the average net price is $31,456."), ["$31,456"]);
  assert.deepEqual(missing("Brown's SAT middle 50% is 1500–1570, while Cornell's is 1480–1560."), []);
  assert.deepEqual(missing("Brown's SAT middle 50% is 1480–1560."), ["1480", "1560"]);
  assert.deepEqual(missing("Brown's ACT range is 33–35."), ["33", "35"]);
});

test("nearness: without a named school or student, any figure on file still counts (today's behaviour)", () => {
  assert.deepEqual(missing("The admit rate is 7.3%."), []);
  assert.deepEqual(missing("Its admit rate is 5.1%."), []);
  assert.deepEqual(missing("The admit rate is 9.9%."), ["9.9%"]);
  // A name AxIS never read is no basis for a check: nicknames and short names stay lenient.
  assert.deepEqual(missing("Penn's admit rate is 7.3%."), []);
});

test("nearness: a name only in the counselor's question still pins the figure", () => {
  const ev = new EvidenceIndex();
  ev.add("Cornell University (Ithaca, NY)\nAdmit rate: 7.3%");
  ev.add("Compare Dartmouth with Cornell", { counselor: true });
  assert.deepEqual(missing("Dartmouth admits 7.3% of applicants.", ev), ["7.3%"]);
  assert.deepEqual(missing("Cornell admits 7.3% of applicants.", ev), []);
});

test("nearness: figures the counselor typed are theirs to quote", () => {
  const ev = new EvidenceIndex();
  ev.add("Brown University (Providence, RI)\nAdmit rate: 5.1%");
  ev.add("Brown told me their ED rate is 14.4% this year", { counselor: true });
  assert.deepEqual(missing("Brown's ED rate is 14.4%.", ev), []);
});

function students() {
  const ev = new EvidenceIndex();
  ev.setNames("Sophia Chen", ["Sophia Chen", "Liam Patel"]);
  // The chat student's record: her name is in the Student section, her figures further down.
  ev.add("## Student\nName: Sophia Chen\nGraduation year: 2027\n\n## Academics\nGPA (unweighted): 3.874 (4.0 scale)\nSAT: 1520\nACT: 34\n\n## Activities\n12 activities, in the order the student ranked them.");
  // Another student's record, read for a comparison.
  ev.add("## Student\nName: Liam Patel\n\n## Academics\nGPA (unweighted): 3.61\nSAT: 1440");
  // What is due for the chat student: no name on the lines.
  ev.add("## Due in the next 14 days (today is 2026-11-26)\n2026-12-01 deadline · <data source=\"deadline\" kind=\"untrusted\" length=\"short\">Early decision application, Cornell</data>");
  ev.add("## Caseload ranking (computed)\n1. Sophia Chen (score 7): 3 overdue tasks; 1 open red flag\n2. Liam Patel (score 4): 1 overdue task");
  ev.add("Cornell University (Ithaca, NY)\nAdmit rate: 7.3%\nSAT middle 50%: 1480–1560");
  return ev;
}

test("nearness: a student's figure is found in their record, not another student's", () => {
  const ev = students();
  assert.deepEqual(missing("Sophia's unweighted GPA is 3.87.", ev), []);
  assert.deepEqual(missing("Liam's unweighted GPA is 3.61.", ev), []);
  assert.deepEqual(missing("Sophia's unweighted GPA is 3.61.", ev), ["3.61"], "Liam's GPA given to Sophia");
  assert.deepEqual(missing("Liam has a 1520 SAT.", ev), ["1520"], "Sophia's SAT given to Liam");
  assert.deepEqual(missing("Sophia's 1520 sits inside Cornell's 1480–1560 range.", ev), []);
  assert.deepEqual(missing("Her 1520 sits inside Cornell's 1480–1560 range.", ev), [], "her = the chat student");
  assert.deepEqual(missing("Sophia's Cornell application is due Dec 1.", ev), [], "a line about the chat student without her name");
  assert.deepEqual(missing("Liam's Cornell application is due Dec 1.", ev), ["Dec 1"]);
  assert.deepEqual(missing("Cornell is a reach: her record is strong but the admit rate is 7.3%.", ev), [], "a clause naming nothing goes with the nearest name, not a pronoun");
});

// ---- Counts ----

test("counts: a small count is checked when the evidence states a count of the same thing", () => {
  const ev = students();
  assert.deepEqual(missing("Sophia has 3 overdue tasks.", ev), []);
  assert.deepEqual(missing("Sophia has 2 overdue tasks.", ev), ["2 overdue tasks"]);
  assert.deepEqual(missing("Liam has 1 overdue task.", ev), []);
  assert.deepEqual(missing("Liam has 3 overdue tasks.", ev), ["3 overdue tasks"], "Sophia's count given to Liam");
  assert.deepEqual(missing("Sophia lists 12 activities.", ev), []);
  assert.deepEqual(missing("Sophia lists 10 activities.", ev), ["10 activities"]);
  // Nothing on file states a count of these: arithmetic over a list, left to the model.
  assert.deepEqual(missing("Sophia has 4 essays in progress.", ev), []);
  assert.deepEqual(missing("Her deadline is in 5 days.", ev), [], "time spans are not counts on file");
  assert.equal(near("Sophia has 4 essays in progress.", ev).figures.length, 0, "an unchecked count isn't reported as a figure");
  assert.deepEqual(extractFigures("She has 3 overdue tasks.", { counts: true }).map((f) => [f.text, f.kind, f.noun]), [["3 overdue tasks", "count", "task"]]);
});

// ---- Rounding ----

test("rounding: only sensible rounding to the precision written", () => {
  assert.equal(status("Her unweighted GPA is 3.87.").status, "grounded");
  assert.equal(status("Her unweighted GPA is 3.9.").status, "grounded", "two significant figures");
  assert.equal(status("Her GPA is 4.").status, "unverified", "3.874 is not a 4, and the 4.0 scale is not her GPA");
  assert.equal(status("Her GPA is 3.874 on a 4.0 scale.").status, "grounded", "the scale itself is quoted as a scale");
  assert.equal(status("Her GPA is 3.874 out of 4.0.").status, "grounded");
  assert.equal(status("It admits 13% of applicants.").status, "grounded", "0.125 on file, 12.5%, rounds to 13%");
  assert.equal(status("It admits 12% of applicants.").status, "unverified");
  assert.equal(status("Cornell admits 7% of applicants.").status, "unverified", "7.3% to one significant figure loses too much");
  assert.equal(status("Cornell admits about 7% of applicants.").status, "grounded", "unless the answer says it's approximate");
  assert.equal(status("Her GPA is about 4.").status, "unverified", "a GPA isn't rounded to a whole point, hedged or not");
});

test("money: rounded amounts only from amounts of money, at the rounding written", () => {
  assert.equal(status("The average net price is about $31k.").status, "grounded");
  assert.equal(status("The average net price is $31,456.").status, "grounded");
  assert.equal(status("The average net price is $31.5k.").status, "grounded");
  assert.equal(status("The average net price is $32k.").status, "unverified", "31,456 rounds to 31k, not 32k");
  assert.equal(status("The average net price is $31.4k.").status, "unverified", "31,456 rounds to 31.5k");
  const ev = new EvidenceIndex();
  ev.add("Undergraduates: 12,103\nAverage net price: $27,900");
  assert.equal(checkSentence(0, "Tuition runs about $12k.", ev, ledger()).status, "unverified", "an enrollment is not a price");
  assert.equal(checkSentence(0, "The net price is about $28k.", ev, ledger()).status, "grounded");
});

test("dates: the day must match, and the year too when both sides state one", () => {
  assert.equal(status("The ED deadline is November 1, 2026.").status, "grounded");
  assert.equal(status("The ED deadline is November 1, 2027.").status, "unverified", "right day, wrong year");
  assert.equal(status("The ED deadline is 11/1/2027.").status, "unverified");
  assert.equal(status("The ED deadline is 11/1.").status, "grounded", "no year in the answer: the day is enough");
  const ev = new EvidenceIndex();
  ev.add("Interview on March 3");
  assert.equal(checkSentence(0, "Her interview is March 3, 2027.", ev, ledger()).status, "grounded", "no year on file: the day is enough");
  assert.equal(checkSentence(0, "Her interview is March 4, 2027.", ev, ledger()).status, "unverified");
});

test("dates: swapped deadlines between two schools are caught", () => {
  const ev = new EvidenceIndex();
  ev.add("2026-11-01 deadline · Early decision application, Cornell\n2026-11-15 deadline · Early decision application, Brown");
  ev.add("When are her Brown and Cornell deadlines?", { counselor: true });
  assert.equal(checkSentence(0, "Cornell's ED deadline is Nov 1 and Brown's is Nov 15.", ev, ledger()).status, "grounded");
  const swapped = checkSentence(0, "Cornell's ED deadline is Nov 15 and Brown's is Nov 1.", ev, ledger());
  assert.deepEqual(swapped.figures.map((f) => f.status), ["missing", "missing"]);
});

test("existing answers in the evals' style stay grounded", () => {
  const ev = students();
  for (const s of [
    "Sophia Chen has a 3.87 unweighted GPA and a 1520 SAT, which puts her inside Cornell's 1480–1560 middle 50%.",
    "Cornell admitted 7.3% of applicants in the latest data year.",
    "Her ACT is 34.",
    "Liam Patel has a 3.61 GPA and a 1440 SAT.",
    "Sophia is 40 points above the 1480 floor with her 1520.",
    "Sophia Chen (class of 2027) has an Early decision application to Cornell due 2026-12-01.",
  ]) assert.deepEqual(missing(s, ev), [], s);
});

test("nearness: in the roster view each JSON object is its own passage", () => {
  const ev = new EvidenceIndex();
  ev.setNames(null, ["Sophia Chen", "Liam Patel"]);
  ev.add(JSON.stringify({
    today: "2026-11-26",
    students: [{ name: "Sophia Chen", gradYear: 2027 }, { name: "Liam Patel", gradYear: 2027 }],
    deadlinesNext3Weeks: [
      { student: "Sophia Chen", title: "Early decision application", school: "Cornell", due_date: "2026-12-01" },
      { student: "Liam Patel", title: "Early action application", school: "Brown", due_date: "2026-12-10" },
    ],
  }, null, 1));
  assert.deepEqual(missing("Sophia Chen's Cornell application is due Dec 1.", ev), []);
  assert.deepEqual(missing("Liam's Brown application is due Dec 10.", ev), []);
  assert.deepEqual(missing("Liam's application is due Dec 1.", ev), ["Dec 1"], "Sophia's deadline given to Liam");
  assert.deepEqual(missing("The next deadline is Dec 1.", ev), [], "no name: any deadline on file");
});

test("hedging never rescues a figure that belongs to another school", () => {
  assert.deepEqual(missing("Brown admits about 7% of applicants."), ["7%"]);
  assert.deepEqual(missing("Cornell admits about 7% of applicants."), []);
});
