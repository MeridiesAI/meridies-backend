import assert from "node:assert/strict";
import { test } from "node:test";
import { documentAiDecision, documentReadableForTask, SENSITIVE_DOCUMENT_KINDS, toAiDoc } from "../../src/lib/context/documentAi.js";
import { refusalFor } from "../../src/lib/submissionReview.js";

test("the sensitive list is the five agreed kinds", () => {
  assert.deepEqual([...SENSITIVE_DOCUMENT_KINDS].sort(), ["award-letter", "counselor-only", "financial", "iep-504", "recommendation-letter"]);
});

test("the context layer, the tracker and submission review all refuse every sensitive kind", () => {
  for (const kind of SENSITIVE_DOCUMENT_KINDS) {
    const row = { kind, available_to_llm: true, ai_access: "default", ferpa_waived: false, kind_confirmed: true };
    assert.equal(documentAiDecision(toAiDoc(row), true).allowed, false, `context layer: ${kind}`);
    assert.equal(documentReadableForTask(toAiDoc(row), true).allowed, false, `tracker: ${kind}`);
    assert.notEqual(refusalFor(row, true), null, `submission review: ${kind}`);
  }
});
