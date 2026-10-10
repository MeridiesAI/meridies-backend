import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoIdentity, briefHash, identityTokens, IdentityLeakError, toResearchBrief } from "../../src/lib/research/brief.js";

const facts = {
  intendedMajors: ["Biology", "Computer Science"], gradYear: "2027", state: "WY",
  gpa: { value: 3.74, scale: "4.0" }, sat: 1460, act: null,
  activityCategories: ["Math competitions", "USAMO Qualifier", "robotics"],
  identity: { name: "Avery Quinlan", email: "avery.q@example.com", school: "Cheyenne Central High", hometown: "Cheyenne" },
};

test("the brief has categories and bands only", () => {
  const b = toResearchBrief(facts, "activities", null, new Date("2026-10-10"));
  assert.deepEqual(b.interests.sort(), ["math competitions", "robotics"]);
  assert.equal(b.gpaBand, "3.6–3.8 on 4.0");
  assert.equal(b.testBand, "SAT 1400–1500");
  assert.equal(b.grade, 12);
  assert.equal(b.region, "WY");
  const text = JSON.stringify(b).toLowerCase();
  for (const t of ["avery", "quinlan", "example.com", "cheyenne", "usamo"]) assert.ok(!text.includes(t), `${t} leaked`);
});
test("the grade rolls over on August 1 UTC, as the repo's currentGrade does (class of 2027)", () => {
  assert.equal(toResearchBrief(facts, "activities", null, new Date("2026-07-31T23:59:59Z")).grade, 11);
  assert.equal(toResearchBrief(facts, "activities", null, new Date("2026-08-01T00:00:00Z")).grade, 12);
});
test("a non-4/5 GPA scale gives an unknown band", () => {
  assert.equal(toResearchBrief({ ...facts, gpa: { value: 92, scale: "100" } }, "college_list", null).gpaBand, "unknown");
});
test("the identity filter refuses names, emails, schools and hometowns", () => {
  const tokens = identityTokens(facts.identity);
  assert.throws(() => assertNoIdentity("summer programs for Quinlan in Wyoming", tokens), IdentityLeakError);
  assert.throws(() => assertNoIdentity("cheyenne central high robotics", tokens), IdentityLeakError);
  assert.throws(() => assertNoIdentity("avery.q@example.com", tokens), IdentityLeakError);
  assert.doesNotThrow(() => assertNoIdentity("math competitions for high school juniors in WY", tokens));
});
test("focus text passes the same filter", () => {
  assert.throws(() => toResearchBrief(facts, "activities", "something like Avery's club"), IdentityLeakError);
});
test("the hash changes when majors change", () => {
  const a = briefHash(toResearchBrief(facts, "activities", null));
  const b = briefHash(toResearchBrief({ ...facts, intendedMajors: ["History"] }, "activities", null));
  assert.notEqual(a, b);
});

test("a CJK name is a token even when it is two characters", () => {
  const tokens = identityTokens({ name: "李明", email: null, school: null, hometown: null });
  assert.ok(tokens.includes("李明"));
  assert.throws(() => assertNoIdentity("适合李明的夏令营", tokens), IdentityLeakError);
});
test("a spaced CJK name also yields the joined form", () => {
  const tokens = identityTokens({ name: "李 明", email: null, school: null, hometown: null });
  assert.ok(tokens.includes("李明"));
});
test("a two-letter ASCII name part is not a token, a three-letter one is", () => {
  const tokens = identityTokens({ name: "Li Wei", email: null, school: null, hometown: null });
  assert.ok(!tokens.includes("li"));
  assert.ok(tokens.includes("wei"));
  assert.doesNotThrow(() => assertNoIdentity("reliable planning, li as a word", tokens));
  assert.throws(() => assertNoIdentity("Wei Chen science fair", tokens), IdentityLeakError);
});
test("empty or whitespace-only identity fields produce no tokens and never match", () => {
  const identity = { name: null, email: null, school: "", hometown: "  " };
  assert.deepEqual(identityTokens(identity), []);
  assert.doesNotThrow(() => assertNoIdentity("anything", identityTokens(identity)));
});
