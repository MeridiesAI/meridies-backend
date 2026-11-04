// What AxIS records about each model call for the ai_runs audit row: billed calls (helpers
// included), cache writes by lifetime (5 minutes vs 1 hour bill differently), and the calls past
// Haiku 5.5's lower rate card with their own tokens (billed at 5x). scripts/axis/axis-cost-report.sql
// prices from these fields.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, emptyUsage, runLoop, type LoopOptions } from "../../src/lib/axis/loop.js";
import { usageColumns } from "../../src/lib/axis/llm.js";
import { runSpecialists } from "../../src/lib/axis/specialists.js";
import { scriptedApi } from "./axis-fakes.js";

const base: LoopOptions["base"] = {
  model: "claude-haiku-5-5",
  system: [{ type: "text", text: "system" }],
  tools: [],
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
};

const loopOptions = (api: LoopOptions["api"], over: Partial<LoopOptions> = {}): LoopOptions => ({
  api,
  base,
  messages: [{ role: "user", content: "question" }],
  effort: "low",
  maxCalls: 6,
  deadline: Date.now() + 10_000,
  signal: new AbortController().signal,
  exec: async () => ({ content: "result", fresh: true }),
  readOnly: () => true,
  ...over,
});

test("usage counts the calls that were billed, not the loop's call budget", async () => {
  // The thinking-only answer makes the loop ask once more for text, which moves its budget
  // counter to the last call; three messages came back, so three calls were billed.
  const { api } = scriptedApi([{ tools: [{ id: "a", name: "list_upcoming", input: {} }] }, { thinkingOnly: true }, { text: "Done." }]);
  const res = await runLoop(loopOptions(api));
  assert.equal(res.calls, 6, "the budget counter jumped");
  assert.equal(res.usage.calls, 3);
});

test("cache writes keep their 5-minute and 1-hour split; a message without the split adds to the total only", async () => {
  const { api } = scriptedApi([
    {
      tools: [{ id: "a", name: "list_upcoming", input: {} }],
      usage: { cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 } },
    },
    { text: "Done.", usage: { cache_creation_input_tokens: 40, cache_creation: null } },
  ]);
  const res = await runLoop(loopOptions(api));
  assert.equal(res.usage.cacheWrite, 540);
  assert.equal(res.usage.cacheWrite5m, 200);
  assert.equal(res.usage.cacheWrite1h, 300);
});

test("a call whose prompt passes 100K tokens keeps its tokens apart: Haiku 5.5 bills all of it at the higher rate", async () => {
  const { api } = scriptedApi([
    { tools: [{ id: "a", name: "list_upcoming", input: {} }], usage: { input_tokens: 1_000, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 0 } },
    {
      text: "Done.",
      usage: {
        input_tokens: 2_000, output_tokens: 70, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
      },
    },
  ]);
  const res = await runLoop(loopOptions(api));
  // 100,000 exactly is the lower rate; 101,500 is not.
  assert.deepEqual(res.usage.longPrompt, { input: 2_000, output: 70, cacheRead: 99_000, cacheWrite: 500, cacheWrite5m: 500, cacheWrite1h: 0, calls: 1 });
  assert.equal(res.usage.input, 3_000, "the totals still count both calls");
  assert.equal(res.usage.calls, 2);
});

test("specialists' calls are part of the usage they hand back", async () => {
  const { api } = scriptedApi([{ text: "- GPA 3.9 [S1]" }]);
  const res = await runSpecialists({
    tasks: [
      { clause: "her GPA", intent: "record" },
      { clause: "his deadlines", intent: "roster" },
    ],
    question: "her GPA and his deadlines",
    api,
    base,
    evidence: "",
    effort: "low",
    signal: new AbortController().signal,
    exec: async () => ({ content: "result", fresh: true }),
    readOnly: () => true,
    beforeCall: async () => undefined,
    onStep: () => undefined,
  });
  assert.equal(res.usage.calls, 2);
});

test("addUsage sums every field, the long-prompt tokens too", () => {
  const counts = (n: number, calls: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n, cacheWrite5m: n, cacheWrite1h: n, calls });
  const total = emptyUsage();
  addUsage(total, { ...counts(1, 1), longPrompt: counts(0, 0) });
  addUsage(total, { ...counts(10, 2), longPrompt: counts(7, 1) });
  assert.deepEqual(total, { ...counts(11, 3), longPrompt: counts(7, 1) });
});

test("the audit row stores the split, the billed calls and the long-prompt calls' tokens", () => {
  const cols = usageColumns({
    input: 10, output: 20, cacheRead: 300, cacheWrite: 50, cacheWrite5m: 20, cacheWrite1h: 30, calls: 4,
    longPrompt: { input: 5, output: 6, cacheRead: 200, cacheWrite: 30, cacheWrite5m: 10, cacheWrite1h: 20, calls: 1 },
  });
  assert.deepEqual(cols, {
    input_tokens: 360,
    output_tokens: 20,
    output: {
      cacheReadTokens: 300, cacheWriteTokens: 50, cacheWrite5mTokens: 20, cacheWrite1hTokens: 30, modelCalls: 4,
      // inputTokens counts cached tokens too, like the row's input_tokens.
      longPrompt: { calls: 1, inputTokens: 235, outputTokens: 6, cacheReadTokens: 200, cacheWriteTokens: 30, cacheWrite5mTokens: 10, cacheWrite1hTokens: 20 },
    },
  });
});
