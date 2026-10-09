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
