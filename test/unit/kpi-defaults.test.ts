import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BASELINES, DEFAULT_HOURS_PER_STUDENT, DEFAULT_RATE, toBaselinesDto } from "../../src/lib/kpi/defaults.js";

test("defaults are the spec's figures", () => {
  assert.deepEqual(DEFAULT_BASELINES, {
    college_list: { manual: 240, meridies: 30 },
    essay_feedback: { manual: 45, meridies: 15 },
    meeting: { manual: 45, meridies: 15 },
    family_report: { manual: 60, meridies: 10 },
    activity_list: { manual: 90, meridies: 20 },
  });
  assert.equal(DEFAULT_RATE, 150);
  assert.equal(DEFAULT_HOURS_PER_STUDENT, 40);
});

test("no row: every figure is the default, unedited, and the prompt is due", () => {
  const dto = toBaselinesDto(null);
  assert.equal(dto.needsPrompt, true);
  assert.equal(dto.hourlyRate, 150);
  assert.equal(dto.rateEdited, false);
  assert.deepEqual(dto.tasks.meeting, { manual: 45, meridies: 15, manualEdited: false, meridiesEdited: false });
});

test("a saved row overrides only what it holds", () => {
  const dto = toBaselinesDto({
    manual: { college_list: 300 }, meridies: {}, manual_edited: { college_list: true }, meridies_edited: {},
    hourly_rate: "200.00", rate_edited: true, hours_per_student_year: null, hours_edited: false,
    monthly_email: false, prompt_dismissed_at: null,
  });
  assert.equal(dto.needsPrompt, false);
  assert.deepEqual(dto.tasks.college_list, { manual: 300, meridies: 30, manualEdited: true, meridiesEdited: false });
  assert.equal(dto.hourlyRate, 200);
  assert.equal(dto.hoursPerStudentYear, 40);
  assert.equal(dto.monthlyEmail, false);
});
