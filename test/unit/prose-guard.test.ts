import assert from "node:assert/strict";
import { test } from "node:test";
import {
  essayShaped,
  FIRST_PERSON_WORD_CAP,
  firstPersonWords,
  isFirstPersonSentence,
  isNarrativeSentence,
  NARRATIVE_WORD_CAP,
  narrativeWords,
  ProseGate,
  WITHHELD_NOTICE,
} from "../../src/lib/proseGuard.js";
import { understand } from "../../src/lib/axis/nlu.js";
import { looksLikeChange } from "../../src/lib/axis/engine.js";

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
  assert.ok(narrativeWords(body) <= NARRATIVE_WORD_CAP, `released ${narrativeWords(body)} narrative words`);
  assert.ok(body.length < ESSAY.length / 2);
  assert.equal(gate.text, shown);
});

test("an essay with no sentence ends is held whole, never streamed past the cap", () => {
  const runOn = ESSAY.replace(/[.]/g, ",");
  const { gate, shown } = stream(runOn, 3);
  assert.equal(gate.blocked, true);
  assert.ok(narrativeWords(shown.replace(WITHHELD_NOTICE, "")) <= NARRATIVE_WORD_CAP);
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

test("addressed first-person lines aren't narrative; told ones are", () => {
  assert.equal(isNarrativeSentence("I wanted to let you know how Sophia is doing."), false);
  assert.equal(isNarrativeSentence("I'd suggest you move her Cornell essay up a week."), false);
  assert.equal(isNarrativeSentence("I remember the smell of my grandmother's kitchen."), true);
  assert.equal(narrativeWords("I checked her file. I found two gaps. Your call on the third."), 8);
});

test("a long family email in the counselor's voice streams whole", () => {
  // About 330 words, most of it first person, the shape that was cut at 200 first-person words.
  const email = [
    "```email",
    "Hi Mr. and Mrs. Martinez,",
    "",
    "I wanted to give you a fuller update on Sophia's applications now that we're three weeks from the first deadlines, since I know you've had questions.",
    "I met with Sophia on Tuesday and we went through her Cornell early decision application line by line, and I'm happy to tell you it's nearly ready.",
    "I've asked her to finish the activity list by Friday, and I'll review it over the weekend so you'll have my notes by Monday.",
    "Her supplements for Cornell are in good shape. I'd like you to give her a little space this week to finish them on her own schedule.",
    "I also want to flag the CSS Profile: I'll need you to send me last year's tax return so I can check the figures before you submit it.",
    "If you'd rather walk through the CSS Profile together, I'm free Thursday afternoon and I'm happy to set up a call at whatever time suits you.",
    "On testing, I don't think she needs to sit the SAT again; her 1490 is strong for her list, and I'd rather she put that time into her essays.",
    "I'll send you the final list of schools and deadlines next week, and I'll copy Sophia so everyone sees the same dates.",
    "Please let me know if you have any questions before then, or if anything at home makes the coming weeks harder than usual. I'm always glad to hear from you.",
    "",
    "Best,",
    "Dana",
    "```",
  ].join("\n");
  assert.ok(firstPersonWords(email) > 200, `the email has ${firstPersonWords(email)} first-person words`);
  const { gate, shown } = stream(email);
  assert.equal(gate.blocked, false);
  assert.equal(shown, email);
});

test("an essay with 'you' in every sentence is still cut, at the first-person cap", () => {
  const sneaky = Array.from({ length: 60 }, (_, i) => `As you know, I remember the morning my grandmother taught me to fold dumplings, moment ${i}.`).join(" ");
  assert.equal(narrativeWords(sneaky), 0);
  const { gate, shown } = stream(sneaky);
  assert.equal(gate.blocked, true);
  assert.ok(firstPersonWords(shown.replace(WITHHELD_NOTICE, "")) <= FIRST_PERSON_WORD_CAP);
  assert.equal(essayShaped(sneaky), true);
  assert.equal(essayShaped("I'll call you Tuesday about her list."), false);
});

test("ordinary questions about limits and prompts aren't routed to essay advice", () => {
  const ask = (text: string) => understand(text, { chatStudentId: null, roster: { match: () => ({ students: [], ambiguous: [] }), get: () => undefined } as never, colleges: null, state: null }).intent;
  assert.notEqual(ask("answer which prompt she picked"), "essay");
  assert.notEqual(ask("answer what the UC PIQ deadline is"), "essay");
  assert.notEqual(ask("I need 650 words max for her statement, what's the limit?"), "essay");
  assert.notEqual(ask("call her parents to understand things from her perspective"), "essay");
  assert.equal(ask("Write it from her perspective, about the summer at the bakery"), "essay");
});

test("a 'remind me' with a perspective phrase is still a change", () => {
  assert.equal(looksLikeChange("remind me to call her parents to understand things from her perspective"), true);
});
