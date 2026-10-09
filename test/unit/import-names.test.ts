import assert from "node:assert/strict";
import { test } from "node:test";
import { firstNamesMatch, namesMatch, normalizeName, parseName } from "../../src/lib/imports/names.js";

test("accents, case and punctuation are ignored", () => {
  assert.equal(normalizeName("  José  O'Brien "), "jose obrien");
  assert.ok(namesMatch("JOSE OBRIEN", "José O'Brien"));
});

test("'Last, First' is understood", () => {
  assert.deepEqual(parseName("Doe, Jane"), { first: "jane", surnames: ["doe"] });
  assert.ok(namesMatch("Doe, Jane", "Jane Doe"));
});

test("hyphenated and two-part surnames match either part", () => {
  assert.ok(namesMatch("Maria Garcia-Lopez", "Maria Lopez"));
  assert.ok(namesMatch("Maria Lopez", "Maria Garcia Lopez"));
});

test("a middle name doesn't break the match", () => {
  assert.ok(namesMatch("John Michael Smith", "John Smith"));
});

test("nicknames in the same group match", () => {
  assert.ok(firstNamesMatch("Robert", "Bob"));
  assert.ok(namesMatch("Liz Chen", "Elizabeth Chen"));
});

test("names sharing a nickname but in different groups don't match", () => {
  assert.ok(!firstNamesMatch("Samuel", "Samantha"));
});

test("twins with the same last name stay apart", () => {
  assert.ok(!namesMatch("Ana Smith", "Eva Smith"));
});

test("an initial never matches", () => {
  assert.ok(!namesMatch("J. Smith", "John Smith"));
});

test("a preferred name counts", () => {
  assert.ok(namesMatch("Xiaoming Li", "Kevin Li", "Xiaoming"));
});

test("different last names don't match", () => {
  assert.ok(!namesMatch("Jane Doe", "Jane Roe"));
});
