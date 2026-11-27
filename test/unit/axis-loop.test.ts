import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { Hold } from "../../src/lib/aiBudget.js";
import { degrade, runLoop, STALE_ROUNDS, type CallGate, type LoopOptions, type MessagesApi, type StreamLike } from "../../src/lib/axis/loop.js";
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

test("filler text in a round that ends in tool calls is held back; the steps still show (P2-6)", async () => {
  const { api } = scriptedApi([{ text: "Let me check her deadlines.", tools: [{ id: "x", name: "list_upcoming", input: {} }] }, { text: "Two items are due." }]);
  const deltas: string[] = [];
  const steps: string[] = [];
  const res = await runLoop(options(api, { onText: (d) => deltas.push(d), onToolStart: (c) => steps.push(`start:${c.name}`), onToolEnd: (c) => steps.push(`end:${c.name}`) }));
  assert.equal(res.text, "Two items are due.");
  assert.equal(deltas.join(""), "Two items are due.");
  assert.deepEqual(steps, ["start:list_upcoming", "end:list_upcoming"]);
});

test("a long answer in a round that could still call tools streams live, before the message ends (P2-6)", async () => {
  const timeline: string[] = [];
  const answer = "Her GPA is 3.87 unweighted and 4.31 weighted, which puts her in the middle fifty percent for most of her list. Her SAT is 1490.";
  const { api } = timed([{ text: answer, tailMs: 20 }], timeline);
  const res = await runLoop(options(api, { onText: (d) => timeline.push(`text:${d}`) }));
  assert.equal(res.text, answer);
  assert.ok(timeline.indexOf("final") > timeline.findIndex((x) => x.startsWith("text:")), "text went out before the message ended");
  assert.equal(timeline.filter((x) => x.startsWith("text:")).map((x) => x.slice(5)).join(""), answer);
});

test("a short answer is held only until its round ends, then shown whole (P2-6)", async () => {
  const deltas: string[] = [];
  const { api } = scriptedApi([{ text: "Her GPA is 3.87." }]);
  const res = await runLoop(options(api, { onText: (d) => deltas.push(d) }));
  assert.equal(res.text, "Her GPA is 3.87.");
  assert.equal(deltas.join(""), "Her GPA is 3.87.");
});

test("the round that must answer streams live from the first word (P2-6)", async () => {
  const timeline: string[] = [];
  const { api } = timed([{ text: "Short.", tailMs: 20 }], timeline);
  await runLoop(options(api, { maxCalls: 1, onText: (d) => timeline.push(`text:${d}`) }));
  assert.ok(timeline.indexOf("final") > timeline.findIndex((x) => x.startsWith("text:")));
});

test("a long preamble already shown before a tool round is kept apart from the answer after it", async () => {
  const preamble = "Before I answer, here is what I know so far from her record and what I still need to confirm.\n";
  const { api } = scriptedApi([{ text: preamble, tools: [{ id: "x", name: "list_upcoming", input: {} }] }, { text: "Two items are due." }]);
  const res = await runLoop(options(api));
  assert.equal(res.text, `${preamble}\n\nTwo items are due.`);
});

test("a read-only tool still running at the deadline is cut off, and the next call answers (P2-5)", async () => {
  const { api, calls } = scriptedApi([{ tools: [{ id: "slow", name: "search_documents", input: { query: "q" } }, { id: "fast", name: "list_upcoming", input: {} }] }, { text: "Answer." }]);
  let aborted = false;
  const exec = (c: { id: string }, signal: AbortSignal): Promise<ToolOutput> =>
    c.id === "fast"
      ? Promise.resolve({ content: "fast result", fresh: true })
      : new Promise((resolve) => signal.addEventListener("abort", () => ((aborted = true), resolve({ content: "late", fresh: true }))));
  const started = Date.now();
  const res = await runLoop(options(api, { exec, deadline: Date.now() + 400 }));
  assert.ok(Date.now() - started < 5_000, "didn't wait for the slow tool");
  assert.equal(aborted, true, "the slow lookup was told to stop");
  const results = calls[1]!.params.messages.at(-1)!.content as { tool_use_id: string; content: string; is_error?: boolean }[];
  assert.equal(results.find((r) => r.tool_use_id === "fast")!.content, "fast result");
  const slow = results.find((r) => r.tool_use_id === "slow")!;
  assert.match(slow.content, /ran out of time/);
  assert.equal(slow.is_error, true);
  assert.deepEqual(calls[1]!.params.tool_choice, { type: "none" }, "past the deadline the next call must answer");
  assert.equal(res.text, "Answer.");
});

