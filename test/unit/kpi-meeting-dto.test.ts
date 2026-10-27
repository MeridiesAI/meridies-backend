import assert from "node:assert/strict";
import { test } from "node:test";
import { toMeeting } from "../../src/lib/serialize.js";

const row = { id: "m", student_id: "s", counselor_id: "c", title: "T", mode: "in-person", status: "held", guardians_invited: false };

test("before the Time saved migration a meeting carries no notesSentAt (the app hides the switch)", () => {
  assert.equal("notesSentAt" in toMeeting(row), false);
});

test("with the column, notesSentAt is null or the time", () => {
  assert.equal(toMeeting({ ...row, notes_sent_at: null }).notesSentAt, null);
  assert.equal(toMeeting({ ...row, notes_sent_at: "2026-10-01T00:00:00Z" }).notesSentAt, "2026-10-01T00:00:00Z");
});
