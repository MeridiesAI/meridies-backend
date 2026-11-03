import assert from "node:assert/strict";
import { test } from "node:test";
import { canReadStoredText, findLoose, locateEssay } from "../../src/lib/applicationText.js";
import { countWords } from "../../src/lib/documentText.js";

const essay = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} of the essay tells part of the story about the garden.`).join(" ");
const doc = [
  "Maya Chen, Personal Statement draft 3",
  "Prompt: Some students have a background, identity, interest, or talent that is so meaningful...",
  "Notes:\n- mention grandmother\n- cut the intro",
  essay,
  "Word count: 650",
].join("\n\n");

test("findLoose matches across line breaks and doubled spaces", () => {
  const text = "One  two\nthree four";
  const hit = findLoose(text, "two three");
  assert.ok(hit);
  assert.equal(text.slice(hit!.start, hit!.end), "two\nthree");
  assert.equal(findLoose(text, "five"), null);
});

test("the essay span is a verbatim slice between the two quotes", () => {
  const span = locateEssay(doc, "Sentence 1 of the essay tells part", "the story about the garden.");
  assert.equal(span, essay);
  assert.equal(countWords(span!), countWords(essay));
  assert.ok(countWords(span!) < countWords(doc));
});

test("quotes that aren't in the text, or run backwards, give no span", () => {
  assert.equal(locateEssay(doc, "words the model invented here", "the story about the garden."), null);
  assert.equal(locateEssay(doc, "Word count: 650", "Maya Chen, Personal Statement"), null);
});

test("a span too small to be the essay is refused", () => {
  assert.equal(locateEssay(doc, "Notes:", "cut the intro"), null);
});

test("PDF, Word and text files are readable; images are not", () => {
  assert.equal(canReadStoredText("ps.pdf", null), true);
  assert.equal(canReadStoredText("ps.docx", null), true);
  assert.equal(canReadStoredText("ps.txt", null), true);
  assert.equal(canReadStoredText("scan.png", "image/png"), false);
});
