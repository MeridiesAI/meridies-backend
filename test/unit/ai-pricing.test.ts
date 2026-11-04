import assert from "node:assert/strict";
import { test } from "node:test";
import { priceFor, priceTableFrom, spendUsd, weightedInput } from "../../src/lib/aiPricing.js";

// Test data in the shape public.ai_budget_prices() returns (three of the seeded rows), not a second price list.
const t = priceTableFrom([
  { model: "claude-haiku-5-5", input_usd: "0.1000", output_usd: "0.5000", read_mult: "0.1000", write_5m_mult: "1.2500", write_1h_mult: "2.0000", long_above: 100000, long_mult: "5.00", web_search_usd: "0.0100" },
  { model: "claude-sonnet-5-5", input_usd: 2, output_usd: 10, read_mult: 0.05, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 },
  { model: "claude-fable-5-1", input_usd: 10, output_usd: 50, read_mult: 0.025, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 },
]);
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("Haiku 5.5 under 100K: reads at 0.1, unsplit writes at the 1-hour rate", () => {
  const u = { input: 10_000, cacheRead: 50_000, cacheWrite: 20_000, output: 1_000 };
  assert.equal(weightedInput(t, "claude-haiku-5-5", u), 55_000);
  close(spendUsd(t, "claude-haiku-5-5", u), 0.006);
});

test("Haiku 5.5 over 100K: the whole call at 5x", () => {
  const u = { input: 120_000, cacheRead: 0, cacheWrite: 0, output: 1_000 };
  assert.equal(weightedInput(t, "claude-haiku-5-5", u), 600_000);
  close(spendUsd(t, "claude-haiku-5-5", u), 0.0625);
});

test("Sonnet 5.5 cache reads at 0.05", () => {
  assert.equal(weightedInput(t, "claude-sonnet-5-5", { input: 0, cacheRead: 100_000, cacheWrite: 0, output: 0 }), 5_000);
});

test("a 5-minute write counts 1.25", () => {
  assert.equal(weightedInput(t, "claude-sonnet-5-5", { input: 0, cacheRead: 0, cacheWrite: 1_000, cacheWrite5m: 1_000, output: 0 }), 1_250);
  assert.equal(weightedInput(t, "claude-sonnet-5-5", { input: 0, cacheRead: 0, cacheWrite: 2_000, cacheWrite5m: 1_000, cacheWrite1h: 1_000, output: 0 }), 3_250);
});

test("a model with no row is priced at the table's highest rates", () => {
  const p = priceFor(t, "claude-new-9");
  assert.equal(p.inputUsd, 10);
  assert.equal(p.outputUsd, 50);
  assert.equal(p.readMult, 0.1);
  assert.equal(p.longAbove, null, "no tier");
  assert.ok(spendUsd(t, "claude-new-9", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }) >= 10, "never free");
  assert.throws(() => priceFor(priceTableFrom([]), "claude-haiku-5-5"));
});

test("web searches add a cent each", () => {
  const u = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  close(spendUsd(t, "claude-sonnet-5-5", { ...u, webSearches: 3 }) - spendUsd(t, "claude-sonnet-5-5", u), 0.03);
});

test("priceTableFrom reads numeric strings and refuses a malformed row", () => {
  assert.equal(t.get("claude-haiku-5-5")!.inputUsd, 0.1);
  assert.equal(t.get("claude-haiku-5-5")!.longMult, 5);
  const row = { model: "claude-x", input_usd: 1, output_usd: 1, read_mult: 0.1, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 };
  assert.throws(() => priceTableFrom([{ ...row, input_usd: "free" }]));
  assert.throws(() => priceTableFrom([{ ...row, output_usd: -1 }]));
  assert.throws(() => priceTableFrom([{ ...row, model: "" }]));
  assert.throws(() => priceTableFrom([null]));
  assert.throws(() => priceTableFrom([{ ...row, write_5m_mult: 0 }]), "a free cache write");
  assert.throws(() => priceTableFrom([{ ...row, read_mult: 0 }]));
});
