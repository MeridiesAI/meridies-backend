import assert from "node:assert/strict";
import { test } from "node:test";
import { canConfirm, itemStatus } from "../../src/lib/newStudentIntake.js";
import { COUNSELOR_STEPS, STUDENT_STEPS, hasAnswers, openSteps, type SetupFacts } from "../../src/lib/studentSetup.js";
import { nextTaskStatus } from "../../src/lib/submissionReview.js";

test("a request reads received, submitted, sent back or requested off its task", () => {
  assert.equal(itemStatus(null, false), "requested");
  assert.equal(itemStatus(null, true), "received");
  assert.equal(itemStatus({ status: "not-started" }, false), "requested");
  assert.equal(itemStatus({ status: "review" }, false), "submitted");
  assert.equal(itemStatus({ status: "in-progress", sentBackNote: "The official one, please." }, false), "sent-back");
  assert.equal(itemStatus({ status: "complete" }, false), "received");
});

test("confirm waits for the student to join and every request to be received", () => {
  assert.equal(canConfirm({ status: "pending", requests: [] }), false);
  assert.equal(canConfirm({ status: "accepted", requests: [] }), true);
  assert.equal(canConfirm({ status: "accepted", requests: [{ provided: true }, { provided: false }] }), false);
  assert.equal(canConfirm({ status: "accepted", requests: [{ provided: true }, { provided: true }] }), true);
});

test("on a New student request AxIS advises and never moves the task", () => {
  assert.equal(nextTaskStatus("review", "accepted", true), null);
  assert.equal(nextTaskStatus("review", "needs-fix", true), null);
  assert.equal(nextTaskStatus("review", "accepted", false), "complete");
});

test("setup steps clear themselves as the record fills in", () => {
  const none: SetupFacts = {
    academics: false, polygon: false, recommend: false, activities: false,
    guardian: false, meeting: false, colleges: false, details: false, profile: false,
  };
  assert.equal(openSteps(COUNSELOR_STEPS, none).length, COUNSELOR_STEPS.length);
  assert.equal(openSteps(STUDENT_STEPS, none).length, STUDENT_STEPS.length);

  const some = { ...none, academics: true, guardian: true, colleges: true };
  assert.deepEqual(
    openSteps(COUNSELOR_STEPS, some).map((s) => s.key),
    ["polygon", "recommend", "activities", "meeting"]
  );
  assert.deepEqual(openSteps(STUDENT_STEPS, some).map((s) => s.key), ["profile", "activities", "details"]);
  // A student who never skipped step 2 has nothing to fill out.
  assert.deepEqual(openSteps(STUDENT_STEPS, { ...some, profile: true }).map((s) => s.key), ["activities", "details"]);

  const all = Object.fromEntries(Object.keys(none).map((k) => [k, true])) as SetupFacts;
  assert.equal(openSteps(COUNSELOR_STEPS, all).length, 0);
});

test("the profile step clears once the questionnaire has any answer", () => {
  assert.equal(hasAnswers({ gpa: "3.9" }), true);
  assert.equal(hasAnswers({}), false);
  assert.equal(hasAnswers(null), false);
  assert.equal(hasAnswers(undefined), false);
});
