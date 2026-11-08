import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_PROSE_SYSTEM } from "../../src/lib/anthropic.js";
import { UNTRUSTED_DATA_RULE } from "../../src/lib/context/pack.js";
import {
  coherenceAskSystem,
  coherenceNext,
  coherenceSystem,
  isStudentSafe,
  listChatSystem,
  rewriteRefusal,
  studentSafeBullets,
} from "../../src/lib/studentToolPrompts.js";

// The Build College Lists chat bar is the consultant's tool first; a student's version speaks to the student and
// never to a counselor. It changes only the wording: the model still returns one structured change from a fixed
// set of actions, and a deterministic filter picks the schools.

test("the counselor's list-chat prompt is the one it always was: a counselor's request, bullets to the counselor", () => {
  const p = listChatSystem("counselor");
  assert.match(p, /a counselor's request about a college list/);
  assert.match(p, /addressed to the counselor/);
});

test("the student's list-chat prompt speaks to the student and names no counselor", () => {
  const p = listChatSystem("student");
  assert.match(p, /student's request about their college list/);
  assert.match(p, /addressed to the student/);
  assert.doesNotMatch(p, /counselor/i);
});

test("both keep the same actions and the same rule that the model does not pick schools", () => {
  for (const audience of ["counselor", "student"] as const) {
    const p = listChatSystem(audience);
    assert.match(p, /You do not pick schools yourself: a deterministic filter does\./);
    for (const action of ["refresh", "more / fewer", "closer / farther", "test-optional", "set", "exclude", "none"]) {
      assert.ok(p.includes(action), `${audience}: ${action}`);
    }
    assert.match(p, /Sizes: Small, Medium, Large, Very large\./);
  }
});

// ---- Narrative Coherence ----

// What the counselor's prompt said before students could run it, word for word. It must not move.
const COUNSELOR_COHERENCE = [
  NO_PROSE_SYSTEM,
  "",
  "You read the parts of one college application side by side, for the student's counselor.",
  "Storyline: three short bullets labelled Origin, Through-line, Landing: where the story starts, what carries it, where it should end.",
  "Flags: contradictions and gaps between the documents (dates, roles, hours, claims that disagree), most serious first. Name both places each one sits.",
  "Fix: what the student should settle or decide, never the words to write.",
  "Next: up to three bullets on what the counselor does next.",
  "Address the counselor; the student's name is in the student record below.",
  UNTRUSTED_DATA_RULE,
].join("\n");

test("the counselor's Coherence prompt is exactly what it was", () => {
  assert.equal(coherenceSystem("counselor"), COUNSELOR_COHERENCE);
});

test("the student's Coherence prompt speaks to the student, names no counselor, and keeps every essay rule", () => {
  const p = coherenceSystem("student");
  assert.doesNotMatch(p, /counselor/i);
  assert.match(p, /Address the student directly \(you, your\)/);
  assert.match(p, /Never write as the student/);
  // The hard rules are the same ones: never draft, polish or continue the student's prose.
  assert.match(p, /You NEVER write essay prose/);
  assert.match(p, /Never draft, ghostwrite, rewrite, or 'polish'/);
  assert.match(p, /at most two sentences/);
  assert.ok(p.includes(UNTRUSTED_DATA_RULE));
  assert.match(p, /Fix: what the student should settle or decide, never the words to write\./);
});

test("the Coherence follow-up prompt: the counselor's as it was, the student's addressed to the student", () => {
  assert.equal(
    coherenceAskSystem("counselor"),
    [NO_PROSE_SYSTEM, "", "Answer the counselor's question about this Narrative Coherence report only, in at most four bullets.", "If the report doesn't say, answer that it doesn't.", UNTRUSTED_DATA_RULE].join("\n")
  );
  const s = coherenceAskSystem("student");
  assert.doesNotMatch(s, /counselor/i);
  assert.match(s, /Answer the student's question about this Narrative Coherence report only, in at most four bullets\./);
});

test("the closing next step: the counselor's assigns tasks, the student's goes to their meeting", () => {
  assert.equal(coherenceNext("counselor", "Maya"), "Bring the report to Maya's next meeting and assign each fix as a task with a word budget.");
  assert.equal(coherenceNext("student", "Maya"), "Take this report to your next meeting with your counselor.");
});

test("a request for wording gets questions, not words: the counselor's lines as they were, the student's about themself", () => {
  assert.deepEqual(rewriteRefusal("counselor", "Maya"), [
    "I won't write wording for the essays; the words have to be the student's.",
    "Ask Maya: which moment in the statement is the true start of this interest?",
    "Ask Maya: what does the supplement add that the statement doesn't already say?",
  ]);
  const s = rewriteRefusal("student", "Maya");
  assert.equal(s.length, 3);
  assert.doesNotMatch(s.join("\n"), /counselor|Maya/i);
  assert.match(s[0]!, /won't write/);
});

test("a student's bullets drop anything in the student's own voice, and anything that reads as prose", () => {
  assert.equal(isStudentSafe("Your statement says three years; your activities list says two."), true);
  assert.equal(isStudentSafe("I started building robots because I love building things."), false, "first person, addressed to nobody");
  assert.equal(isStudentSafe("I think you should settle the dates first."), true, "first person but addressed to the student");
  assert.equal(isStudentSafe("My grandmother's workshop taught me patience."), false);
  assert.equal(isStudentSafe(""), false);
  assert.equal(isStudentSafe("One. Two. Three sentences is too many."), false, "the existing shape test still applies");
  assert.deepEqual(studentSafeBullets(["Settle the dates.", "I love robots and always have.", "  Check each supplement.  "]), ["Settle the dates.", "Check each supplement."]);
});
