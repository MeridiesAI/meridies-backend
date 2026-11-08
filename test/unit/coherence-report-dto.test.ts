import assert from "node:assert/strict";
import { test } from "node:test";
import { toCoherenceReport } from "../../src/lib/studentApplication.js";

// A report is run by the counselor or, now, by the student; each side needs to know which (the counselor's popup
// says "Run by {first}" on a student's), and it is derived from who created it, never stored or sent by a client.

const row = (over: Record<string, unknown>) => ({
  id: "r1",
  student_id: "stu",
  created_by: "stu",
  criteria: {},
  read_labels: ["Activities list"],
  storyline: [],
  next_steps: [],
  created_at: "2026-11-07T00:00:00Z",
  ...over,
});

test("a report created by the student is theirs: ranBy student", () => {
  assert.equal(toCoherenceReport(row({}), []).ranBy, "student");
});

test("a report created by anyone else is the counselor's: ranBy counselor", () => {
  assert.equal(toCoherenceReport(row({ created_by: "counselor-1" }), []).ranBy, "counselor");
});

test("a report whose creator is gone (the account was deleted) reads as the counselor's, never as the student's", () => {
  assert.equal(toCoherenceReport(row({ created_by: null }), []).ranBy, "counselor");
});

test("the rest of the report reads as it always did", () => {
  const r = toCoherenceReport(row({ created_by: "counselor-1", storyline: ["Origin: x"], next_steps: ["Do y"] }), []);
  assert.deepEqual({ id: r.id, read: r.read, storyline: r.storyline, next: r.next, flags: r.flags, createdAt: r.createdAt }, {
    id: "r1",
    read: ["Activities list"],
    storyline: ["Origin: x"],
    next: ["Do y"],
    flags: [],
    createdAt: "2026-11-07T00:00:00Z",
  });
});
