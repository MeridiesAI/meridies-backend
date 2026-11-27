import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitDates, parseWindow, schoolBreak } from "../../src/lib/axis/dates.js";
import { CollegeIndex, jaroWinkler, RosterIndex } from "../../src/lib/axis/entities.js";
import { asksForEssayText, attributesOf, nextState, pickCandidate, understand } from "../../src/lib/axis/nlu.js";
import { splitClauses, tokens } from "../../src/lib/axis/text.js";

const NOW = new Date("2026-10-11T15:00:00Z"); // a Sunday

const roster = new RosterIndex([
  { id: "s1", name: "Sophia Martinez" },
  { id: "s2", name: "Ethan Park" },
  { id: "s3", name: "Will Chen" },
  { id: "s4", name: "Sophia Okafor" },
  { id: "s5", name: "Maya Brooks" },
  { id: "s6", name: "Daniel O'Brien" },
  { id: "s7", name: "Lucas Nguyen" },
]);

const colleges = new CollegeIndex([
  { id: "c1", name: "Cornell University", search_name: "cornell university", search_aka_list: [], catalog_source: "meridies" },
  { id: "c2", name: "Brown University", search_name: "brown university", search_aka_list: [], catalog_source: "meridies" },
  { id: "c3", name: "University of Michigan-Ann Arbor", search_name: "university of michigan ann arbor", search_aka_list: [], catalog_source: "scorecard" },
  { id: "c4", name: "Michigan State University", search_name: "michigan state university", search_aka_list: [], catalog_source: "scorecard" },
  { id: "c5", name: "Boston College", search_name: "boston college", search_aka_list: [], catalog_source: "scorecard" },
  { id: "c6", name: "Boston University", search_name: "boston university", search_aka_list: [], catalog_source: "scorecard" },
  { id: "c7", name: "Massachusetts Institute of Technology", search_name: "massachusetts institute of technology", search_aka_list: [], catalog_source: "meridies" },
  { id: "c8", name: "University of California-Los Angeles", search_name: "university of california los angeles", search_aka_list: [], catalog_source: "meridies" },
  { id: "c9", name: "Bethel University", search_name: "bethel university", search_aka_list: [], catalog_source: "scorecard" },
  { id: "c10", name: "Bethel University", search_name: "bethel university", search_aka_list: [], catalog_source: "scorecard" },
  { id: "c11", name: "Duke University", search_name: "duke university", search_aka_list: [], catalog_source: "meridies" },
  { id: "c12", name: "Northeastern University", search_name: "northeastern university", search_aka_list: [], catalog_source: "meridies" },
  { id: "c13", name: "Tufts University", search_name: "tufts university", search_aka_list: [], catalog_source: "meridies" },
]);

const u = (text: string, chat: string | null = "s1") => understand(text, { chatStudentId: chat, roster, colleges, state: null, now: NOW });

