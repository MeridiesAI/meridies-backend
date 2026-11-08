import assert from "node:assert/strict";
import { test } from "node:test";
import { toProgram } from "../../src/lib/studentApplication.js";

// A program match carries who found it: the counselor's Activities Build, or the student's own. A database
// without the column (the migration not applied yet) sends none, and that reads as the counselor's.

const row = (over: Record<string, unknown> = {}) => ({ id: "m1", name: "Robotics Summer", status: "suggested", ...over });

test("a student's own search is marked as theirs", () => {
  assert.equal(toProgram(row({ origin: "student" })).origin, "student");
});

test("the counselor's, and a row with no origin at all, read as the counselor's", () => {
  assert.equal(toProgram(row({ origin: "counselor" })).origin, "counselor");
  assert.equal(toProgram(row()).origin, "counselor");
  assert.equal(toProgram(row({ origin: "something else" })).origin, "counselor");
});

test("the rest of a program reads as it always did", () => {
  const p = toProgram(row({ org: "State U", apply_url: "https://example.edu/apply", url: "https://example.edu", status: "saved", assigned_task_id: "t1" }));
  assert.equal(p.host, "State U");
  assert.equal(p.applyUrl, "https://example.edu/apply");
  assert.equal(p.url, "https://example.edu");
  assert.equal(p.status, "saved");
  assert.equal(p.assignedTaskId, "t1");
});
