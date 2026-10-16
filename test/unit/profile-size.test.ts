import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROFILE_CHARS, mergeProfile, profileChars } from "../../src/lib/profileSize.js";

const big = (n: number) => "x".repeat(n);

test("the merged value is measured, not the patch", () => {
  const stored = { a: big(150_000) };
  // Each patch alone is well under the bound; the merge is not.
  const { tooLarge, merged } = mergeProfile(stored, { b: big(150_000) });
  assert.equal(tooLarge, true);
  assert.ok(profileChars(merged) > MAX_PROFILE_CHARS);
});

test("a merge under the bound passes and keeps what the patch didn't send", () => {
  const { tooLarge, merged } = mergeProfile({ intakeAnswers: { q: 1 }, other: "kept" }, { intakeAnswers: { q: 2 } });
  assert.equal(tooLarge, false);
  assert.deepEqual(merged, { intakeAnswers: { q: 2 }, other: "kept" });
});

test("a profile already over the bound may shrink but never grow", () => {
  const stored = { a: big(150_000), b: big(150_000) };
  assert.equal(mergeProfile(stored, { b: null }).tooLarge, false, "nulling a key shrinks it");
  assert.equal(mergeProfile(stored, { b: big(150_000) }).tooLarge, false, "same size is not growth");
  assert.equal(mergeProfile(stored, { c: "one more" }).tooLarge, true, "growing past the bound is refused");
});

test("a stored value that isn't an object is replaced, not spread", () => {
  assert.deepEqual(mergeProfile(null, { a: 1 }).merged, { a: 1 });
  assert.deepEqual(mergeProfile("junk", { a: 1 }).merged, { a: 1 });
  assert.deepEqual(mergeProfile([1, 2], { a: 1 }).merged, { a: 1 });
});

test("profileChars is JSON.stringify's length, zero for nothing", () => {
  assert.equal(profileChars(null), 0);
  assert.equal(profileChars(undefined), 0);
  assert.equal(profileChars({ a: "b" }), JSON.stringify({ a: "b" }).length);
});