// Three sets of counselor questions. The first tuned the lexicon. The second and third were each
// scored once before any change (25/28 and 26/30), then their misses were fixed. They stay here
// as a regression suite; a fresh set is the only honest measure of accuracy on new phrasing.
const LABELED: [string, string | null, string[]][] = [
  // Set 1 (tuning)
  ["What's her GPA?", "s1", ["record"]], ["what is sophia's sat score", "s1", ["record"]], ["When is her next deadline?", "s1", ["record"]],
  ["What's due this week?", "s1", ["record"]], ["Did her mom reply to my email about the CSS Profile?", "s1", ["email"]],
  ["What did her dad say in his last email?", "s1", ["email"]], ["What grade did she get in AP Bio on her transcript?", "s1", ["documents"]],
  ["Find her resume", "s1", ["documents"]], ["Summarize her recommendation letter", "s1", ["documents"]], ["What's Cornell's admit rate?", "s1", ["colleges"]],
  ["Is Cornell a reach for her?", "s1", ["strategy"]], ["Should she apply ED to Cornell?", "s1", ["strategy"]],
  ["How can we strengthen her application?", "s1", ["strategy"]], ["What are her biggest gaps?", "s1", ["strategy"]],
  ["Compare Cornell and Brown for her", "s1", ["strategy"]], ["Remind me to call her parents on Friday", "s1", ["action"]],
  ["Draft an email to her parents about the deadline", "s1", ["action"]], ["Add a task to review her supplements", "s1", ["action"]],
  ["Write her Why Cornell essay", "s1", ["essay"]], ["Can you rewrite the intro of her personal statement?", "s1", ["essay"]], ["thanks!", "s1", ["chitchat"]],
  ["What activities does she do?", "s1", ["record"]], ["What are her intended majors?", "s1", ["record"]], ["Any notes from our last meeting?", "s1", ["record"]],
  ["Who is behind this week?", null, ["roster"]], ["Which students have overdue tasks?", null, ["roster"]], ["How many students do I have?", null, ["roster"]],
  ["Who should I focus on today?", null, ["roster", "strategy"]], ["What's due this week?", null, ["roster"]], ["How is Ethan doing?", null, ["record"]],
  ["What's Ethan's GPA?", null, ["record"]], ["Did anyone email me about the Common App?", null, ["email"]], ["What's Cornell's ED deadline?", null, ["colleges"]],
  ["What deadlines are coming up?", null, ["roster"]], ["Remind me to send the fee waivers Monday", null, ["action"]],
  ["What's the acceptance rate at MIT and UCLA?", null, ["colleges"]], ["Did Maya's dad reply about the deposit?", null, ["email"]],
  ["Is Maya's transcript uploaded?", null, ["documents"]], ["Will she get into Boston College?", "s1", ["strategy"]],
  ["Email the parents that the Cornell supplement is due Friday", "s1", ["action"]],
  // Set 2 (scored once before fixes: 25/28)
  ["remind me what her unweighted GPA is", "s1", ["record"]], ["SAT?", "s1", ["record"]], ["anything due for her before thanksgiving", "s1", ["record"]],
  ["has her mother written back yet", "s1", ["email"]], ["check my inbox for anything from the Martinez family", "s1", ["email"]],
  ["what does her school profile say about AP limits", "s1", ["documents"]], ["is her score report uploaded", "s1", ["documents"]],
  ["Duke's acceptance rate", "s1", ["colleges"]], ["net price at Boston College", "s1", ["colleges"]], ["is Brown realistic for her", "s1", ["strategy"]],
  ["what would you prioritize for her this month", "s1", ["strategy"]], ["where are the weak spots in her profile", "s1", ["strategy"]],
  ["put 'review Brown supplement' on my queue for Friday", "s1", ["action"]], ["write an email to her dad about the fee waiver", "s1", ["action"]],
  ["polish her common app essay intro", "s1", ["essay"]], ["thank you", "s1", ["chitchat"]], ["how many awards does she have", "s1", ["record"]],
  ["what's her class rank", "s1", ["record"]], ["which of my students haven't started their essays", null, ["roster"]], ["anyone with overdue deadlines?", null, ["roster"]],
  ["what's on the calendar next week", null, ["roster"]], ["how's Maya's testing going", null, ["record"]], ["Ethan's intended major?", null, ["record"]],
  ["did Daniel O'Brien's parents email me", null, ["email"]], ["UCLA middle 50 SAT", null, ["colleges"]], ["schedule a check in with Ethan next Tuesday", null, ["action"]],
  ["should Maya apply early decision anywhere", null, ["strategy"]], ["who needs attention this week", null, ["roster"]],
  // Set 3 (scored once before fixes: 26/30)
  ["what ACT did she get", "s1", ["record"]], ["list her activities", "s1", ["record"]], ["what's she planning to major in", "s1", ["record"]],
  ["when's our next meeting", "s1", ["record"]], ["did the dad ever answer my question about visits", "s1", ["email"]],
  ["find the email where her mom mentioned the scholarship", "s1", ["email"]], ["what did her teacher say in the recommendation letter", "s1", ["documents"]],
  ["pull up her transcript grades for junior year", "s1", ["documents"]], ["how big is Tufts", "s1", ["colleges"]], ["Northeastern's average net price?", "s1", ["colleges"]],
  ["would Tufts or Northeastern be a better fit", "s1", ["strategy"]], ["is she on track", "s1", ["strategy", "record"]],
  ["what should our focus be in the next meeting", "s1", ["strategy"]], ["give me three ways to strengthen her list", "s1", ["strategy"]],
  ["add a reminder to check her FAFSA status", "s1", ["action"]], ["send a note to her parents about the deposit deadline", "s1", ["action"]],
  ["draft her supplement for Tufts", "s1", ["essay"]], ["got it, thanks", "s1", ["chitchat"]], ["who has nothing on their college list yet", null, ["roster"]],
  ["which students have a deadline tomorrow", null, ["roster"]], ["give me a rundown of my caseload", null, ["roster"]], ["what's Lucas's GPA", null, ["record"]],
  ["is Maya ready for her Cornell application", null, ["strategy", "record"]], ["did Ethan's mom email about the visit", null, ["email"]],
  ["acceptance rate for Cornell", null, ["colleges"]], ["create a task to call Lucas's parents Thursday", null, ["action"]],
  ["anybody stalled on essays", null, ["roster"]], ["Maya's test scores", null, ["record"]],
  ["which schools on Maya's list are reaches", null, ["strategy", "colleges", "record"]], ["hi", null, ["chitchat"]],
];

