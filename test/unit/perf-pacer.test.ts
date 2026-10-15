// The speed test's pacer and percentiles (test/integration/perf-pacer.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain ESM script, no types
import { Pacer, percentile } from "../integration/perf-pacer.mjs";

test("percentile: nearest rank", () => {
  const s = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(s, 50), 10);
  assert.equal(percentile(s, 95), 19);
  assert.equal(percentile(s, 100), 20);
  assert.equal(percentile([7], 95), 7);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test("pacer: waits for room under every key's cap in a sliding window", async () => {
  const pacer = new Pacer(200);
  const start = Date.now();
  for (let i = 0; i < 3; i++) await pacer.take([["user", 3], ["route", 5]]);
  assert.ok(Date.now() - start < 100, "three calls under a cap of three go at once");
  await pacer.take([["user", 3], ["route", 5]]);
  assert.ok(Date.now() - start >= 195, "the fourth waits for the first to leave the window");
  const before = Date.now();
  await pacer.take([["other", 1]]);
  assert.ok(Date.now() - before < 50, "an unrelated key isn't held up");
});
