import assert from "node:assert/strict";
import { test } from "node:test";
import { rosterLastActive } from "../../src/lib/inactivity.js";

test("rosterLastActive returns the ISO string", () => {
  assert.equal(rosterLastActive({ last_active_at: "2026-11-18T10:30:00.000Z" }), "2026-11-18T10:30:00.000Z");
});

test("rosterLastActive normalises what Postgres writes (offset, microseconds) to an ISO instant", () => {
  assert.equal(rosterLastActive({ last_active_at: "2026-11-18T05:30:00.123456+00:00" }), "2026-11-18T05:30:00.123Z");
});

test("rosterLastActive is null for null, for a missing column and for an unparseable string", () => {
  assert.equal(rosterLastActive({ last_active_at: null }), null);
  assert.equal(rosterLastActive({}), null);
  assert.equal(rosterLastActive({ last_active_at: "not a date" }), null);
  assert.equal(rosterLastActive({ last_active_at: "" }), null);
});
