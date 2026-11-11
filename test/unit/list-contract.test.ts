import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CARD_FEATURE_MAP,
  CORE_FEATURE_KEYS,
  CORE_FEATURES,
  LEARNING_CONFIG,
  MATCH_CONFIG,
  OPPORTUNITY_CATEGORIES,
} from "../../src/lib/listContract.js";

// The list-match contract's keys must match what is stored: feature keys the college_core_features CHECK accepts,
// and card keys the preference card seed actually has.

const SEED = fileURLToPath(
  new URL("../../supabase/migrations/20261105000006_seed_preference_cards.sql", import.meta.url)
);

test("ten core features, each a key the table accepts", () => {
  assert.equal(CORE_FEATURE_KEYS.length, 10);
  for (const key of CORE_FEATURE_KEYS) {
    assert.match(key, /^[a-z][a-z0-9_]{0,62}$/);
    assert.ok(CORE_FEATURES[key].description.length > 0);
  }
});

test("every mapped card is a seeded card, pointing at a core feature", () => {
  const seeded = new Set([...readFileSync(SEED, "utf8").matchAll(/^\s*\('([a-z0-9-]+)',/gm)].map((m) => m[1]));
  assert.equal(seeded.size, 26);
  for (const [card, link] of Object.entries(CARD_FEATURE_MAP)) {
    assert.ok(seeded.has(card), `${card} is not a seeded preference card`);
    assert.ok(link.feature in CORE_FEATURES);
  }
});

test("shares add up and weights are in range", () => {
  assert.equal(MATCH_CONFIG.coreShare + MATCH_CONFIG.opportunityShare, 1);
  for (const { priorWeight } of Object.values(OPPORTUNITY_CATEGORIES)) {
    assert.ok(priorWeight > 0 && priorWeight <= 1);
  }
  assert.ok(LEARNING_CONFIG.maxDeltaFromPrior > 0 && LEARNING_CONFIG.maxDeltaFromPrior < 1);
});
