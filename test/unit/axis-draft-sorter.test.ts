// While an activity draft is open, code sorts each message into the draft or not (spec 4.1). The rule is tuned here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCancel, isContinue, isCorrection, isFileNow, isYes, sortMessage, type Verdict } from "../../src/lib/axis/drafts/sorter.js";
import type { Draft } from "../../src/lib/axis/drafts/state.js";
import { understand } from "../../src/lib/axis/nlu.js";

const NOW = new Date("2026-11-08T12:00:00Z");
const draft: Draft = {
  ready: true, version: "v1", notes: [], hadHeader: true,
  touched: { header: new Set(), rows: new Map(), closed: false },
  header: { kind: "activity", student_id: "s1", student_name: "Avery Lee", opened_at: NOW.toISOString(), updated_at: NOW.toISOString() },
  rows: [{ key: "r1", op: "add", fields: { organization: "Code Club", position: "Cofounder" }, sources: {}, read_as: {}, status: "collecting" }],
};
const sort = (text: string) => sortMessage(text, understand(text, { chatStudentId: "s1", roster: null, colleges: null, state: null, now: NOW }), draft);

const TABLE: [string, Verdict][] = [
  ["cancel", "cancel"],
  ["Cancel.", "cancel"],
  ["never mind", "cancel"],
  ["nevermind", "cancel"],
  ["forget it", "cancel"],
  ["stop", "cancel"],
  ["don't add it", "cancel"],
  ["scrap that", "cancel"],
  ["cancel the draft please", "cancel"],
  ["cancel her Tuesday meeting", "draft"],
  ["continue", "continue"],
  ["keep going", "continue"],
  ["back to the draft", "continue"],
  ["yes", "draft"],
  ["ok", "draft"],
  ["i gave it", "draft"],
  ["Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr", "draft"],
  ["6 hrs a week", "draft"],
  ["she's a junior", "draft"],
  ["all four years", "draft"],
  ["actually 8 hours", "draft"],
  ["make it 3 weeks", "draft"],
  ["no, it was over the summer", "draft"],
  ["wait, she's the president not cofounder", "draft"],
  ["code club ran at City Library", "draft"],
  ["City Library, please add it now", "draft"],
  ["add it", "draft"],
  ["that's all", "draft"],
  ["add Debate Club for Jordan Park, 5 hrs a week", "draft"],
  ["what's her GPA?", "unrelated"],
  ["Is her SAT 1450 good for UCLA?", "unrelated"],
  ["what are her grades?", "unrelated"],
  ["when is her Common App due?", "unrelated"],
  ["write a description for it", "unrelated"],
  ["who is behind this week?", "unrelated"],
  ["thanks!", "unrelated"],
  ["summarize her last meeting notes", "unrelated"],
  // Questions that carry a grade, season or hours word are still questions (checkpoint finding G).
  ["what should a junior be doing now?", "unrelated"],
  ["what did he do last summer?", "unrelated"],
  ["how is his junior year going?", "unrelated"],
  ["is 10 hours a week too much for him?", "unrelated"],
  ["how about 6 hours a week", "draft"],
  ["could you make it 8 hours?", "draft"],
  ["is Code Club still going?", "draft"],
];

test("the sorter table", () => {
  const wrong = TABLE.map(([m, want]) => [m, want, sort(m)] as const).filter(([, want, got]) => want !== got);
  assert.deepEqual(wrong, [], wrong.map(([m, want, got]) => `${m}: want ${want}, got ${got}`).join("\n"));
});

test("the word lists match whole messages, not words inside a request", () => {
  assert.ok(isCancel("never mind."));
  assert.ok(!isCancel("cancel her meeting"));
  assert.ok(isYes("Yeah!"));
  assert.ok(isYes("go ahead"));
  assert.ok(isYes("start again"));
  assert.ok(!isYes("yes but change the hours"));
  assert.ok(isContinue("Continue"));
  assert.ok(isFileNow("that's everything, add it"));
  assert.ok(isFileNow("ok save it"));
  assert.ok(!isFileNow("add Code Club"));
  assert.ok(isCorrection("actually 8 hours"));
  assert.ok(isCorrection("I meant junior year"));
});

test("an essay request is unrelated even when it names the draft", () => {
  assert.equal(sort("write a description for Code Club"), "unrelated");
});
