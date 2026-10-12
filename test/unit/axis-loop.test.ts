import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { degrade, runLoop, STALE_ROUNDS, type LoopOptions, type MessagesApi, type StreamLike } from "../../src/lib/axis/loop.js";
import { effortMessage, featureOn, MAX_TOKENS, modeMessage, resetFeatures } from "../../src/lib/axis/models.js";
import type { ToolOutput } from "../../src/lib/axis/tools.js";
import { scriptedApi, type Turn } from "./axis-fakes.js";

const base: LoopOptions["base"] = {
  model: "claude-haiku-5-5",
  system: [{ type: "text", text: "system" }],
  tools: [],
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
};

function options(api: MessagesApi, over: Partial<LoopOptions> = {}): LoopOptions {
  return {
    api,
    base,
    messages: [{ role: "user", content: "question" }],
    effort: "low",
    maxCalls: 5,
    deadline: Date.now() + 10_000,
    signal: new AbortController().signal,
    exec: async () => ({ content: "result", fresh: true }),
    readOnly: (name) => name !== "propose_action",
    ...over,
  };
}

/** Wraps a scripted API so the test sees when each message finished. */
function timed(turns: Turn[], timeline: string[]) {
  const { api, calls } = scriptedApi(turns);
  const wrapped: MessagesApi = {
    stream(params, opts) {
      const s = api.stream(params, opts);
      const final = s.finalMessage();
      final.then(() => timeline.push("final"), () => undefined);
      return { on: (ev: never, cb: never) => s.on(ev, cb), finalMessage: () => final } as unknown as StreamLike;
    },
  };
  return { api: wrapped, calls };
}

test("a plain answer streams, makes one call and asks for room to think", async () => {
  const { api, calls } = scriptedApi([{ text: "Her GPA is 3.87." }]);
  const deltas: string[] = [];
  const res = await runLoop(options(api, { onText: (d) => deltas.push(d) }));
  assert.equal(res.text, "Her GPA is 3.87.");
  assert.equal(deltas.join(""), "Her GPA is 3.87.");
  assert.equal(res.calls, 1);
  assert.equal(res.stop, "end_turn");
  assert.equal(calls[0]!.params.max_tokens, MAX_TOKENS.low);
  assert.deepEqual(calls[0]!.params.tool_choice, { type: "auto" });
  assert.equal(calls[0]!.params.output_config?.effort, "high", "top-level effort stays pinned");
});

test("read-only lookups start before the model's turn is finished, and all results go back in one message", async () => {
  const timeline: string[] = [];
  const { api, calls } = timed(
    [
      { tools: [{ id: "a", name: "search_documents", input: { query: "AP Bio" } }, { id: "b", name: "list_upcoming", input: {} }], tailMs: 30 },
      { text: "Done." },
    ],
    timeline
  );
  const exec = async (c: { id: string }): Promise<ToolOutput> => {
    timeline.push(`exec:${c.id}`);
    return { content: `out-${c.id}`, fresh: true };
  };
  const res = await runLoop(options(api, { exec }));
  assert.deepEqual(timeline.slice(0, 3), ["exec:a", "exec:b", "final"]);
  const second = calls[1]!.params.messages;
  const results = second.at(-1)!;
  assert.equal(results.role, "user");
  assert.ok(Array.isArray(results.content));
  assert.deepEqual(
    (results.content as { type: string; tool_use_id: string; content: string }[]).map((b) => [b.type, b.tool_use_id, b.content]),
    [["tool_result", "a", "out-a"], ["tool_result", "b", "out-b"]]
  );
  assert.equal(res.tools.length, 2);
});

test("a write is never started early", async () => {
  const timeline: string[] = [];
  const { api } = timed([{ tools: [{ id: "w", name: "propose_action", input: { type: "work_item", title: "Call" } }], tailMs: 20 }, { text: "Waiting for you." }], timeline);
  await runLoop(options(api, { exec: async (c) => (timeline.push(`exec:${c.id}`), { content: "ok", fresh: true }) }));
  assert.deepEqual(timeline.slice(0, 2), ["final", "exec:w"]);
});