test("a write in flight at the deadline is waited for, never cut off (P2-5)", async () => {
  const { api, calls } = scriptedApi([{ tools: [{ id: "w", name: "propose_action", input: {} }] }, { text: "Filed." }]);
  let aborted = false;
  const exec = (_c: unknown, signal: AbortSignal): Promise<ToolOutput> => {
    signal.addEventListener("abort", () => (aborted = true));
    return new Promise((resolve) => setTimeout(() => resolve({ content: "Filed for the counselor's confirmation.", fresh: true }), 300));
  };
  await runLoop(options(api, { exec, deadline: Date.now() + 100 }));
  assert.equal(aborted, false);
  const results = calls[1]!.params.messages.at(-1)!.content as { content: string }[];
  assert.equal(results[0]!.content, "Filed for the counselor's confirmation.");
});

test("degrade folds the mode into the user turn and drops effort-only messages", () => {
  const m: LoopOptions["messages"] = [effortMessage("medium"), { role: "user", content: "q" }, modeMessage("Mode: email.")];
  const d = degrade(m);
  assert.deepEqual(d, { changed: true, usedPerMessageEffort: true, usedSystemMessages: true });
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], { role: "user", content: [{ type: "text", text: "q" }, { type: "text", text: "(AxIS operator note: Mode: email.)" }] });
});

/** A gate that records what the loop asked of it; each hold is a plain marker object. */
function recordingGate() {
  const seen: { before: { max_tokens: number }[]; after: { hold: unknown; usage: unknown }[] } = { before: [], after: [] };
  let n = 0;
  const gate: CallGate = {
    before: async (params) => (seen.before.push({ max_tokens: params.max_tokens }), { id: ++n } as unknown as Hold),
    after: async (hold, usage) => void seen.after.push({ hold, usage }),
  };
  return { gate, seen };
}

test("the gate wraps every model call with that call's usage", async () => {
  const { gate, seen } = recordingGate();
  const { api } = scriptedApi([{ tools: [{ id: "x", name: "list_upcoming", input: {} }] }, { text: "ok" }]);
  await runLoop(options(api, { gate }));
  assert.equal(seen.before.length, 2, "reserved before each call");
  assert.equal(seen.before[0]!.max_tokens, MAX_TOKENS.low);
  // What settle prices: one call's tokens (the usage also carries #85's cache split and long-prompt part).
  const priced = (u: unknown) => {
    const { input, output, cacheRead, cacheWrite, calls } = u as Record<string, number>;
    return { input, output, cacheRead, cacheWrite, calls };
  };
  assert.deepEqual(
    seen.after.map((a) => [(a.hold as { id: number }).id, priced(a.usage)]),
    [1, 2].map((id) => [id, { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, calls: 1 }]),
    "each call settled with its own usage"
  );
});

test("an aborted stream settles with null and doesn't throw from the gate", async () => {
  const { gate, seen } = recordingGate();
  const ctl = new AbortController();
  const abortErr = new Anthropic.APIUserAbortError();
  const api: MessagesApi = {
    stream() {
      ctl.abort();
      const s = { on: () => s, finalMessage: () => Promise.reject(abortErr) } as unknown as StreamLike;
      return s;
    },
  };
  await assert.rejects(runLoop(options(api, { gate, signal: ctl.signal })), (e) => e === abortErr);
  assert.equal(seen.after.length, 1);
  assert.equal(seen.after[0]!.usage, null, "kept whole: the call may have been billed");
});

test("a request the API refused before answering releases its reservation", async () => {
  const { gate, seen } = recordingGate();
  const bad = new Anthropic.BadRequestError(400, undefined, "bad", new Headers());
  const api: MessagesApi = {
    stream() {
      const s = { on: () => s, finalMessage: () => Promise.reject(bad) } as unknown as StreamLike;
      return s;
    },
  };
  await assert.rejects(runLoop(options(api, { gate, messages: [{ role: "user", content: "q" }] })));
  assert.ok(seen.after.length >= 1);
  assert.ok(seen.after.every((a) => a.usage === "unused"), JSON.stringify(seen.after.map((a) => a.usage)));
});
