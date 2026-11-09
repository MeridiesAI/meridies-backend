// The quality evals' drop rule (evals/axis/quality-score.mjs): against the baseline's last line, a case's passes
// falling by 2 or more, or the total over the cases both runs have falling by 3 or more. A new case is never a drop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareQuality } from "../../evals/axis/quality-score.mjs";

const IDS = ["fact-a", "fact-b", "fact-c"];
const score = (passes: number[] | number = 3, runs = 3, ids = IDS) => ({
  commit: "abc", date: "2026-11-09", models: ["claude-haiku-5-5"], suite: "quality",
  cases: Object.fromEntries(ids.map((id, i) => [id, { passes: Array.isArray(passes) ? passes[i]! : passes, runs }])),
});

test("no baseline means no drop", () => {
  assert.deepEqual(compareQuality(null, score(0)).drops, []);
});

test("a case falling 3->1 is a drop; 3->2 isn't", () => {
  assert.deepEqual(compareQuality(score(), score([1, 3, 3])).drops, ["fact-a: passes 3/3 -> 1/3"]);
  assert.deepEqual(compareQuality(score(), score([2, 3, 3])).drops, []);
});

test("the total falling by 3 is a drop; by 2 isn't", () => {
  assert.deepEqual(compareQuality(score(), score([2, 2, 2])).drops, ["total passes 9/9 -> 6/9"]);
  assert.deepEqual(compareQuality(score(), score([2, 2, 3])).drops, []);
});

test("a case drop and a total drop are both reported", () => {
  assert.deepEqual(compareQuality(score(), score([0, 3, 3])).drops, ["fact-a: passes 3/3 -> 0/3", "total passes 9/9 -> 6/9"]);
});

test("a new case is never a drop, and takes no part in the total", () => {
  const next = score([3, 3, 3, 0], 3, [...IDS, "fact-new"]);
  assert.deepEqual(compareQuality(score(), next).drops, []);
});

test("a case the run left out (--case) is not a drop", () => {
  assert.deepEqual(compareQuality(score(), score(3, 3, ["fact-a"])).drops, []);
});

test("cases run a different number of times are not compared", () => {
  const { drops, skipped } = compareQuality(score(), score(1, 1));
  assert.deepEqual(drops, []);
  assert.deepEqual(skipped, IDS);
});

test("getting better is not a drop", () => {
  assert.deepEqual(compareQuality(score(0), score(3)).drops, []);
});
