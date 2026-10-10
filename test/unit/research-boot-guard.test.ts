import assert from "node:assert/strict";
import { test } from "node:test";
import { researchFakeRefusal } from "../../src/lib/research/bootGuard.js";

test("the fake refuses to boot in production", () => {
  const msg = researchFakeRefusal({ RESEARCH_FAKE: "fixture", NODE_ENV: "production" });
  assert.ok(msg && msg.includes("RESEARCH_FAKE"));
});
test("the fake is allowed in development and test", () => {
  assert.equal(researchFakeRefusal({ RESEARCH_FAKE: "fixture", NODE_ENV: "development" }), null);
  assert.equal(researchFakeRefusal({ RESEARCH_FAKE: "fixture", NODE_ENV: "test" }), null);
});
test("production without the fake boots", () => {
  assert.equal(researchFakeRefusal({ NODE_ENV: "production" }), null);
  assert.equal(researchFakeRefusal({ RESEARCH_FAKE: undefined, NODE_ENV: "production" }), null);
  assert.equal(researchFakeRefusal({ RESEARCH_FAKE: "", NODE_ENV: "production" }), null);
});
