import assert from "node:assert/strict";
import { test } from "node:test";
import { fourPointGpa, gpaLabel, gpaScaleKind } from "../../src/lib/gpa.js";

test("scale kinds", () => {
  assert.equal(gpaScaleKind("4.0"), "four");
  assert.equal(gpaScaleKind("4"), "four");
  assert.equal(gpaScaleKind("5.0 weighted"), "five");
  assert.equal(gpaScaleKind("10"), "ten");
  assert.equal(gpaScaleKind("100"), "hundred");
  assert.equal(gpaScaleKind("100-point"), "hundred");
  assert.equal(gpaScaleKind("12"), "other");
  assert.equal(gpaScaleKind(null), "unknown");
  assert.equal(gpaScaleKind("  "), "unknown");
});

test("only 4/5-point GPAs feed fit, odds and class rank", () => {
  assert.equal(fourPointGpa(3.8, "4.0"), 3.8);
  assert.equal(fourPointGpa(4.6, "5.0"), 4.6);
  assert.equal(fourPointGpa(3.8, null), 3.8);
  assert.equal(fourPointGpa(92, "100"), null);
  assert.equal(fourPointGpa(8.5, "10"), null);
  assert.equal(fourPointGpa(7, null), null);
  assert.equal(fourPointGpa(null, "4.0"), null);
});

test("labels show the scale", () => {
  assert.equal(gpaLabel(3.8, "4.0"), "3.8 (4.0 scale)");
  assert.equal(gpaLabel(92, "100"), "92 (100-point scale)");
  assert.equal(gpaLabel(3.8, null), "3.8");
  assert.equal(gpaLabel(null, "4.0"), null);
});

test("a GPA fits its scale: unweighted up to the scale, weighted up to the scale plus one", async () => {
  const { gpaOverScale, gpaScaleNumber } = await import("../../src/lib/gpa.js");
  assert.equal(gpaScaleNumber("4.0"), 4);
  assert.equal(gpaScaleNumber(" 5 scale"), 5);
  assert.equal(gpaScaleNumber("100-point"), 100);
  assert.equal(gpaScaleNumber("weighted"), null);
  assert.equal(gpaScaleNumber(null), null);
  assert.match(gpaOverScale(9.9, "4.0", "weighted") ?? "", /5 on a 4.0 scale/);
  assert.equal(gpaOverScale(4.6, "4.0", "weighted"), null);
  assert.equal(gpaOverScale(5, "4.0", "weighted"), null);
  assert.match(gpaOverScale(4.1, "4.0", "unweighted") ?? "", /4 on a 4.0 scale/);
  assert.equal(gpaOverScale(4, "4.0", "unweighted"), null);
  assert.equal(gpaOverScale(9.9, null, "weighted"), null, "no scale, nothing to check against");
});
