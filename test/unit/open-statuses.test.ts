// The named "still in play" status sets: an agreement that can still change, an activity-draft row still being
// asked about or waiting on Confirm, an account closure still under way. Each list is checked against every status
// its row can hold, so a status added later has to be placed on one side on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isOpenAgreement, OPEN_AGREEMENT_STATUSES } from "../../src/lib/agreements.js";
import { isOpenRow, OPEN_ROW_STATUSES, type RowStatus } from "../../src/lib/axis/drafts/state.js";
import { ACTIVE_CLOSURE_STATUSES, closureView, isActiveClosure, type ClosureStatus } from "../../src/lib/accountClosure.js";

test("an agreement is open while draft or sent, closed once accepted or void", () => {
  assert.deepEqual([...OPEN_AGREEMENT_STATUSES], ["draft", "sent"]);
  for (const s of ["draft", "sent"]) assert.equal(isOpenAgreement(s), true, s);
  for (const s of ["accepted", "void", "expired", "", null, undefined, 3]) assert.equal(isOpenAgreement(s), false, String(s));
});

test("a draft row is open while collecting or a card, an end otherwise", () => {
  const all: Record<RowStatus, boolean> = { collecting: true, card: true, saved: false, dismissed: false, skipped: false, failed: false };
  assert.deepEqual([...OPEN_ROW_STATUSES].sort(), ["card", "collecting"]);
  for (const [status, open] of Object.entries(all)) assert.equal(isOpenRow({ status: status as RowStatus }), open, status);
});

test("a closure is active while pending or purging; that is when its view reads pending", () => {
  const all: Record<ClosureStatus, boolean> = { pending: true, purging: true, cancelled: false, done: false, failed: false };
  assert.deepEqual([...ACTIVE_CLOSURE_STATUSES].sort(), ["pending", "purging"]);
  const now = new Date("2026-11-09T12:00:00Z");
  for (const [status, active] of Object.entries(all)) {
    const row = { status, requested_at: "2026-11-01T00:00:00Z", purge_after: "2026-12-01T00:00:00Z", last_error: null };
    assert.equal(isActiveClosure(row), active, status);
    if (status !== "failed") assert.equal(closureView(row, now, false).status, active ? "pending" : "none", status);
  }
  assert.equal(isActiveClosure(null), false);
  assert.equal(isActiveClosure(undefined), false);
});
