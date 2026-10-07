import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mapCuratedRow } from "../../src/lib/ingest/curated.js";
import { consideration, mapAdmissionRow, parseCsv, readZipEntry, testPolicyFrom } from "../../src/lib/ingest/ipeds.js";
import { initialsOf, mapScorecardSchool, normalizeUrl, slugify } from "../../src/lib/ingest/scorecard.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/scorecard-two-schools.json", import.meta.url), "utf8"));

test("Scorecard: a real response maps to our rows", () => {
  const berkeley = mapScorecardSchool(fixture.results.find((r: Record<string, unknown>) => r.id === 110635))!;
  assert.equal(berkeley.unitid, 110635);
  assert.equal(berkeley.college.name, "University of California-Berkeley");
  assert.equal(berkeley.college.state, "CA");
  assert.equal(berkeley.college.control, "public");
  assert.ok(berkeley.college.acceptance_rate! > 0 && berkeley.college.acceptance_rate! < 0.3);
  assert.ok(berkeley.college.website!.startsWith("https://"));
  assert.ok(Object.keys(berkeley.stats.net_price_by_income as object).length > 0);
  assert.ok(berkeley.programs.length > 0 && berkeley.programs.every((p) => /^\d{4}$/.test(p.cip_code)));
  const aamu = mapScorecardSchool(fixture.results.find((r: Record<string, unknown>) => r.id === 100654))!;
  assert.equal(aamu.stats.hbcu, true);
  assert.ok((aamu.stats.sat_ebrw_25 as number) >= 200);
});

test("Scorecard: rejects what we don't list, and junk values", () => {
  assert.equal(mapScorecardSchool({ id: 1, "school.name": "Online U", "school.online_only": 1 }), null);
  assert.equal(mapScorecardSchool({ "school.name": "No id" }), null);
  const odd = mapScorecardSchool({ id: 2, "school.name": "Odd", "latest.admissions.admission_rate.overall": 7, "latest.admissions.sat_scores.25th_percentile.math": 950 })!;
  assert.equal(odd.college.acceptance_rate, null);
  assert.equal(odd.stats.sat_math_25, null);
});

test("slugs, initials, URLs", () => {
  assert.equal(slugify("Texas A & M University-Commerce"), "texas-a-and-m-university-commerce");
  assert.equal(slugify("Université de Montréal"), "universite-de-montreal");
  assert.equal(initialsOf("University of California-Berkeley"), "UCB");
  assert.equal(normalizeUrl("www.harvard.edu/"), "https://www.harvard.edu");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl(""), null);
});

test("IPEDS: codes, CSV and zip", () => {
  assert.equal(consideration("1"), "required");
  assert.equal(consideration("5"), "considered");
  assert.equal(consideration("3"), "not-considered");
  assert.equal(consideration("9"), null);
  assert.equal(testPolicyFrom("not-considered"), "blind");
  const csv = readFileSync(new URL("../fixtures/adm-sample.csv", import.meta.url), "utf8");
  const zipped = readZipEntry(readFileSync(new URL("../fixtures/adm-sample.zip", import.meta.url)), (n) => n.endsWith(".csv"));
  assert.equal(zipped?.toString("utf8"), csv);
  const rows = parseCsv(csv).map(mapAdmissionRow);
  const berkeley = rows.find((r) => r?.unitid === 110635)!;
  assert.equal(berkeley.testPolicy, "blind");
  assert.equal(berkeley.factors.essay, "required");
  assert.equal(rows.find((r) => r?.unitid === 166027)!.testPolicy, "optional");
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), [{ a: "x, y", b: 'he said "hi"' }]);
});

test("curated CSV rows: sources required, values checked", () => {
  const ok = mapCuratedRow("policies", { unitid: "166683", superscore: "both", source_url: "https://mitadmissions.org/x", checked_on: "2026-10-07" }, 2);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.out!.row.superscore, "both");
  const bad = mapCuratedRow("policies", { unitid: "abc", superscore: "maybe" }, 3);
  assert.equal(bad.out, null);
  assert.equal(bad.errors.length, 3);
  const rate = mapCuratedRow("major-admit-rates", { unitid: "110635", system: "uc", major: "Computer Science", entry_year: "2025", applicants: "1000", admits: "50", source_url: "https://x.edu/a" }, 2);
  assert.equal(rate.out!.row.admit_rate, 0.05);
  const over = mapCuratedRow("major-admit-rates", { unitid: "110635", system: "uc", major: "CS", entry_year: "2025", applicants: "10", admits: "50", source_url: "https://x.edu/a" }, 2);
  assert.ok(over.errors.some((e) => e.includes("more than applicants")));
});
