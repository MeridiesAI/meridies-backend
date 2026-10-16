import { test } from "node:test";
import assert from "node:assert/strict";
import { isProfileTooLarge, MAX_PROFILE_BYTES, mergeProfile, plainNumber, profileBytes } from "../../src/lib/profileSize.js";

const big = (n: number) => "x".repeat(n);

test("the merged value is measured, not the patch", () => {
  const stored = { a: big(200_000) };
  // Each patch alone is well under the bound; the merge is not.
  const { tooLarge, merged } = mergeProfile(stored, { b: big(200_000) });
  assert.equal(tooLarge, true);
  assert.ok(profileBytes(merged) > MAX_PROFILE_BYTES);
});

test("a merge under the bound passes and keeps what the patch didn't send", () => {
  const { tooLarge, merged } = mergeProfile({ intakeAnswers: { q: 1 }, other: "kept" }, { intakeAnswers: { q: 2 } });
  assert.equal(tooLarge, false);
  assert.deepEqual(merged, { intakeAnswers: { q: 2 }, other: "kept" });
});

test("a profile already over the bound may shrink but never grow", () => {
  const stored = { a: big(200_000), b: big(200_000) };
  assert.equal(mergeProfile(stored, { b: null }).tooLarge, false, "nulling a key shrinks it");
  assert.equal(mergeProfile(stored, { b: big(200_000) }).tooLarge, false, "same size is not growth");
  assert.equal(mergeProfile(stored, { c: "one more" }).tooLarge, true, "growing past the bound is refused");
});

test("a stored value that isn't an object is replaced, not spread", () => {
  assert.deepEqual(mergeProfile(null, { a: 1 }).merged, { a: 1 });
  assert.deepEqual(mergeProfile("junk", { a: 1 }).merged, { a: 1 });
  assert.deepEqual(mergeProfile([1, 2], { a: 1 }).merged, { a: 1 });
});

// Each expected number is octet_length(<json>::jsonb::text) as Postgres
// printed it for the same value, so the API and the trigger measure alike.
test("profileBytes is the UTF-8 length of Postgres's jsonb text", () => {
  const cases: Array<[unknown, number]> = [
    [{}, 2],
    [{ a: [] }, 9],
    [{ a: {} }, 9],
    [{ a: [1, 2.5, -3, 1e-7, 1e21, "é\n\t\"\\\u0001", null, true, false] }, 93],
    [{ "ké y": { nested: [{ x: "日本語" }, "😀"] }, intakeAnswers: { q1: big(100), q2: ["a", "b"] } }, 198],
    [{ z: "  ", y: 0, x: -0.5 }, 33],
  ];
  for (const [value, pg] of cases) assert.equal(profileBytes(value), pg, JSON.stringify(value));
  assert.equal(profileBytes(null), 0);
  assert.equal(profileBytes(undefined), 0);
});

test("multi-byte text counts in bytes, so 4-byte characters can't carry four times the bound", () => {
  const emoji = "😀".repeat(80_000); // 160,000 UTF-16 units, 320,000 bytes
  assert.ok(JSON.stringify({ e: emoji }).length < MAX_PROFILE_BYTES);
  assert.equal(mergeProfile({}, { e: emoji }).tooLarge, true);
});

test("plainNumber prints exponent forms as plain digits, like numeric output", () => {
  assert.equal(plainNumber(1e21), "1000000000000000000000");
  assert.equal(plainNumber(1e-7), "0.0000001");
  assert.equal(plainNumber(-1.5e-7), "-0.00000015");
  assert.equal(plainNumber(1.2345e25), "12345000000000000000000000");
  assert.equal(plainNumber(42.5), "42.5");
});

test("isProfileTooLarge reads only the trigger's own refusal", () => {
  assert.equal(isProfileTooLarge({ code: "23514", message: "Profile is too large" }), true);
  assert.equal(isProfileTooLarge({ code: "23514", message: "That value is too long" }), false);
  assert.equal(isProfileTooLarge({ code: "42501", message: "Profile is too large" }), false);
  assert.equal(isProfileTooLarge(null), false);
});