test(`intent on ${LABELED.length} labeled counselor questions`, () => {
  const misses = LABELED.filter(([text, chat, want]) => !want.includes(u(text, chat).intent)).map(([t, chat]) => `${t} -> ${u(t, chat).intent}`);
  const accuracy = 1 - misses.length / LABELED.length;
  assert.ok(accuracy >= 0.95, `accuracy ${accuracy.toFixed(2)}; misses:\n${misses.join("\n")}`);
});

test("compound questions split into their parts", () => {
  const x = u("Did her mom reply about the CSS Profile, and what's Cornell's admit rate?");
  assert.equal(x.clauses.length, 2);
  assert.deepEqual(x.clauses.map((c) => c.intent), ["email", "colleges"]);
  assert.deepEqual(splitClauses("What is her GPA? Is it competitive for Brown?"), ["What is her GPA?", "Is it competitive for Brown?"]);
});

test("students: full name, unique first name, possessive, close spelling, ambiguity, common-word names", () => {
  assert.deepEqual(roster.match("How is Ethan Park doing").students.map((s) => [s.id, s.via]), [["s2", "full"]]);
  assert.deepEqual(roster.match("Maya's essays").students.map((s) => s.id), ["s5"]);
  assert.deepEqual(roster.match("what about Ethen's scores").students.map((s) => [s.id, s.via]), [["s2", "fuzzy"]]);
  const two = roster.match("Sophia's deadlines");
  assert.equal(two.students.length, 0);
  assert.deepEqual(two.ambiguous[0]?.candidates.map((c) => c.id).sort(), ["s1", "s4"]);
  assert.deepEqual(roster.match("Sophia Okafor's GPA").students.map((s) => s.id), ["s4"]);
  assert.equal(roster.match("Will she get in?").students.length, 0, "a sentence-initial common word isn't a name");
  assert.deepEqual(roster.match("What's Will's SAT?").students.map((s) => s.id), ["s3"]);
  assert.deepEqual(roster.match("daniel obrien").students.map((s) => s.id), ["s6"]);
});

test("colleges: longest match, short forms, abbreviations, places and ambiguity", () => {
  const ids = (t: string) => colleges.match(t).colleges.map((c) => c.id).sort();
  assert.deepEqual(ids("Boston College vs Boston University"), ["c5", "c6"]);
  assert.deepEqual(ids("what about Cornell"), ["c1"]);
  assert.deepEqual(ids("cornell's admit rate"), ["c1"]);
  assert.deepEqual(ids("MIT and UCLA"), ["c7", "c8"]);
  assert.deepEqual(ids("University of Michigan"), ["c3"]);
  assert.deepEqual(ids("colleges in Michigan"), []);
  assert.deepEqual(ids("brown"), [], "an everyday word in lower case isn't a school");
  assert.deepEqual(ids("What about Brown?"), ["c2"]);
  assert.equal(colleges.match("Bethel University").ambiguous.length, 1);
});

test("pronouns pick up the last turn's student in a roster chat, and expire", () => {
  const state = { students: [{ id: "s2", name: "Ethan Park" }], colleges: [{ id: "c1", name: "Cornell University" }], at: "2026-10-11T14:50:00Z" };
  const x = understand("what's his GPA", { chatStudentId: null, roster, colleges, state, now: NOW });
  assert.deepEqual(x.students.map((s) => [s.id, s.via]), [["s2", "pronoun"]]);
  const y = understand("and the admit rate there?", { chatStudentId: null, roster, colleges, state, now: NOW });
  assert.deepEqual(y.colleges.map((c) => c.id), ["c1"]);
  const stale = understand("what's his GPA", { chatStudentId: null, roster, colleges, state: { ...state, at: "2026-10-11T13:00:00Z" }, now: NOW });
  assert.equal(stale.students.length, 0);
  const next = nextState(u("compare Cornell and Brown", null), state, null, NOW);
  assert.deepEqual(next.colleges.map((c) => c.id), ["c1", "c2"]);
});