test("rounds that bring nothing new end the tool phase", async () => {
  const empty = { tools: [{ id: "x", name: "search_documents", input: { query: "q" } }] };
  const { api, calls } = scriptedApi([empty, { ...empty, tools: [{ id: "y", name: "search_documents", input: { query: "r" } }] }, { text: "I couldn't find it." }]);
  const res = await runLoop(options(api, { exec: async () => ({ content: "No matching passages.", fresh: false }) }));
  assert.equal(STALE_ROUNDS, 2);
  assert.deepEqual(calls[2]!.params.tool_choice, { type: "none" });
  assert.equal(res.text, "I couldn't find it.");
});

test("the last allowed call must answer", async () => {
  const { api, calls } = scriptedApi([{ tools: [{ id: "x", name: "list_upcoming", input: {} }] }, { text: "Answer." }]);
  await runLoop(options(api, { maxCalls: 2 }));
  assert.deepEqual(calls[1]!.params.tool_choice, { type: "none" });
});

test("a refused turn runs none of its tools and says so", async () => {
  let ran = 0;
  const { api } = scriptedApi([{ tools: [{ id: "x", name: "propose_action", input: {} }], stop: "refusal" }]);
  const res = await runLoop(options(api, { exec: async () => (ran++, { content: "ok", fresh: true }) }));
  assert.equal(ran, 0);
  assert.equal(res.stop, "refusal");
  assert.equal(res.refusalCategory, "general_harms");
  assert.match(res.text, /can't help/);
});

test("when the API rejects the per-message features, the call is retried once without them", async () => {
  resetFeatures();
  const bad = new Anthropic.BadRequestError(400, { type: "error" }, "output_config.effort requires a model that supports per-turn effort", new Headers());
  const { api, calls } = scriptedApi([{ fail: bad }, { text: "Answer." }]);
  const messages: LoopOptions["messages"] = [effortMessage("low"), { role: "user", content: "question" }, modeMessage("Mode: record.")];
  const res = await runLoop(options(api, { messages }));
  assert.equal(res.text, "Answer.");
  const retried = calls[1]!.params;
  assert.ok(retried.messages.every((m) => m.role !== "system"));
  assert.match(JSON.stringify(retried.messages), /AxIS operator note: Mode: record\./);
  assert.equal(retried.output_config?.effort, "low", "the turn's effort moves to the top level");
  assert.equal(featureOn("perMessageEffort"), false);
  assert.equal(featureOn("systemMessages"), false);
  resetFeatures();
});

test("a tool input that isn't JSON is asked for again", async () => {
  const { api, calls } = scriptedApi([{ fail: new SyntaxError("Unexpected end of JSON input") }, { text: "Answer." }]);
  const res = await runLoop(options(api));
  assert.equal(calls.length, 2);
  assert.equal(res.calls, 1);
  assert.equal(res.text, "Answer.");
});

test("a turn that ends in thinking only is asked once for the answer, appending rather than editing", async () => {
  const { api, calls } = scriptedApi([{ thinkingOnly: true }, { text: "Answer." }]);
  const res = await runLoop(options(api));
  assert.equal(res.text, "Answer.");
  const msgs = calls[1]!.params.messages;
  assert.equal(msgs[0]!.content, "question", "the history before the thinking block is unchanged");
  assert.equal(msgs.at(-2)!.role, "assistant");
  assert.deepEqual(msgs.at(-1), { role: "user", content: "Please write your answer to my question now." });
  assert.deepEqual(calls[1]!.params.tool_choice, { type: "none" });
});

test("text written before a tool round is kept apart from the answer after it", async () => {
  const { api } = scriptedApi([{ text: "Checking.", tools: [{ id: "x", name: "list_upcoming", input: {} }] }, { text: "Two items are due." }]);
  const res = await runLoop(options(api));
  assert.equal(res.text, "Checking.\n\nTwo items are due.");
});

test("degrade folds the mode into the user turn and drops effort-only messages", () => {
  const m: LoopOptions["messages"] = [effortMessage("medium"), { role: "user", content: "q" }, modeMessage("Mode: email.")];
  const d = degrade(m);
  assert.deepEqual(d, { changed: true, usedPerMessageEffort: true, usedSystemMessages: true });
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], { role: "user", content: [{ type: "text", text: "q" }, { type: "text", text: "(AxIS operator note: Mode: email.)" }] });
});

test("every call is charged against the quota before it is made", async () => {
  let charged = 0;
  const { api } = scriptedApi([{ tools: [{ id: "x", name: "list_upcoming", input: {} }] }, { text: "ok" }]);
  await runLoop(options(api, { beforeCall: async () => void charged++ }));
  assert.equal(charged, 2);
});
