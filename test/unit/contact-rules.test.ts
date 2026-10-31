import assert from "node:assert/strict";
import { test } from "node:test";
import { activeStudentMessage, isValidPhone, missingForActiveStudent } from "../../src/lib/contactRules.js";

test("a phone is 10 to 15 digits with ordinary punctuation", () => {
  for (const ok of ["(555) 010-0100", "555.010.0100", "+1 555 010 0100", "5550100100"]) assert.equal(isValidPhone(ok), true, ok);
  for (const bad of ["", "12345", "555-010", "call me", "555-010-0100 x12", "1234567890123456"]) assert.equal(isValidPhone(bad), false, bad);
});

test("an Active student needs a student email, a phone and an address", () => {
  assert.deepEqual(missingForActiveStudent({}), ["a student email", "a valid phone number", "an address"]);
  assert.deepEqual(
    missingForActiveStudent({ studentEmail: "a@b.co", parentPhone: "555-010-0100", address: "1 Main St" }),
    []
  );
  assert.deepEqual(missingForActiveStudent({ studentEmail: "a@b.co", studentPhone: "123", address: " " }), [
    "a valid phone number",
    "an address",
  ]);
});

test("the refusal names what is missing", () => {
  assert.equal(
    activeStudentMessage("Ada", ["a student email", "an address"]),
    "Ada needs a student email and an address before becoming an active student"
  );
  assert.equal(activeStudentMessage("", ["an address"]), "This contact needs an address before becoming an active student");
});
