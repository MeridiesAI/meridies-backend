import assert from "node:assert/strict";
import test from "node:test";
import { ageOn, isUnderMinAge } from "../../src/lib/age.js";
import { infoPatchSchema } from "../../src/lib/studentPage.js";

const now = new Date("2026-11-18T12:00:00Z");

test("age counts whole years and respects the birthday", () => {
  assert.equal(ageOn("2013-11-18", now), 13);
  assert.equal(ageOn("2013-11-19", now), 12);
  assert.equal(ageOn("2000-02-29", now), 26);
  assert.equal(ageOn("2013-02-30", now), null);
  assert.equal(ageOn("nonsense", now), null);
});

test("under 13 is refused, 13 and over is not, a future date counts as under", () => {
  assert.equal(isUnderMinAge("2013-11-19", now), true);
  assert.equal(isUnderMinAge("2013-11-18", now), false);
  assert.equal(isUnderMinAge("2030-01-01", now), true);
  assert.equal(isUnderMinAge("garbage", now), false);
});

test("the info card refuses an under-13 birthday without quoting it", () => {
  const young = new Date().getUTCFullYear() - 8;
  const r = infoPatchSchema.safeParse({ birthday: `${young}-06-15` });
  assert.equal(r.success, false);
  if (!r.success) assert.ok(!JSON.stringify(r.error.issues).includes(String(young)));
  assert.equal(infoPatchSchema.safeParse({ birthday: "2008-06-15" }).success, true);
  assert.equal(infoPatchSchema.safeParse({ birthday: null }).success, true);
});