test("attributes: student facts versus school figures", () => {
  assert.deepEqual(attributesOf(tokens("what's her GPA and SAT").join(" ")), ["gpa", "sat"]);
  assert.deepEqual(attributesOf(tokens("Cornell's SAT range").join(" ")), ["sat_range"]);
  assert.deepEqual(attributesOf(tokens("what's due this week").join(" ")), ["deadline"]);
});

test("judgement words keep a lookup off the direct path", () => {
  assert.equal(u("what's her GPA").judgement, false);
  assert.equal(u("is her GPA good enough for Cornell").judgement, true);
  assert.equal(u("would her SAT be above the median").judgement, true);
});

test("relative dates", () => {
  assert.deepEqual(parseWindow("what's due this week", NOW), { from: "2026-10-11", to: "2026-10-11", label: "this week" });
  assert.deepEqual(parseWindow("next week", NOW), { from: "2026-10-12", to: "2026-10-18", label: "next week" });
  assert.deepEqual(parseWindow("in the next 10 days", NOW), { from: "2026-10-11", to: "2026-10-21", label: "next 10 days" });
  assert.deepEqual(parseWindow("by Friday", NOW), { from: "2026-10-11", to: "2026-10-16", label: "by friday" });
  assert.deepEqual(parseWindow("before Nov 1", NOW), { from: "2026-10-11", to: "2026-11-01", label: "by 2026-11-01" });
  assert.equal(parseWindow("anything overdue", NOW)?.from, null);
  assert.equal(parseWindow("what's her SAT", NOW), null, "SAT is not Saturday");
  assert.equal(parseWindow("tomorrow", NOW)?.to, "2026-10-12");
});

test("Jaro-Winkler", () => {
  assert.equal(jaroWinkler("sophia", "sophia"), 1);
  assert.ok(jaroWinkler("sofia", "sophia") > 0.85);
  assert.ok(jaroWinkler("ethan", "maya") < 0.6);
});

test("asking AxIS to write an activity description is an essay request; copying one from the resume is a change", () => {
  const u = (t: string) => understand(t, { chatStudentId: "s1", roster: null, colleges: null, state: null, now: NOW }).intent;
  assert.equal(u("write a description for it"), "essay");
  assert.equal(u("rewrite the activity description"), "essay");
  assert.equal(u("come up with a blurb for her robotics club"), "essay");
  assert.equal(u("add the description from her resume"), "action");
});

test("an essay turn says it doesn't write essay text only when asked to write it (P2-2)", () => {
  const asks = (t: string) => {
    const x = understand(t, { chatStudentId: "s1", roster: null, colleges: null, state: null, now: NOW });
    assert.equal(x.intent, "essay", t);
    return asksForEssayText(x.text, x.norm);
  };
  // Asked to write or rewrite text.
  for (const t of ["Write her Why Cornell essay", "Rewrite her intro", "Can you tighten her Why Cornell essay?", "Please polish her common app essay intro", "draft her supplement for Tufts", "Could I get a draft of her personal statement?"]) {
    assert.equal(asks(t), true, t);
  }
  // Asking for advice about an essay.
  for (const t of ["How can she improve her essay?", "What should she fix in her personal statement?", "Any tips to strengthen her supplement?", "Help her improve her essay", "can you help her improve her essay"]) {
    assert.equal(asks(t), false, t);
  }
  // "Could I get…" asks for text only when what it asks for is text.
  assert.equal(asksForEssayText("Could I get feedback on her essay?", "could i get feedback on her essay"), false);
  assert.equal(asksForEssayText("Can I get a new intro for her essay?", "can i get a new intro for her essay"), true);
});

