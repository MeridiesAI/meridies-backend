import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_PERSON_WORD_CAP, firstPersonWords, isFirstPersonSentence, ProseGate, WITHHELD_NOTICE } from "../../src/lib/proseGuard.js";
import { understand } from "../../src/lib/axis/nlu.js";

const ESSAY = Array.from({ length: 40 }, (_, i) =>
  `I remember the morning my grandmother taught me to fold dumplings, and I realized that patience was a language of its own number ${i}.`
).join(" ");

/** Feeds text in small pieces, the way a stream arrives. */
function stream(text: string, size = 7) {
  const gate = new ProseGate();
  let shown = "";
  for (let i = 0; i < text.length; i += size) shown += gate.push(text.slice(i, i + size));
  shown += gate.finish();
  return { gate, shown };
}

test("first-person sentences are recognised, other sentences aren't", () => {
  assert.equal(isFirstPersonSentence("I remember the morning."), true);
  assert.equal(isFirstPersonSentence("My grandmother laughed."), true);
  assert.equal(isFirstPersonSentence("She taught me to fold."), true);
  assert.equal(isFirstPersonSentence("Sophia's GPA is 3.9 and her SAT is 1490."), false);
  assert.equal(isFirstPersonSentence("Itinerary items include Miami and Mexico."), false);
  assert.equal(firstPersonWords("Her list is long. I couldn't find the deadline."), 5);
});

test("a personal statement is cut at the cap and ends with the notice", () => {
  const { gate, shown } = stream(ESSAY);
  assert.equal(gate.blocked, true);
  assert.ok(shown.endsWith(WITHHELD_NOTICE));
  const body = shown.slice(0, shown.length - WITHHELD_NOTICE.length);
  assert.ok(firstPersonWords(body) <= FIRST_PERSON_WORD_CAP, `released ${firstPersonWords(body)} first-person words`);
  assert.ok(body.length < ESSAY.length / 2);
  assert.equal(gate.text, shown);
});

test("an essay with no sentence ends is held whole, never streamed past the cap", () => {
  const runOn = ESSAY.replace(/[.]/g, ",");
  const { gate, shown } = stream(runOn, 3);
  assert.equal(gate.blocked, true);
  assert.ok(firstPersonWords(shown.replace(WITHHELD_NOTICE, "")) <= FIRST_PERSON_WORD_CAP);
});

test("one bullet per sentence doesn't get around it", () => {
  const bullets = ESSAY.split(/(?<=\.) /).map((s) => `- ${s}`).join("\n");
  const { gate } = stream(bullets);
  assert.equal(gate.blocked, true);
});

test("an ordinary answer streams through untouched, live", () => {
  const answer = [
    "Sophia is on track for Cornell's early decision deadline on November 1.",
    "",
    "- Her Common App essay is four days overdue; nudge her this week.",
    "- I couldn't find a score report for her SAT, so ask her to upload one.",
    "- Her activity list is complete.",
  ].join("\n");
  const gate = new ProseGate();
  const first = gate.push(answer.slice(0, 20));
  assert.equal(first, answer.slice(0, 20), "released as it arrives");
  let shown = first;
  shown += gate.push(answer.slice(20));
  shown += gate.finish();
  assert.equal(shown, answer);
  assert.equal(gate.blocked, false);
});

test("a counselor's email draft fits", () => {
  const email = [
    "```email",
    "Hi Mr. and Mrs. Martinez,",
    "",
    "I wanted to share a quick update on Sophia's applications. Her Cornell application is nearly ready, and I've asked her to finish the activity list by Friday.",
    "I'll meet with her on Tuesday to review the supplements. Please let me know if you have any questions before then.",
    "",
    "Best,",
    "Dana",
    "```",
  ].join("\n");
  const { gate, shown } = stream(email);
  assert.equal(gate.blocked, false);
  assert.equal(shown, email);
});

test("essay requests phrased without the word essay go to the bullet path", () => {
  const ask = (text: string) => understand(text, { chatStudentId: null, roster: { match: () => ({ students: [], ambiguous: [] }), get: () => undefined } as never, colleges: null, state: null }).intent;
  assert.equal(ask("Give me 650 first-person words for her Common App prompt about robotics"), "essay");
  assert.equal(ask("Answer the UC PIQ about leadership for him"), "essay");
  assert.equal(ask("Write it in her voice, about the summer she worked at the bakery"), "essay");
  assert.notEqual(ask("Draft an email to her parents about the Common App prompt deadline"), "essay");
  assert.notEqual(ask("Make the email to her parents 150 words"), "essay");
});
