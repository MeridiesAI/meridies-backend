import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILES, SECTION_TABLES } from "../../src/lib/context/profiles.js";
import { AI_ALLOWLIST } from "../../src/lib/context/ai-allowlist.js";

test("every profile section maps to allowlisted tables only", () => {
  for (const [feature, p] of Object.entries(PROFILES)) {
    for (const s of p.sections) {
      for (const t of SECTION_TABLES[s]) assert.ok(t in AI_ALLOWLIST, `${feature}.${s} reads ${t}, not on the allowlist`);
    }
  }
});
test("budgets match the spec", () => {
  assert.equal(PROFILES.chat.budget, 60_000);
  assert.equal(PROFILES["student-ai"].budget, 40_000);
  assert.equal(PROFILES["narrative-coherence"].budget, 50_000);
  assert.equal(PROFILES["college-list"].budget, 24_000);
  assert.equal(PROFILES.activities.budget, 24_000);
});
test("only coherence reads essay bodies", () => {
  for (const [f, p] of Object.entries(PROFILES)) assert.equal(p.essayBodies, f === "narrative-coherence");
});