test("fixed-rule dates: Thanksgiving, Christmas, New Year's, end of month", () => {
  assert.deepEqual(parseWindow("what's due before thanksgiving", NOW), { from: "2026-10-11", to: "2026-11-26", label: "by Thanksgiving (Nov 26)" });
  assert.deepEqual(parseWindow("anything due on Thanksgiving?", NOW), { from: "2026-11-26", to: "2026-11-26", label: "on Thanksgiving (Nov 26)" });
  // The next occurrence: the day after Thanksgiving it is next year's (the fourth Thursday of November 2027).
  assert.equal(parseWindow("by thanksgiving", new Date("2026-11-27T12:00:00Z"))?.to, "2027-11-25");
  assert.equal(parseWindow("by thanksgiving", new Date("2026-11-26T12:00:00Z"))?.to, "2026-11-26", "on the day itself, today");
  assert.deepEqual(parseWindow("what's due by Christmas", NOW), { from: "2026-10-11", to: "2026-12-25", label: "by Christmas (Dec 25)" });
  assert.equal(parseWindow("due by christmas eve", NOW)?.to, "2026-12-24");
  assert.equal(parseWindow("due before New Year's Eve", NOW)?.to, "2026-12-31");
  assert.equal(parseWindow("anything due by new year's", NOW)?.to, "2027-01-01");
  assert.equal(parseWindow("due by New Year’s Day", NOW)?.to, "2027-01-01");
  assert.deepEqual(parseWindow("what's due by the end of the month", NOW), { from: "2026-10-11", to: "2026-10-31", label: "by the end of the month" });
  assert.deepEqual(parseWindow("due by end of next month", NOW), { from: "2026-10-11", to: "2026-11-30", label: "by the end of next month" });
  assert.equal(parseWindow("what's due after thanksgiving", NOW), null, "after a holiday isn't a window the code builds");
});

test("fixed-rule dates count from the counselor's today in their zone, not UTC's", () => {
  const LA = "America/Los_Angeles";
  // 7pm on Thanksgiving in Los Angeles is already Nov 27 in UTC: still Thanksgiving for the counselor.
  const thanksgivingEvening = new Date("2026-11-27T03:00:00Z");
  assert.deepEqual(parseWindow("anything due by thanksgiving?", thanksgivingEvening, LA), { from: "2026-11-26", to: "2026-11-26", label: "by Thanksgiving (Nov 26)" });
  assert.equal(parseWindow("anything due by thanksgiving?", thanksgivingEvening, "UTC")?.to, "2027-11-25", "in UTC it would already be next year's");
  // 8pm on New Year's Eve in Los Angeles: New Year's Eve is today, not next year's.
  const nyeEvening = new Date("2027-01-01T04:00:00Z");
  assert.equal(parseWindow("due by new year's eve", nyeEvening, LA)?.to, "2026-12-31");
  assert.equal(parseWindow("due by new year's eve", nyeEvening, "UTC")?.to, "2027-12-31");
  // 7pm on Oct 31 in Los Angeles: the end of the month is today.
  assert.deepEqual(parseWindow("what's due by the end of the month", new Date("2026-11-01T02:00:00Z"), LA), { from: "2026-10-31", to: "2026-10-31", label: "by the end of the month" });
  // A reply's dates are read from the counselor's year too.
  assert.deepEqual(explicitDates("Dec 31", nyeEvening, LA), ["2026-12-31"]);
});

test("school breaks are never guessed: no window, and the break is named for the question back", () => {
  assert.equal(parseWindow("what's due before winter break", NOW), null);
  assert.equal(parseWindow("anything due over Christmas break?", NOW), null, "a school's Christmas break is not Christmas Day");
  assert.equal(parseWindow("overdue or due before spring break", NOW), null);
  assert.equal(schoolBreak("what's due before winter break"), "winter break");
  assert.equal(schoolBreak("anything due over Christmas break?"), "Christmas break");
  assert.equal(schoolBreak("due before the holidays"), "the holiday break");
  assert.equal(schoolBreak("what's due by thanksgiving"), null);
  assert.deepEqual(explicitDates("Dec 19", NOW), ["2026-12-19"]);
  assert.deepEqual(explicitDates("Dec 20 to Jan 4", NOW), ["2026-12-20", "2027-01-04"]);
  assert.deepEqual(explicitDates("12/20-1/4", NOW), ["2026-12-20", "2027-01-04"]);
});

// Two students with one first name, for the code's own "which one?".
const twins = new RosterIndex([
  { id: "a1", name: "Alex Chen", gradYear: "2027" },
  { id: "a2", name: "Alex Park", gradYear: "2028" },
  { id: "s5", name: "Maya Brooks" },
]);
const ask = { kind: "student" as const, question: "What's Alex's GPA?", candidates: [{ id: "a1", name: "Alex Chen", grade: 12 }, { id: "a2", name: "Alex Park", grade: 11 }] };

