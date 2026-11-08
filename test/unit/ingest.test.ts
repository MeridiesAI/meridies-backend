import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DATASETS, mapCuratedCsv, mapCuratedRow } from "../../src/lib/ingest/curated.js";
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

test("curated policies: personal_statement_read and test_reporting", () => {
  const base = { unitid: "166683", source_url: "https://mitadmissions.org/x", checked_on: "2026-11-01" };
  for (const [v, want] of [["true", true], ["yes", true], ["false", false], ["no", false]] as const) {
    const r = mapCuratedRow("policies", { ...base, personal_statement_read: v }, 2);
    assert.deepEqual(r.errors, []);
    assert.equal(r.out!.row.personal_statement_read, want, v);
  }
  // blank = unknown: the field is left out, so an earlier row's answer stands
  const blankRow = mapCuratedRow("policies", { ...base, personal_statement_read: "", test_reporting: " " }, 2);
  assert.deepEqual(blankRow.errors, []);
  assert.equal("personal_statement_read" in blankRow.out!.row, false);
  assert.equal("test_reporting" in blankRow.out!.row, false);
  for (const v of ["official-only", "self-report", "score-send", "not-applicable", "Self-Report"]) {
    const r = mapCuratedRow("policies", { ...base, test_reporting: v }, 2);
    assert.deepEqual(r.errors, [], v);
    assert.equal(r.out!.row.test_reporting, v.toLowerCase());
  }
  const both = mapCuratedRow("policies", { ...base, personal_statement_read: "no", test_reporting: "score-send" }, 2);
  const sources = both.out!.row.__sources as Record<string, { url: string; checkedAt: string }>;
  assert.deepEqual(sources.personal_statement_read, { url: base.source_url, checkedAt: "2026-11-01" });
  assert.deepEqual(sources.test_reporting, { url: base.source_url, checkedAt: "2026-11-01" });
  const bad = mapCuratedRow("policies", { ...base, personal_statement_read: "sometimes", test_reporting: "official" }, 7);
  assert.equal(bad.out, null);
  assert.equal(bad.errors.length, 2);
  assert.ok(bad.errors.every((e) => e.startsWith("line 7: ")));
  assert.ok(bad.errors.some((e) => e.includes("personal_statement_read")));
  assert.ok(bad.errors.some((e) => e.includes("test_reporting")));
});

test("curated checked_on: an impossible date is a row error, not a crash", () => {
  const r = mapCuratedRow("policies", { unitid: "166683", superscore: "sat", source_url: "https://x.edu/a", checked_on: "2026-13-45" }, 2);
  assert.equal(r.out, null);
  assert.ok(r.errors.some((e) => e.includes("checked_on")));
});

test("curated supplements: one prompt per row, sourced and checked", () => {
  assert.ok(DATASETS.includes("supplements"));
  const row = {
    unitid: "999999", cycle: "2026-27", sort_order: "0", title: "EXAMPLE short answer", prompt: "EXAMPLE: Why this school?",
    word_limit: "250", scope: "universal", major_or_program: "", required: "yes",
    source_url: "https://admissions.example.edu/supplements", checked_on: "2026-11-01",
  };
  const ok = mapCuratedRow("supplements", row, 2);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.out!.unitid, 999999);
  assert.deepEqual(ok.out!.row, {
    admission_cycle: "2026-2027", sort_order: 0, title: "EXAMPLE short answer", prompt: "EXAMPLE: Why this school?",
    word_limit: 250, scope: "universal", major_or_program: null, required: true,
    source_url: "https://admissions.example.edu/supplements", source_verified_at: "2026-11-01T12:00:00.000Z",
  });
  // the table's own spelling of a cycle works too; blank scope/required take the table defaults
  const long = mapCuratedRow("supplements", { ...row, cycle: "2026-2027", scope: "", required: "", word_limit: "" }, 2);
  assert.deepEqual(long.errors, []);
  assert.equal(long.out!.row.admission_cycle, "2026-2027");
  assert.equal(long.out!.row.scope, "universal");
  assert.equal(long.out!.row.required, true);
  assert.equal(long.out!.row.word_limit, null);
  const major = mapCuratedRow("supplements", { ...row, scope: "major", major_or_program: "Engineering", required: "no" }, 2);
  assert.equal(major.out!.row.major_or_program, "Engineering");
  assert.equal(major.out!.row.required, false);

  const errsOf = (patch: Record<string, string>) => mapCuratedRow("supplements", { ...row, ...patch }, 4).errors;
  assert.ok(errsOf({ unitid: "" }).some((e) => e.includes("unitid")), "a school is required");
  assert.ok(errsOf({ source_url: "" }).some((e) => e.includes("source_url")), "source_url is required");
  assert.ok(errsOf({ source_url: "http://admissions.example.edu/x" }).some((e) => e.includes("https")), "source_url must be https");
  assert.ok(errsOf({ checked_on: "" }).some((e) => e.includes("checked_on")), "checked_on is required");
  assert.ok(errsOf({ checked_on: "11/01/2026" }).some((e) => e.includes("checked_on")));
  assert.ok(errsOf({ cycle: "2026" }).some((e) => e.includes("cycle")));
  assert.ok(errsOf({ cycle: "2026-28" }).some((e) => e.includes("cycle")), "a cycle is one year to the next");
  assert.ok(errsOf({ sort_order: "" }).some((e) => e.includes("sort_order")), "sort_order is required");
  assert.ok(errsOf({ sort_order: "-1" }).some((e) => e.includes("sort_order")));
  assert.ok(errsOf({ title: " " }).some((e) => e.includes("title")));
  assert.ok(errsOf({ title: "x".repeat(121) }).some((e) => e.includes("title")));
  assert.ok(errsOf({ prompt: "" }).some((e) => e.includes("prompt")));
  assert.ok(errsOf({ prompt: "x".repeat(2001) }).some((e) => e.includes("prompt")));
  assert.ok(errsOf({ word_limit: "0" }).some((e) => e.includes("word_limit")));
  assert.ok(errsOf({ word_limit: "5001" }).some((e) => e.includes("word_limit")));
  assert.ok(errsOf({ scope: "optional" }).some((e) => e.includes("scope")));
  assert.ok(errsOf({ major_or_program: "x".repeat(201) }).some((e) => e.includes("major_or_program")));
  assert.ok(errsOf({ required: "maybe" }).some((e) => e.includes("required")));
  assert.ok(errsOf({ source_url: "" }).every((e) => e.startsWith("line 4: ")));
});

test("curated supplements: a file naming the same slot twice is refused", () => {
  const row = { unitid: "999999", cycle: "2026-27", sort_order: "0", title: "EXAMPLE", prompt: "EXAMPLE prompt", source_url: "https://admissions.example.edu/s", checked_on: "2026-11-01" };
  const dup = mapCuratedCsv("supplements", [row, { ...row, cycle: "2026-2027", title: "EXAMPLE 2" }, { ...row, sort_order: "1" }]);
  assert.equal(dup.errors.length, 1);
  assert.match(dup.errors[0], /^line 3: .*line 2/);
  // different schools or cycles may share a slot number
  const fine = mapCuratedCsv("supplements", [row, { ...row, unitid: "999998" }, { ...row, cycle: "2027-28" }]);
  assert.deepEqual(fine.errors, []);
  assert.equal(fine.ok.length, 3);
});
