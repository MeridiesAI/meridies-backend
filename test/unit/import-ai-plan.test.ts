import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import type { RunOptions } from "../../src/lib/anthropic.js";
import { HttpError, unavailable } from "../../src/lib/errors.js";
import { aiPlan, buildPrompt, CAP_REASON, MANUAL_REASON, targetList, toColumns, type Unmapped } from "../../src/lib/imports/aiPlan.js";
import { profileSheet } from "../../src/lib/imports/profile.js";
import { costCents } from "../../src/lib/imports/spend.js";
import { aiSwitchFor } from "../../src/lib/practiceSettings.js";
import { FIELDS } from "./import-fixtures.js";

const FILE = "11111111-1111-4111-8111-111111111111";
const sheet = profileSheet({
  name: "Maya Patel scores",
  headerRow: 1,
  headers: ["Student", "Contact", "GPA", "Calc BC", "Notes", "SSN"],
  rows: [
    ["Maya Patel", "maya.patel@gmail.com", "3.92", "5", "Plays cello at Lincoln High", "123-45-6789"],
    ["Omar Haddad", "omar.h@yahoo.com", "3.41", "4", "Wants to study nursing", "987-65-4321"],
  ],
  rowNumbers: [2, 3],
  date1904: false,
});
const unmapped: Unmapped[] = [{ fileId: FILE, sheet, indexes: new Set([0, 1, 2, 3, 4]) }];
const request = {} as FastifyRequest;
const noSleep = async () => undefined;

test("the prompt holds no real text cell, no sheet name and no sensitive column", () => {
  const prompt = buildPrompt(unmapped, targetList(FIELDS));
  for (const leak of ["Maya", "Patel", "Omar", "Haddad", "gmail", "yahoo", "cello", "Lincoln", "nursing", "123-45"]) {
    assert.ok(!prompt.includes(leak), `leaked ${leak}`);
  }
  // Spec §7.2: a small numeric column's range is a column statistic the model may see.
  assert.ok(prompt.includes('"min":3.41') && prompt.includes('"max":3.92'));
  assert.ok(prompt.includes('kind="untrusted"'));
  assert.ok(!prompt.includes("SSN"));
});

test("the answer is filtered: unasked columns, invented targets and fields are dropped", () => {
  const out = toColumns(
    {
      sourceSystem: "naviance",
      columns: [
        { sheet: 1, index: 0, target: "key:full_name" },
        { sheet: 1, index: 1, target: "key:email" },
        { sheet: 1, index: 2, target: "field:student_academics.gpa_unweighted" },
        { sheet: 1, index: 3, target: "score_column" },
        { sheet: 1, index: 4, target: "field:student_academics.secret_notes" },
        { sheet: 1, index: 5, target: "field:student_personal_details.address" },
        { sheet: 2, index: 0, target: "key:email" },
        { sheet: 1, index: 0, target: "key:email" },
      ],
    },
    unmapped,
    FIELDS
  );
  assert.deepEqual(out.columns.map((c) => [c.column.index, c.column.target.kind]), [[0, "key"], [1, "key"], [2, "field"], [3, "score_column"]]);
  const score = out.columns.find((c) => c.column.index === 3)!.column.target;
  assert.deepEqual(score, { kind: "score_column", exam: "Calc BC", testKind: "other" });
  assert.ok(out.columns.every((c) => c.column.source === "ai"));
  assert.equal(out.sourceSystem, "naviance");
});

test("a working call maps columns and records its spend", async () => {
  let added = 0;
  const run = async <T,>(opts: RunOptions<T>): Promise<T> => {
    assert.equal(opts.module, "import-mapping");
    await opts.onUsage?.({ inputTokens: 10_000, outputTokens: 2_000, model: "claude-haiku-4-5" });
    return opts.validate!({ columns: [{ sheet: 1, index: 1, target: "key:email" }] });
  };
  const out = await aiPlan(request, unmapped, FIELDS, { run, addSpend: async (c) => (added += c), spent: 0, sleep: noSleep });
  assert.equal(out.manual, false);
  assert.equal(added, costCents("claude-haiku-4-5", 10_000, 2_000));
});

test("two retries, then manual mapping", async () => {
  let calls = 0;
  const run = async <T,>(_o: RunOptions<T>): Promise<T> => {
    calls += 1;
    throw unavailable("The AI service is unavailable right now. Try again shortly.");
  };
  const out = await aiPlan(request, unmapped, FIELDS, { run, addSpend: async () => 0, spent: 0, sleep: noSleep });
  assert.deepEqual(out, { manual: true, reason: MANUAL_REASON });
  assert.equal(calls, 3);
});

test("a spent quota or a practice that switched document reading off stops at once", async () => {
  for (const status of [429, 403]) {
    let calls = 0;
    const run = async <T,>(_o: RunOptions<T>): Promise<T> => {
      calls += 1;
      throw new HttpError(status, status === 429 ? "You've hit today's AI limit." : "Automatic document reading is turned off in Settings › Data & privacy.");
    };
    const out = await aiPlan(request, unmapped, FIELDS, { run, addSpend: async () => 0, spent: 0, sleep: noSleep });
    assert.equal(out.manual, true);
    assert.equal(calls, 1);
  }
});

test("the 200-cent cap skips the call, and spend reported mid-retry stops the next one", async () => {
  let calls = 0;
  const run = async <T,>(o: RunOptions<T>): Promise<T> => {
    calls += 1;
    await o.onUsage?.({ inputTokens: 1, outputTokens: 1, model: "x" });
    throw unavailable("busy");
  };
  assert.deepEqual(await aiPlan(request, unmapped, FIELDS, { run, addSpend: async () => 0, spent: 200, sleep: noSleep }), { manual: true, reason: CAP_REASON });
  assert.equal(calls, 0);
  const out = await aiPlan(request, unmapped, FIELDS, { run, addSpend: async () => 250, spent: 0, sleep: noSleep });
  assert.deepEqual(out, { manual: true, reason: CAP_REASON });
  assert.equal(calls, 1);
});

test("spend is priced per model, rounding up, unknown models priced high", () => {
  assert.equal(costCents("claude-haiku-4-5", 1_000_000, 0), 100);
  assert.equal(costCents("claude-haiku-4-5", 1, 1), 1);
  assert.ok(costCents("mystery", 100_000, 10_000) > costCents("claude-haiku-4-5", 100_000, 10_000));
});

test("the column mapping sits under the practice's document-reading switch", () => {
  assert.equal(aiSwitchFor("import-mapping"), "autoParseDocuments");
  assert.equal(aiSwitchFor("import-cleanup"), "autoParseDocuments");
});