test("which student: the reply to the code's question resolves by last name, grade or position", () => {
  assert.equal(pickCandidate("Chen", ask.candidates), 0);
  assert.equal(pickCandidate("Alex Park", ask.candidates), 1);
  assert.equal(pickCandidate("the 12th grader", ask.candidates), 0);
  assert.equal(pickCandidate("the junior", ask.candidates), 1);
  assert.equal(pickCandidate("the first one", ask.candidates), 0);
  assert.equal(pickCandidate("second", ask.candidates), 1);
  assert.equal(pickCandidate("2", ask.candidates), 1);
  assert.equal(pickCandidate("Alex", ask.candidates), null, "the shared name decides nothing");
  assert.equal(pickCandidate("Chen, the junior", ask.candidates), null, "signals that disagree decide nothing");
  assert.equal(pickCandidate("the sophomore", ask.candidates), null);
  assert.equal(pickCandidate("Chan", ask.candidates), null, "never a close spelling between students");
  assert.equal(pickCandidate("what is the admit rate for the first school on her list", ask.candidates), null, "a new question isn't a reply");
});

test("which student: the remembered question is answered about the chosen student", () => {
  const state = { students: [], colleges: [], at: "2026-10-11T14:58:00Z", pending: ask };
  const first = understand("What's Alex's GPA?", { chatStudentId: null, roster: twins, colleges, state: null, now: NOW });
  assert.equal(first.ambiguousStudents.length, 1);
  const x = understand("the 12th grader", { chatStudentId: null, roster: twins, colleges, state, now: NOW });
  assert.deepEqual(x.students.map((s) => [s.id, s.score]), [["a1", 1]]);
  assert.deepEqual(x.ambiguousStudents, []);
  assert.deepEqual(x.attributes, ["gpa"]);
  assert.equal(x.text, "What's Alex's GPA?");
  const other = understand("how many students do I have", { chatStudentId: null, roster: twins, colleges, state, now: NOW });
  assert.equal(other.text, "how many students do I have", "a message that isn't a reply is its own question");
  const stale = understand("Chen", { chatStudentId: null, roster: twins, colleges, state: { ...state, at: "2026-10-11T13:00:00Z" }, now: NOW });
  assert.notEqual(stale.text, "What's Alex's GPA?", "the question back expires with the rest of the state");
  assert.equal(nextState(x, state, null, NOW).pending, undefined, "answered once, forgotten");
});

test("which break dates: the reply's date finishes the remembered question", () => {
  const state = { students: [], colleges: [], at: "2026-10-11T14:58:00Z", pending: { kind: "date" as const, question: "what's due before winter break", label: "winter break", mode: "by" as const } };
  const x = understand("Dec 18", { chatStudentId: null, roster, colleges, state, now: NOW });
  assert.deepEqual(x.window, { from: "2026-10-11", to: "2026-12-18", label: "before winter break (Dec 18)" });
  const during = { ...state, pending: { ...state.pending, question: "what's due during winter break", mode: "during" as const } };
  assert.deepEqual(understand("Dec 21 to Jan 1", { chatStudentId: null, roster, colleges, state: during, now: NOW }).window, { from: "2026-12-21", to: "2027-01-01", label: "during winter break" });
  assert.equal(understand("Dec 21", { chatStudentId: null, roster, colleges, state: during, now: NOW }).text, "Dec 21", "one date can't bound a break");
});

test("a misspelled school with one close match is assumed; two close matches or a student never are", () => {
  const x = u("what's the admit rate at Cornel", null);
  assert.deepEqual(x.colleges.map((c) => [c.id, c.via]), [["c1", "fuzzy"]]);
  assert.deepEqual(u("Northeastrn acceptance rate", null).colleges.map((c) => c.id), ["c12"]);
  assert.deepEqual(u("what's Cornel's GPA", null).colleges, [], "only when a school figure is asked");
  assert.deepEqual(u("admit rate at Bethal", null).colleges, [], "two schools named Bethel: no single close match");
  assert.deepEqual(u("what's the admit rate at Zzyzx", null).colleges, []);
  // A close spelling of a carried-over school wins over the pronoun guess.
  const state = { students: [], colleges: [{ id: "c2", name: "Brown University" }], at: "2026-10-11T14:58:00Z" };
  assert.deepEqual(understand("admit rate at Tufs", { chatStudentId: null, roster, colleges, state, now: NOW }).colleges.map((c) => c.id), ["c13"]);
});
