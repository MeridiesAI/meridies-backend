import assert from "node:assert/strict";
import { test } from "node:test";
import { essayShaped, FIRST_PERSON_WORD_CAP, NARRATIVE_WORD_CAP } from "../../src/lib/proseGuard.js";
import { newTurnBudget, proseRefusal, TURN_NARRATIVE_CAP } from "../../src/lib/axis/ops/run.js";

/** n words of told, first-person narrative, in sentences of ten words. */
function narrative(words: number): string {
  const sentence = "I remember the night my grandmother taught me patience.";
  return Array.from({ length: Math.ceil(words / 9) }, () => sentence).join(" ");
}

/** First person, but every sentence addressed to "you": counts toward the first-person cap only. */
function addressed(words: number): string {
  const sentence = "I hope you know my robotics team taught me everything.";
  return Array.from({ length: Math.ceil(words / 10) }, () => sentence).join(" ");
}

const EMAIL_BODY =
  "Hi Mrs. Chen, I wanted to let you know Sophia submitted her Cornell application today. " +
  "Her FAFSA is still open; could you send me the 2025 tax return by Friday? I'll check in Monday. Thanks, Jordan";

test("essayShaped: told first-person prose past the narrative cap is essay-shaped, under it isn't", () => {
  assert.equal(essayShaped(narrative(NARRATIVE_WORD_CAP - 20)), false);
  assert.equal(essayShaped(narrative(NARRATIVE_WORD_CAP + 20)), true);
});

test("essayShaped: addressed first-person prose only trips the higher first-person cap", () => {
  assert.equal(essayShaped(addressed(NARRATIVE_WORD_CAP + 50)), false, "addressed lines aren't narrative");
  assert.equal(essayShaped(addressed(FIRST_PERSON_WORD_CAP + 20)), true);
});

test("essayShaped: third-person notes and logistics never count", () => {
  const note = Array.from({ length: 60 }, () => "She finished the Common App activities list and the counselor reviewed it.").join(" ");
  assert.equal(essayShaped(note), false);
  assert.equal(essayShaped(EMAIL_BODY), false);
});

test("essayShaped: caps can be passed in", () => {
  assert.equal(essayShaped(narrative(30), { narrative: 10, firstPerson: 1000 }), true);
  assert.equal(essayShaped(narrative(30), { narrative: 1000, firstPerson: 1000 }), false);
});

test("proseRefusal: an email body that is really a personal statement is refused", () => {
  const turn = newTurnBudget();
  const why = proseRefusal(turn, { subject: "Sophia's essay", body: narrative(NARRATIVE_WORD_CAP + 40) });
  assert.match(why ?? "", /essay text/);
  assert.equal(turn.proseWords, 0, "a refused text isn't counted toward the turn");
});

test("proseRefusal: a note nested deep in the input is still read", () => {
  const turn = newTurnBudget();
  const input = { student_id: "11111111-1111-4111-8111-111111111111", fields: { notes: [{ text: narrative(NARRATIVE_WORD_CAP + 40) }] } };
  assert.match(proseRefusal(turn, input) ?? "", /essay text/);
});

test("proseRefusal: an essay split across several fields of one card is joined and refused", () => {
  const turn = newTurnBudget();
  const half = narrative(Math.ceil(NARRATIVE_WORD_CAP / 2) + 20);
  assert.equal(essayShaped(half), false, "each half alone is under the cap");
  assert.match(proseRefusal(turn, { title: half, detail: half }) ?? "", /essay text/);
});

test("proseRefusal: a counselor's email to a parent goes through, and only its unaddressed first-person line counts", () => {
  const turn = newTurnBudget();
  assert.equal(proseRefusal(turn, { subject: "Cornell submitted", body: EMAIL_BODY }), null);
  // "I wanted to let you know..." and "could you send me..." are addressed; "I'll check in Monday." is 4 told words.
  assert.equal(turn.proseWords, 4);
});

test("proseRefusal: ids, dates and short strings are skipped", () => {
  const turn = newTurnBudget();
  assert.equal(proseRefusal(turn, { id: "11111111-1111-4111-8111-111111111111", due: "2026-12-01", title: "I did it." }), null);
  assert.equal(proseRefusal(turn, {}), null);
  assert.equal(proseRefusal(turn, null), null);
  assert.equal(turn.proseWords, 0);
});

test("proseRefusal: short first-person pieces add up across a turn and stop at the turn cap", () => {
  const turn = newTurnBudget();
  const piece = narrative(120);
  let refused = 0;
  for (let i = 0; i < 6; i++) if (proseRefusal(turn, { detail: piece })) refused++;
  assert.ok(refused > 0, "the turn's cap stops a statement filed in pieces");
  assert.ok(turn.proseWords <= TURN_NARRATIVE_CAP);
  // A fresh turn starts again.
  assert.equal(proseRefusal(newTurnBudget(), { detail: piece }), null);
});
