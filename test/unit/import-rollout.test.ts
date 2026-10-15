import assert from "node:assert/strict";
import { test } from "node:test";
import { importsOpen, pilotIds } from "../../src/lib/imports/rollout.js";

const FIRM = "11111111-1111-4111-8111-111111111111";
const SOLO = "22222222-2222-4222-8222-222222222222";

test("the pilot list keeps only well-formed ids, case-insensitively", () => {
  const ids = pilotIds(` ${FIRM.toUpperCase()} , not-an-id,, ${SOLO}`);
  assert.deepEqual([...ids].sort(), [FIRM, SOLO].sort());
  assert.equal(pilotIds(undefined).size, 0);
});

test("all opens every practice; off opens none", () => {
  assert.equal(importsOpen("all", new Set(), FIRM), true);
  assert.equal(importsOpen("all", new Set(), null), true);
  assert.equal(importsOpen("off", new Set([FIRM]), FIRM), false);
});

test("pilot opens only listed practices, and an empty list opens none", () => {
  const pilot = pilotIds(FIRM);
  assert.equal(importsOpen("pilot", pilot, FIRM), true);
  assert.equal(importsOpen("pilot", pilot, FIRM.toUpperCase()), true);
  assert.equal(importsOpen("pilot", pilot, SOLO), false);
  assert.equal(importsOpen("pilot", new Set(), FIRM), false);
  assert.equal(importsOpen("pilot", pilot, null), false);
});
