import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFeeCents, grossUpCents } from "../../src/lib/invoiceCardFee.js";

test("the gross-up leaves the practice the invoice amount after Stripe's 2.9% + 30c", () => {
  for (const net of [100, 5_000, 150_000, 333_333, 10_000_000]) {
    const gross = grossUpCents(net);
    const stripeKeeps = Math.round(gross * 0.029 + 30);
    assert.ok(gross - stripeKeeps >= net - 1, `${net}: nets ${gross - stripeKeeps}`);
    assert.ok(gross - stripeKeeps <= net + 1);
    // ...and never charges a whole dollar more than needed.
    assert.ok(grossUpCents(net) - net < Math.ceil(net * 0.03) + 100);
  }
  assert.equal(grossUpCents(150_000), 154_511);
});

test("nothing owed, no fee", () => {
  assert.equal(grossUpCents(0), 0);
  assert.equal(cardFeeCents(0, true, true), 0);
});

test("the fee is only ever charged when the flag is on AND the invoice passes it on", () => {
  assert.equal(cardFeeCents(150_000, true, false), 0);
  assert.equal(cardFeeCents(150_000, false, true), 0);
  assert.equal(cardFeeCents(150_000, null, true), 0);
  assert.equal(cardFeeCents(150_000, true, true), 4_511);
});

test("the flag is off unless the environment says true", () => {
  assert.equal(cardFeeCents(150_000, true), 0);
});
