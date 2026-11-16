import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  MAX_ARRAY_LENGTH,
  MAX_BODY_NODES,
  MAX_VALIDATION_ISSUES,
  bodyTooComplex,
  cappedValidationDetails,
} from "../../src/lib/requestGuards.js";

test("ordinary bodies pass", () => {
  assert.equal(bodyTooComplex(undefined), null);
  assert.equal(bodyTooComplex(null), null);
  assert.equal(bodyTooComplex("a string body"), null);
  assert.equal(bodyTooComplex({}), null);
  assert.equal(bodyTooComplex({ studentIds: ["a", "b"], nested: { rows: [{ a: 1 }, { a: 2 }] } }), null);
  // The largest array any schema allows (2,000 cards in a pipeline column), and the bound itself.
  assert.equal(bodyTooComplex({ layout: { stage: new Array(2000).fill("id") } }), null);
  assert.equal(bodyTooComplex({ ids: new Array(MAX_ARRAY_LENGTH).fill(0) }), null);
  // 500 roster rows of a dozen fields each.
  const row = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, "x"]));
  assert.equal(bodyTooComplex({ rows: Array.from({ length: 500 }, () => ({ ...row })) }), null);
});

test("an array past the ceiling is refused, wherever it sits", () => {
  const long = new Array(MAX_ARRAY_LENGTH + 1).fill(0);
  assert.equal(bodyTooComplex(long), "array");
  assert.equal(bodyTooComplex({ studentIds: long }), "array");
  assert.equal(bodyTooComplex({ a: [{ b: { c: [[long]] } }] }), "array");
});

test("many small arrays or many keys are refused by the total", () => {
  const many = Array.from({ length: 100 }, () => new Array(1000).fill(0));
  assert.equal(bodyTooComplex({ many }), "nodes");
  const keys: Record<string, number> = {};
  for (let i = 0; i <= MAX_BODY_NODES; i++) keys[`k${i}`] = i;
  assert.equal(bodyTooComplex({ keys }), "nodes");
});

test("a binary or non-plain body is not walked", () => {
  assert.equal(bodyTooComplex(Buffer.alloc(1_000_000)), null);
  assert.equal(bodyTooComplex(new Uint8Array(100_000)), null);
  assert.equal(bodyTooComplex(new Map([["a", 1]])), null);
});

test("the walk is cheap on the body the audit measured, and on a deep one", () => {
  const huge = { studentIds: new Array(350_000).fill(0) };
  let deep: unknown = [];
  for (let i = 0; i < 100_000; i++) deep = [deep];
  const started = performance.now();
  assert.equal(bodyTooComplex(huge), "array");
  assert.equal(bodyTooComplex(deep), "nodes");
  assert.ok(performance.now() - started < 100, "the guard itself must not be expensive");
});

test("a null-prototype body (a parsed form) is walked like any object", () => {
  const form = Object.create(null) as Record<string, unknown>;
  form.ids = new Array(MAX_ARRAY_LENGTH + 1).fill("x");
  assert.equal(bodyTooComplex(form), "array");
});

test("validation details keep flatten()'s shape", () => {
  const schema = z.object({ kind: z.string(), n: z.number() }).strict();
  const parsed = schema.safeParse({ kind: 1, n: "x" });
  assert.ok(!parsed.success);
  const details = cappedValidationDetails(parsed.error.issues);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), JSON.parse(JSON.stringify(parsed.error.flatten())));
  assert.ok(!("omitted" in details));
});

test("an unrecognized key is still reported under formErrors", () => {
  const parsed = z.object({ rawNotes: z.string() }).strict().safeParse({ rawNotes: "x", kind: "transcript" });
  assert.ok(!parsed.success);
  const details = cappedValidationDetails(parsed.error.issues);
  assert.ok(details.formErrors.some((e) => /^Unrecognized keys?\b.*['"]kind['"]/i.test(e)), JSON.stringify(details));
});

test("issues are capped, counted and cut to a bounded length", () => {
  const issues = Array.from({ length: 1000 }, (_, i) => ({ path: ["studentIds", i], message: "Invalid uuid" }));
  const details = cappedValidationDetails(issues);
  assert.equal(details.fieldErrors.studentIds!.length, MAX_VALIDATION_ISSUES);
  assert.equal(details.omitted, 1000 - MAX_VALIDATION_ISSUES);

  const long = cappedValidationDetails([
    { path: [], message: "m".repeat(100_000) },
    { path: ["f".repeat(10_000)], message: "bad" },
    { path: ["__proto__"], message: "bad" },
  ]);
  assert.ok(long.formErrors[0]!.length <= 301);
  const json = JSON.stringify(long);
  assert.ok(json.length < 2000, `details stay small: ${json.length}`);
  assert.deepEqual(Object.keys(long.fieldErrors).length, 2);
});
