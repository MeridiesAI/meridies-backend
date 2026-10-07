import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceMechanicalEdit, enforceNoProse, isAdviceNotProse, researchDomains } from "../../src/lib/anthropic.js";
import { publicMessage, HttpError } from "../../src/lib/errors.js";
import { normalizeLink } from "../../src/lib/links.js";

test("the essay guardrail: bullets, not paragraphs", () => {
  assert.equal(isAdviceNotProse("Cut the second anecdote; it repeats the first."), true);
  assert.equal(isAdviceNotProse("One. Two. Three sentences is a paragraph."), false);
  assert.equal(isAdviceNotProse("x".repeat(241)), false);
  assert.deepEqual(enforceNoProse(["  Keep it.  ", "A. B. C."]), ["Keep it."]);
});

test("editing mode: mechanics only", () => {
  assert.equal(enforceMechanicalEdit("grammar", "their going", "they're going"), "they're going");
  assert.equal(enforceMechanicalEdit("content", "their going", "they're going"), null);
  assert.equal(enforceMechanicalEdit("grammar", "ok", "a whole new sentence that rewrites the thought entirely."), null);
});

test("client error text never carries a provider's message", () => {
  assert.equal(publicMessage(new HttpError(429, "You've hit today's AI limit."), "x"), "You've hit today's AI limit.");
  assert.equal(publicMessage(new Error("401 invalid x-api-key sk-ant-..."), "AxIS is unavailable"), "AxIS is unavailable");
});

test("the link guard refuses private addresses, credentials and odd ports", async () => {
  for (const bad of ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://[::1]/", "http://user:pw@example.com/", "http://example.com:8080/", "ftp://example.com/"]) {
    await assert.rejects(normalizeLink(bad), `${bad} should be refused`);
  }
});

test("research domains: plain hostnames, the school's site added", () => {
  const d = researchDomains(["https://www.stanford.edu/admission", "not a url", "javascript:x"]);
  assert.ok(d.includes("stanford.edu") && d.includes("collegeboard.org"));
  assert.ok(d.every((h) => /^[a-z0-9.-]+\.[a-z]+$/.test(h)));
});
