import assert from "node:assert/strict";
import { test } from "node:test";
import { listChatSystem } from "../../src/lib/studentToolPrompts.js";

// The Build College Lists chat bar is the consultant's tool first; a student's version speaks to the student and
// never to a counselor. It changes only the wording: the model still returns one structured change from a fixed
// set of actions, and a deterministic filter picks the schools.

test("the counselor's list-chat prompt is the one it always was: a counselor's request, bullets to the counselor", () => {
  const p = listChatSystem("counselor");
  assert.match(p, /a counselor's request about a college list/);
  assert.match(p, /addressed to the counselor/);
});

test("the student's list-chat prompt speaks to the student and names no counselor", () => {
  const p = listChatSystem("student");
  assert.match(p, /student's request about their college list/);
  assert.match(p, /addressed to the student/);
  assert.doesNotMatch(p, /counselor/i);
});

test("both keep the same actions and the same rule that the model does not pick schools", () => {
  for (const audience of ["counselor", "student"] as const) {
    const p = listChatSystem(audience);
    assert.match(p, /You do not pick schools yourself: a deterministic filter does\./);
    for (const action of ["refresh", "more / fewer", "closer / farther", "test-optional", "set", "exclude", "none"]) {
      assert.ok(p.includes(action), `${audience}: ${action}`);
    }
    assert.match(p, /Sizes: Small, Medium, Large, Very large\./);
  }
});
