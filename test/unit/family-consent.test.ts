import assert from "node:assert/strict";
import test from "node:test";
import { consentLink, stateOf, submissionBody } from "../../src/routes/familyConsent.js";
import { promptEnabled } from "../../src/routes/platformTerms.js";

const now = new Date("2026-11-18T00:00:00Z");
const future = "2026-12-01T00:00:00Z";
const past = "2026-11-01T00:00:00Z";

test("a link's state: pending, expired, signed, revoked", () => {
  assert.equal(stateOf({ status: "pending", expires_at: future }, now), "pending");
  assert.equal(stateOf({ status: "pending", expires_at: past }, now), "expired");
  assert.equal(stateOf({ status: "signed", expires_at: past }, now), "signed");
  assert.equal(stateOf({ status: "revoked", expires_at: future }, now), "revoked");
});

const good = {
  guardianFullName: "Pat Lee", relationship: "Parent", guardianEmail: "pat@example.com",
  studentFullName: "Sam Lee", studentIsAdult: false, guardianTypedSignature: "Pat Lee",
  agreed: true, consentVersion: "2026-11-01",
};

test("the signed form needs agreement, and an adult student signs too", () => {
  assert.equal(submissionBody.safeParse(good).success, true);
  assert.equal(submissionBody.safeParse({ ...good, agreed: false }).success, false);
  assert.equal(submissionBody.safeParse({ ...good, studentIsAdult: true }).success, false);
  assert.equal(submissionBody.safeParse({ ...good, studentIsAdult: true, studentTypedSignature: "Sam Lee" }).success, true);
  assert.equal(submissionBody.safeParse({ ...good, extra: 1 }).success, false);
});

test("the link points at the website's form", () => {
  assert.match(consentLink("abc"), /^https:\/\/[^/]+\/privacy\/family-consent\/abc$/);
});

test("the terms prompt is on only for exactly 'true'", () => {
  assert.equal(promptEnabled("true"), true);
  assert.equal(promptEnabled("TRUE"), false);
  assert.equal(promptEnabled(undefined), false);
});
