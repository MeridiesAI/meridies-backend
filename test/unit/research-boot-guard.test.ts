import assert from "node:assert/strict";
import { test } from "node:test";
import { researchFakeAllowed, researchFakeRefusal } from "../../src/lib/research/bootGuard.js";
import { fakeSeam } from "../../src/lib/research/fake.js";
import { realSeam, seamFor } from "../../src/lib/research/run.js";

test("the fake refuses to boot in production", () => {
  const msg = researchFakeRefusal({ RESEARCH_FAKE: "fixture", NODE_ENV: "production" });
  assert.ok(msg && msg.includes("RESEARCH_FAKE") && msg.includes("production"));
});
test("the fake is allowed only in development and test", () => {
  assert.equal(researchFakeRefusal({ RESEARCH_FAKE: "fixture", NODE_ENV: "development" }), null);
  assert.equal(researchFakeRefusal({ RESEARCH_FAKE: "fixture", NODE_ENV: "test" }), null);
});
test("any other NODE_ENV, or none, refuses the fake", () => {
  for (const NODE_ENV of ["staging", "preview", "prod", "Production", "development ", "", undefined]) {
    const msg = researchFakeRefusal({ RESEARCH_FAKE: "fixture", NODE_ENV });
    assert.ok(msg && msg.includes("RESEARCH_FAKE"), `NODE_ENV=${String(NODE_ENV)}`);
    assert.equal(researchFakeAllowed({ RESEARCH_FAKE: "fixture", NODE_ENV }), false);
    assert.equal(seamFor({ RESEARCH_FAKE: "fixture", NODE_ENV }), realSeam);
  }
});
test("without the fake nothing is refused, whatever NODE_ENV is", () => {
  for (const NODE_ENV of ["production", "development", "test", "staging", undefined]) {
    assert.equal(researchFakeRefusal({ NODE_ENV }), null);
    assert.equal(researchFakeRefusal({ RESEARCH_FAKE: undefined, NODE_ENV }), null);
    assert.equal(researchFakeRefusal({ RESEARCH_FAKE: "", NODE_ENV }), null);
  }
});
test("the seam is the fake only when asked for in development or test", () => {
  assert.equal(seamFor({ RESEARCH_FAKE: "fixture", NODE_ENV: "development" }), fakeSeam);
  assert.equal(seamFor({ RESEARCH_FAKE: "fixture", NODE_ENV: "test" }), fakeSeam);
  assert.equal(seamFor({ NODE_ENV: "development" }), realSeam);
});
