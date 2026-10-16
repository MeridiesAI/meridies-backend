import assert from "node:assert/strict";
import { test } from "node:test";
import { HELD_ELSEWHERE, heldForSomeoneElse, sameStudentName, skipHeldElsewhere, type HeldAtAddress } from "../../src/lib/imports/heldAddresses.js";
import { toPayload, type StageItem } from "../../src/lib/imports/match.js";

const held: HeldAtAddress[] = [{ email: "parent@x.org", name: "Mia Park", itemId: "item-mia" }];

const item = (name: string | null, email: string | null): StageItem => ({
  key: `k-${name}`, fileId: null, locator: { sourceRef: "S!A2", rows: 1 }, importedName: name, matchStatus: "new_invite",
  confidence: null, reasons: [], studentId: null, candidates: [],
  matchKey: { email, name, birthday: null, gradYear: null, highSchool: null }, skipReason: null, flags: [],
  changes: [{ target: "student_academics", field: "sat_superscore", op: "set_field", value: 1100, sourceRef: "S!C2", sourceColumn: "SAT", patternKey: "p", flags: [], alternatives: null, invalid: false }],
});

test("an address carrying another student's held data is not invited for someone else", () => {
  assert.equal(heldForSomeoneElse("Parent@X.org ", "Leo Park", held), true);
  assert.equal(heldForSomeoneElse("parent@x.org", null, held), true, "an unknown name counts as someone else");
  assert.equal(heldForSomeoneElse("parent@x.org", "Mia Park", held), false, "the same student again is fine");
  assert.equal(heldForSomeoneElse("parent@x.org", "mia park", held), false);
  assert.equal(heldForSomeoneElse("other@x.org", "Leo Park", held), false);
  assert.equal(heldForSomeoneElse("parent@x.org", "Leo Park", held, "item-mia"), false, "an item never blocks itself");
  assert.equal(heldForSomeoneElse("parent@x.org", "Leo Park", [{ ...held[0], name: null }]), true);
  assert.equal(heldForSomeoneElse("parent@x.org", "  Mia   PARK ", held), false, "case and spacing don't matter");
});

test("the same student is the same non-blank full name, the rule accept_invitation applies", () => {
  assert.equal(sameStudentName("Mia Park", "mia  park"), true);
  // A nickname is someone else: the sweep (20261024000062) wouldn't move it either.
  assert.equal(sameStudentName("Sam Lee", "Samuel Lee"), false);
  assert.equal(heldForSomeoneElse("p@x.org", "Samuel Lee", [{ email: "p@x.org", name: "Sam Lee", itemId: "i" }]), true);
  assert.equal(sameStudentName(null, null), false);
  assert.equal(sameStudentName("", " "), false);
  assert.equal(sameStudentName("Mia Park", null), false);
});

test("staging skips such a row, with the reason, and keeps none of its values", () => {
  const items = [item("Leo Park", "parent@x.org"), item("Mia Park", "parent@x.org"), item("Ann Lee", "ann@x.org")];
  assert.equal(skipHeldElsewhere(items, held), 1);
  assert.deepEqual(items.map((i) => i.matchStatus), ["skipped", "new_invite", "new_invite"]);
  assert.equal(items[0].skipReason, HELD_ELSEWHERE);
  assert.deepEqual(items[0].flags, [], "not flagged shared_email, so review can't invite it after all");
  const payload = toPayload(items, { rows: 3, blocked: 0 });
  assert.equal(payload.changes.filter((c) => c.item === items[0].key).length, 0);
});
