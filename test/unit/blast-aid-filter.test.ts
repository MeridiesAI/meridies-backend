import assert from "node:assert/strict";
import { test } from "node:test";
import { aidFilterInput, aidLabel, aidMatches, audienceInput, filtersOf, storedFilters } from "../../src/lib/blasts.js";

test("an audience without an aid filter parses as it always did", () => {
  assert.deepEqual(audienceInput.parse({ classYears: ["2027"] }), {
    recipientType: "students",
    classYears: ["2027"],
    colleges: [],
    statuses: [],
  });
});

test("an aid filter is one form, include or exclude, one or more statuses", () => {
  const a = audienceInput.parse({ aid: { form: "fafsa", mode: "exclude", statuses: ["submitted", "submitted", "none"] } });
  assert.deepEqual(a.aid, { form: "fafsa", mode: "exclude", statuses: ["submitted", "none"] });
  assert.equal(audienceInput.parse({ aid: { form: "css", mode: "include", statuses: ["not-required"] } }).aid?.form, "css");
});

test("an aid filter refuses what it can't mean", () => {
  const bad = [
    { form: "fafsa", mode: "include", statuses: [] }, // nothing picked
    { form: "fafsa", mode: "include", statuses: ["not-required"] }, // a CSS-only status
    { form: "fafsa", mode: "include", statuses: ["verified"] }, // a v4 status, gone
    { form: "sai", mode: "include", statuses: ["submitted"] }, // not a form
    { form: "fafsa", mode: "only", statuses: ["submitted"] },
    { form: "fafsa", mode: "include", statuses: ["submitted"], efc: 1 }, // strict
  ];
  for (const aid of bad) assert.equal(aidFilterInput.safeParse(aid).success, false, JSON.stringify(aid));
});

test("include keeps the statuses picked; exclude keeps everyone else", () => {
  const inc = aidFilterInput.parse({ form: "fafsa", mode: "include", statuses: ["in-progress", "none"] });
  assert.equal(aidMatches(inc, "in-progress"), true);
  assert.equal(aidMatches(inc, null), true); // no aid record
  assert.equal(aidMatches(inc, "submitted"), false);
  assert.equal(aidMatches(inc, "not-started"), false); // "not started" is not "nothing recorded"

  const exc = aidFilterInput.parse({ form: "fafsa", mode: "exclude", statuses: ["submitted"] });
  assert.equal(aidMatches(exc, "submitted"), false);
  assert.equal(aidMatches(exc, "not-started"), true);
  assert.equal(aidMatches(exc, undefined), true);

  const excNone = aidFilterInput.parse({ form: "css", mode: "exclude", statuses: ["none"] });
  assert.equal(aidMatches(excNone, null), false);
  assert.equal(aidMatches(excNone, "not-started"), true);
});

test("the frozen label names the aid filter", () => {
  assert.equal(aidLabel(aidFilterInput.parse({ form: "fafsa", mode: "include", statuses: ["submitted"] })), "FAFSA: Submitted");
  assert.equal(
    aidLabel(aidFilterInput.parse({ form: "css", mode: "exclude", statuses: ["in-progress", "none"] })),
    "CSS Profile: not In progress, nothing recorded"
  );
});

test("a stored blast keeps its aid filter, and one without reads as before", () => {
  const aid = aidFilterInput.parse({ form: "fafsa", mode: "exclude", statuses: ["submitted"] });
  const stored = storedFilters({ classYears: ["2027"], colleges: [], statuses: [], aid });
  assert.deepEqual(filtersOf({ filters: JSON.parse(JSON.stringify(stored)) }), { classYears: ["2027"], colleges: [], statuses: [], aid });
  assert.deepEqual(storedFilters({ classYears: [], colleges: [], statuses: [] }), { classYears: [], colleges: [], statuses: [] });
  // An older blast's filters, and a blast stored as a selection (no filters at all).
  assert.deepEqual(filtersOf({ filters: { classYears: ["2028"], colleges: ["Brown"], statuses: [] } }), {
    classYears: ["2028"],
    colleges: ["Brown"],
    statuses: [],
  });
  assert.deepEqual(filtersOf({ filters: null }), { classYears: [], colleges: [], statuses: [] });
});

test("a stored aid filter that no longer reads fails closed instead of widening", () => {
  assert.equal(filtersOf({ filters: { classYears: [], aid: { form: "fafsa", mode: "include", statuses: ["verified"] } } }), null);
  assert.equal(filtersOf({ filters: { aid: "submitted" } }), null);
});
