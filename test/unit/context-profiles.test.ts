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

import { essayBodyReadable } from "../../src/lib/context/sections.js";

test("an essay body is read only when unlinked, or linked to a file that came back and is not kept out", () => {
  assert.equal(essayBodyReadable(null, null), true);
  assert.equal(essayBodyReadable("doc-1", { available_to_llm: true }), true);
  assert.equal(essayBodyReadable("doc-1", { available_to_llm: false }), false);
  assert.equal(essayBodyReadable("doc-1", null), false, "a linked file RLS hid fails closed");
  assert.equal(essayBodyReadable("doc-1", { available_to_llm: true, kind_confirmed: false }), false, "an unconfirmed linked file keeps the body out");
  assert.equal(essayBodyReadable("doc-1", { available_to_llm: true, kind_confirmed: true }), true);
});

test("chat and student-ai both read intake answers", () => {
  assert.ok(PROFILES.chat.sections.includes("intake"));
  assert.ok(PROFILES["student-ai"].sections.includes("intake"));
});

import type { FastifyRequest } from "fastify";
import { buildStudentContext } from "../../src/lib/context/index.js";

test("buildStudentContext refuses a non-counselor before any read", async () => {
  const request = {
    profile: { role: "student" },
    get db(): never { throw new Error("the builder read from the database"); },
  } as unknown as FastifyRequest;
  await assert.rejects(buildStudentContext(request, "11111111-1111-1111-1111-111111111111", "chat"), (e: { statusCode?: number }) => e.statusCode === 403);
});
