import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import { cleanEstimate, cleanNodeEstimate, EXTRA_NODE_KEYS, polygonEstimatePrompt, polygonEstimateSchema, RATIONALE_MAX } from "../../src/lib/polygonEstimate.js";
import { toAxisDto } from "../../src/lib/studentPage.js";

const axes = [{ key: "academics" }, { key: "extracurriculars" }, { key: "narrative" }];

test("keeps known axes, rounds and clamps the score, bounds the reason", () => {
  const out = cleanEstimate(
    { axes: [
      { key: "academics", score: 87.6, rationale: "  4.1 GPA\n with   5 APs  " },
      { key: "extracurriculars", score: 140, rationale: "x".repeat(500) },
      { key: "narrative", score: -5, rationale: "thin" },
    ] },
    axes
  );
  assert.deepEqual(out[0], { key: "academics", score: 88, rationale: "4.1 GPA with 5 APs" });
  assert.equal(out[1].score, 100);
  assert.equal(out[1].rationale?.length, RATIONALE_MAX);
  assert.equal(out[2].score, 0);
});

test("a long reason is cut at a word and marked, never mid-word", () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const [e] = cleanEstimate({ axes: [{ key: "academics", score: 50, rationale: long }] }, axes);
  assert.ok(e.rationale!.length <= RATIONALE_MAX);
  assert.ok(e.rationale!.endsWith("…"));
  assert.match(e.rationale!.slice(0, -1), /word\d+$/);
});

test("drops unknown keys and repeats, reads a non-number or null as 'not enough data'", () => {
  const out = cleanEstimate(
    { axes: [
      { key: "hacked", score: 99, rationale: "no" },
      { key: "academics", score: "high", rationale: "not a number" },
      { key: "academics", score: 90, rationale: "second answer for the same axis" },
      { key: "narrative", score: null, rationale: "no goals on file" },
      { key: "extracurriculars", score: Number.NaN, rationale: "" },
    ] },
    axes
  );
  assert.deepEqual(out.map((e) => e.key), ["academics", "narrative", "extracurriculars"]);
  assert.equal(out[0].score, null);
  assert.equal(out[2].score, null);
  assert.equal(out[2].rationale, null);
});

test("refuses an answer with nothing usable in it", () => {
  for (const bad of [null, undefined, "text", {}, { axes: "no" }, { axes: [] }, { axes: [{ key: "nope", score: 5, rationale: "x" }] }]) {
    assert.throws(() => cleanEstimate(bad, axes), HttpError);
  }
});

test("the schema only lets the model name the student's own axes", () => {
  const schema = polygonEstimateSchema(["academics", "custom-grit"]);
  assert.deepEqual(schema.properties.axes.items.properties.key.enum, ["academics", "custom-grit"]);
});

test("the prompt guides default axes, and tells a custom axis to be judged from its own words", () => {
  const prompt = polygonEstimatePrompt(
    [
      { key: "academics", label: "Academics", description: null },
      { key: "custom-grit", label: "Grit", description: "Persistence through setbacks" },
      { key: "custom-x", label: "Mystery", description: null },
    ],
    "BRIEF"
  );
  assert.match(prompt, /academics \(Academics\): .*GPA/);
  assert.match(prompt, /custom-grit \(Grit\): Persistence through setbacks/);
  assert.match(prompt, /custom-x \(Mystery\): No definition given/);
  assert.match(prompt, /BRIEF$/);
});

test("an axis's shown score is the counselor's, else the AI's, else the formula's", () => {
  const row = { id: "a", key: "academics", label: "Academics", sort_order: 0, source: "default", auto_score: "70", ai_score: "82", manual_score: null };
  assert.equal(toAxisDto(row).score, 82);
  assert.equal(toAxisDto({ ...row, manual_score: "60" }).score, 60);
  assert.equal(toAxisDto({ ...row, ai_score: null }).score, 70);
  assert.equal(toAxisDto({ ...row, ai_score: null, auto_score: null }).score, null);
  assert.equal(toAxisDto({ ...row, ai_rationale: "because" }).aiRationale, "because");
});

test("detail nodes: only the six known keys, clamped, a null kept as 'not enough data'", () => {
  const out = cleanNodeEstimate({
    axes: [],
    nodes: [
      { key: "leadership", score: 71.4, rationale: "Founded a 14-chapter nonprofit." },
      { key: "service", score: 130, rationale: "" },
      { key: "arts", score: null, rationale: "Nothing in the record." },
      { key: "grades", score: 90, rationale: "an axis, not a detail node" },
      { key: "leadership", score: 5, rationale: "a repeat" },
    ],
  });
  assert.deepEqual(out.map((n) => n.key), ["leadership", "service", "arts"]);
  assert.equal(out[0].score, 71);
  assert.equal(out[1].score, 100);
  assert.equal(out[1].rationale, null);
  assert.equal(out[2].score, null);
});

test("a missing or malformed nodes answer is no nodes, never an error, and never touches the axes", () => {
  for (const v of [null, {}, { nodes: "no" }, { nodes: [null, 3] }]) assert.deepEqual(cleanNodeEstimate(v), []);
  assert.equal(cleanEstimate({ axes: [{ key: "academics", score: 60, rationale: "ok" }], nodes: "garbage" }, [{ key: "academics" }]).length, 1);
});

test("the schema and prompt name all six detail nodes", () => {
  const schema = polygonEstimateSchema(["academics"]);
  assert.deepEqual(schema.properties.nodes.items.properties.key.enum, EXTRA_NODE_KEYS);
  assert.deepEqual([...EXTRA_NODE_KEYS].sort(), ["arts", "awards", "leadership", "research", "school-fit", "service"]);
  const prompt = polygonEstimatePrompt([{ key: "academics", label: "Grades", description: null }], "BRIEF");
  for (const k of EXTRA_NODE_KEYS) assert.match(prompt, new RegExp(`- ${k}: `));
});
