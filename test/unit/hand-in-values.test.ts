import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanReview } from "../../src/lib/submissionReview.js";
import { columnFor, fallbackFindings, infoPatchFrom, valuesFrom, withCurrent, type HandInValue } from "../../src/lib/handInValues.js";

const review = (over: Record<string, unknown> = {}) =>
  cleanReview({
    verdict: "accepted",
    note: "Official transcript through grade 11.",
    findings: ["All pages present"],
    weightedGpa: "4.05",
    unweightedGpa: "3.8",
    classRank: "31 of 388",
    testScores: ["SAT 1450", "ACT 33"],
    ...over,
  });
const value = (key: HandInValue["key"], printed: string): HandInValue => ({ key, label: "", printed, confirmedAt: null, confirmedBy: null, confirmedByName: null });

test("values come out as a list, unverified", () => {
  const values = valuesFrom(review());
  assert.deepEqual(values.map((v) => [v.key, v.label, v.printed]), [
    ["weightedGpa", "Weighted GPA", "4.05"],
    ["unweightedGpa", "Unweighted GPA", "3.8"],
    ["classRank", "Class rank", "31 of 388"],
    ["testScore", "Test score", "SAT 1450"],
  ]);
  assert.ok(values.every((v) => v.confirmedAt === null && v.confirmedBy === null && v.confirmedByName === null));
  assert.deepEqual(valuesFrom(review({ weightedGpa: null, unweightedGpa: null, classRank: null, testScores: [] })), []);
});

test("the test score kept as a value is one the profile can take", () => {
  const r = review({ testScores: ["SAT Math 720", "ACT 33"] });
  assert.equal(valuesFrom(r).find((v) => v.key === "testScore")?.printed, "ACT 33");
});

test("without the column, findings carry the labelled lines", () => {
  assert.deepEqual(fallbackFindings(review()), [
    "Weighted GPA (unverified, from the student's file): 4.05",
    "Unweighted GPA (unverified, from the student's file): 3.8",
    "Class rank (unverified, from the student's file): 31 of 388",
    "Test score (unverified, from the student's file): SAT 1450",
    "Test score (unverified, from the student's file): ACT 33",
    "All pages present",
  ]);
});

test("infoPatchFrom keeps only plausible values", () => {
  assert.deepEqual(
    infoPatchFrom([value("weightedGpa", "4.05"), value("unweightedGpa", "7.2"), value("classRank", "31 of 388"), value("testScore", "SAT 1455")]),
    { gpaWeighted: 4.05, classRank: "31 of 388" }
  );
  assert.deepEqual(infoPatchFrom([value("testScore", "SAT 1450")]), { sat: 1450 });
  assert.deepEqual(infoPatchFrom([value("testScore", "ACT 33")]), { act: 33 });
  assert.deepEqual(infoPatchFrom([value("testScore", "SAT Math 720")]), {}, "a section score isn't the SAT total");
  assert.deepEqual(infoPatchFrom([value("testScore", "ACT Science 30")]), {}, "nor an ACT section the composite");
  assert.deepEqual(infoPatchFrom([value("testScore", "SAT 1450 (EBRW 720, Math 730)")]), { sat: 1450 });
  assert.deepEqual(infoPatchFrom([value("classRank", "31/388"), value("unweightedGpa", "0")]), { classRank: "31/388" });
  assert.deepEqual(infoPatchFrom([value("classRank", `1 of ${"9".repeat(45)}`)]), {}, "a rank over 40 characters isn't taken");
});

test("each value names the profile column it writes", () => {
  assert.equal(columnFor("weightedGpa", "4.05"), "gpa_weighted");
  assert.equal(columnFor("unweightedGpa", "3.8"), "gpa_unweighted");
  assert.equal(columnFor("classRank", "31 of 388"), "class_rank");
  assert.equal(columnFor("testScore", "SAT 1450"), "sat_superscore");
  assert.equal(columnFor("testScore", "ACT 33"), "act_composite");
  assert.equal(columnFor("testScore", "AP Biology 5"), null);
  assert.equal(columnFor("testScore", "SAT Math 720"), null);
});

test("each value carries the profile's value now for its column", () => {
  const values = withCurrent([value("weightedGpa", "4.05"), value("testScore", "ACT 33"), value("testScore", "AP Biology 5")], {
    gpa_weighted: 3.9,
    act_composite: 31,
    sat_superscore: 1400,
  });
  assert.deepEqual(values.map((v) => v.current), [3.9, 31, null]);
  assert.deepEqual(withCurrent([value("classRank", "2 of 90")], null).map((v) => v.current), [null]);
});

test("the check's findings keep every value labelled unverified, with the column too: today's app reads them there", async () => {
  const { recordReview } = await import("../../src/lib/submissionReview.js");
  const inserted: Record<string, unknown>[] = [];
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      maybeSingle: async () => ({ data: table === "deliverables" ? { status: "review" } : null, error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      insert: async (row: Record<string, unknown>) => (inserted.push(row), { error: null }),
    };
    return c;
  };
  const svc = { from: chain } as unknown as Parameters<typeof recordReview>[0];
  await recordReview(svc, { id: "t1", student_id: "s1", status: "review" }, "d1", review());
  const row = inserted[0]!;
  assert.ok(Array.isArray(row.extracted_values) && (row.extracted_values as unknown[]).length === 4, "the list is stored");
  assert.deepEqual(row.findings, fallbackFindings(review()), "and the findings still name each value, labelled");
});
