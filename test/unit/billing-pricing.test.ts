import assert from "node:assert/strict";
import { test } from "node:test";
import { billableQuantity, monthlyPrice, periodPrice, priceChange } from "../../src/lib/billingPricing.js";

test("monthly price follows the graduated tiers", () => {
  const expected: [number, number][] = [[1, 99], [6, 99], [7, 112], [25, 346], [26, 356], [50, 596], [51, 603], [100, 946]];
  for (const [students, price] of expected) assert.equal(monthlyPrice(students), price, `${students} students`);
});

test("zero, negative and odd counts bill as one student", () => {
  assert.equal(billableQuantity(0), 1);
  assert.equal(billableQuantity(-3), 1);
  assert.equal(billableQuantity(Number.NaN), 1);
  assert.equal(billableQuantity(7.9), 7);
  assert.equal(monthlyPrice(0), 99);
});

test("annual is ten times monthly", () => {
  assert.equal(periodPrice(7, "year"), 1120);
  assert.equal(periodPrice(7, "month"), 112);
});

test("a price change says which way it went", () => {
  assert.deepEqual(priceChange(6, 7, "month"), { from: 99, to: 112, direction: "up" });
  assert.equal(priceChange(7, 6, "month").direction, "down");
  assert.equal(priceChange(3, 5, "month").direction, "same");
});
