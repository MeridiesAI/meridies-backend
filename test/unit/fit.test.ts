import assert from "node:assert/strict";
import { test } from "node:test";
import { fitFor, freshness, settingFromLocale, studentOdds, type ListSchool } from "../../src/lib/collegesV10.js";

const school = (admit: number | null, satMid: number | null) => ({ admit, satMid, gpaMid: null }) as unknown as ListSchool;

test("odds follow the admit rate, moved by the SAT against the middle", () => {
  const at = studentOdds({ sat: 1400, gpaUnweighted: null }, school(50, 1400), true)!;
  const above = studentOdds({ sat: 1560, gpaUnweighted: null }, school(50, 1400), true)!;
  const below = studentOdds({ sat: 1240, gpaUnweighted: null }, school(50, 1400), true)!;
  assert.equal(at, 50);
  assert.ok(above > at && below < at);
  assert.ok(above <= 94, "capped");
  assert.equal(studentOdds({ sat: 1400, gpaUnweighted: null }, school(null, 1400), true), null, "no published rate, no odds");
  assert.equal(studentOdds({ sat: 1600, gpaUnweighted: null }, school(50, 1200), false), 50, "test-optional list ignores the SAT");
});

test("fit tiers", () => {
  assert.equal(fitFor(school(10, 1500), 90), "reach", "under 15% admitted is always a reach");
  assert.equal(fitFor(school(50, 1400), 20), "reach");
  assert.equal(fitFor(school(50, 1400), 50), "target");
  assert.equal(fitFor(school(80, 1200), 80), "likely");
  assert.equal(fitFor(school(80, 1200), null), "reach");
});

test("locale -> setting", () => {
  assert.equal(settingFromLocale(11), "Major city");
  assert.equal(settingFromLocale(13), "Small city");
  assert.equal(settingFromLocale(22), "Suburban");
  assert.equal(settingFromLocale(32), "College town");
  assert.equal(settingFromLocale(43), "Rural");
  assert.equal(settingFromLocale(null), null);
});

test("freshness flags data older than 13 months, and data with no date", () => {
  const now = Date.parse("2026-10-07T00:00:00Z");
  assert.equal(freshness("2026-01-01T00:00:00Z", "x", now).stale, false);
  assert.equal(freshness("2025-08-01T00:00:00Z", "x", now).stale, true);
  assert.equal(freshness(null, null, now).stale, true);
});
