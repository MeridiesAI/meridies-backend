import assert from "node:assert/strict";
import { test } from "node:test";
import { importFields, type KindGuess } from "../../src/lib/documentGuess.js";

const guess: KindGuess = { kind: "transcript", basis: "filename", matched: "transcript", textFound: false, keepOut: false };

test("no kind: unconfirmed, kept out, guess stored, no extraction yet", () => {
  assert.deepEqual(importFields({ kind: undefined, availableToLlm: undefined, guess }), {
    kind: "other", kind_confirmed: false, available_to_llm: false, kind_guess: guess, requestExtraction: false,
  });
  // The client can't open an unconfirmed file to AI.
  assert.equal(importFields({ kind: undefined, availableToLlm: true, guess }).available_to_llm, false);
});

test("a named kind (Essays) is confirmed at once and its text is extracted unless kept out", () => {
  assert.deepEqual(importFields({ kind: "essay", availableToLlm: undefined, guess }), {
    kind: "essay", kind_confirmed: true, available_to_llm: true, kind_guess: null, requestExtraction: true,
  });
  assert.equal(importFields({ kind: "essay", availableToLlm: false, guess }).requestExtraction, false);
});
