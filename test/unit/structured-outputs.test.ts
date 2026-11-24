// DEEP_MODEL on Claude Sonnet 5.5 (retiring claude-sonnet-4-5, 2026-11-30). Sonnet 5.5 answers a forced tool_choice
// with a 400 and thinks on every request, so a structured call to it uses structured outputs (output_config.format)
// with adaptive thinking at low effort and room for that thinking, while FAST_MODEL (Haiku 4.5) keeps the forced
// tool and sends no thinking or effort. Pure parts first; then the wrapper end to end against a stand-in Messages
// API and a stand-in PostgREST on this machine (ANTHROPIC_BASE_URL), as in system-structured.test.ts.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";

type Seen = { method: string; path: string; body: unknown };
const seen: Seen[] = [];
/** What the stand-in Messages API answers next: a JSON body, or an SSE stream for messages.stream. */
let nextMessage: Record<string, unknown> | null = null;
let nextStream: string | null = null;

const server = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    seen.push({ method: req.method ?? "", path: req.url ?? "", body });
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      if ((body as { stream?: boolean })?.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(nextStream ?? "");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(nextMessage));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url?.startsWith("/rest/v1/ai_runs")) {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "00000000-0000-4000-8000-0000000000a2" }));
      return;
    }
    res.statusCode = 200;
    res.end("[]");
  });
});

let mod: typeof import("../../src/lib/anthropic.js");
let budget: typeof import("../../src/lib/aiBudget.js");
const log = { warn: () => undefined, error: () => undefined };

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Before env.ts is first read: PostgREST and the Messages API are both the stand-in.
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-service-role-key-000000";
  process.env.ANTHROPIC_API_KEY = "sk-ant-stand-in-000000000000";
  process.env.ANTHROPIC_BASE_URL = base;
  mod = await import("../../src/lib/anthropic.js");
  budget = await import("../../src/lib/aiBudget.js");
});
after(() => server.close());
afterEach(() => {
  budget.setBudgetBackend(null);
  seen.length = 0;
  nextMessage = null;
  nextStream = null;
});

const PRICES = [
  { model: "claude-haiku-4-5", input_usd: 1, output_usd: 5, read_mult: 0.1, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 },
  { model: "claude-sonnet-5-5", input_usd: 2, output_usd: 10, read_mult: 0.05, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 },
];
const reserved: number[] = [];
function backend() {
  reserved.length = 0;
  budget.setBudgetBackend({
    probe: async () => undefined,
    prices: async () => PRICES,
    reserve: async (lines) => (reserved.push(lines.length), { ok: true, totals: {} }),
    settle: async () => undefined,
    total: async () => 0,
  });
}

const SCHEMA = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: { severity: { type: "string", enum: ["high", "low"] }, what: { type: "string", maxLength: 240 } },
        required: ["severity", "what"],
      },
    },
  },
  required: ["flags"],
};
const call = (model: string, maxTokens = 3000) =>
  mod.runSystemStructured<{ flags: { severity: string; what: string }[] }>({
    job: "college-features",
    module: "college-features",
    model,
    system: "s",
    prompt: "p",
    schema: SCHEMA,
    toolName: "flags_out",
    maxTokens,
    log,
  });
const message = (content: unknown[], stop_reason: string) => ({
  id: "msg_stand_in",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 40 },
});
const sentToModel = () => seen.find((s) => s.method === "POST" && s.path.startsWith("/v1/messages"))?.body as Record<string, unknown>;
const finishes = () =>
  seen.filter((s) => s.method === "PATCH" && s.path.startsWith("/rest/v1/ai_runs")).map((s) => (s.body as { status: string; error?: string }));

// ---- Which models get which request -------------------------------------------------------------------

test("DEEP_MODEL is Claude Sonnet 5.5, and only the models that refuse a forced tool take the new request", () => {
  assert.equal(mod.DEEP_MODEL, "claude-sonnet-5-5");
  for (const m of ["claude-sonnet-5-5", "claude-opus-5-5"]) assert.ok(mod.refusesForcedTool(m), m);
  // Whole IDs only: Haiku 4.5 and 5.5, Sonnet 5 and the retiring Sonnet 4.5 accept a forced tool.
  for (const m of [mod.FAST_MODEL, "claude-haiku-5-5", "claude-sonnet-5", "claude-sonnet-4-5", "claude-opus-5", "claude-sonnet-5-5-fast", ""]) {
    assert.ok(!mod.refusesForcedTool(m), m);
  }
});

test("FAST_MODEL's request is the forced tool, unchanged: no thinking, no effort, its own max_tokens", () => {
  const r = mod.structuredRequest({ model: mod.FAST_MODEL, maxTokens: 800, system: "s", content: "p", schema: SCHEMA, toolName: "flags_out" });
  assert.deepEqual(r, {
    model: "claude-haiku-4-5",
    max_tokens: 800,
    system: "s",
    messages: [{ role: "user", content: "p" }],
    tools: [{ name: "flags_out", description: "Return the result in this exact structure.", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "flags_out" },
  });
});

test("DEEP_MODEL's request is structured outputs with adaptive thinking at low effort and room for the thinking", () => {
  const r = mod.structuredRequest({ model: mod.DEEP_MODEL, maxTokens: 3000, system: "s", content: "p", schema: SCHEMA, toolName: "flags_out" });
  assert.equal(r.tool_choice, undefined);
  assert.equal(r.tools, undefined);
  assert.deepEqual(r.thinking, { type: "adaptive" });
  assert.equal(r.output_config?.effort, "low");
  assert.equal(r.output_config?.format?.type, "json_schema");
  assert.deepEqual(r.output_config?.format?.schema, mod.outputSchema(SCHEMA));
  assert.equal(r.max_tokens, mod.withThinkingRoom(3000));
  assert.equal(mod.withThinkingRoom(3000), 5900);
  assert.ok(mod.withThinkingRoom(512) > 512 * 1.3 + 1000, "a short cap still leaves room to think");
});

test("a call's own effort reaches Sonnet 5.5, with more thinking room, and never Haiku 4.5", () => {
  const base = { maxTokens: 4000, system: "s", content: "p", schema: SCHEMA, toolName: "flags_out", effort: "high" as const };
  const sonnet = mod.structuredRequest({ ...base, model: mod.DEEP_MODEL });
  assert.equal(sonnet.output_config?.effort, "high");
  assert.equal(sonnet.max_tokens, mod.withThinkingRoom(4000, "high"));
  assert.ok(mod.withThinkingRoom(4000, "high") > mod.withThinkingRoom(4000, "low"), "high effort gets more room to think");
  assert.ok(mod.withThinkingRoom(4000, "high") >= 5_300 * 1.5, "well past the most a high-effort recommender used");
  const haiku = mod.structuredRequest({ ...base, model: mod.FAST_MODEL });
  assert.equal(haiku.output_config, undefined, "Haiku 4.5 takes no effort");
  assert.equal(haiku.thinking, undefined);
  assert.equal(haiku.max_tokens, 4000);
});

test("the two program recommenders ask for high effort and a six-to-eight list; nothing else asks for more", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
  for (const f of ["routes/ai.ts", "routes/applicationAi.ts"]) {
    assert.equal((read(f).match(/effort: "high"/g) ?? []).length, 1, `${f}: one high-effort call`);
  }
  assert.match(read("routes/ai.ts"), /Aim for six to eight\./);
  assert.match(read("lib/studentToolPrompts.ts"), /Aim for six to eight\./);
  assert.doesNotMatch(read("lib/chat.ts") + read("lib/translate.ts"), /effort:/, "chat and translation stay at the low default");
});

// ---- The schema as structured outputs takes it --------------------------------------------------------

test("outputSchema keeps enums and required, closes every object, and turns unsupported bounds into hints", () => {
  const input = {
    type: "object",
    description: "Axes.",
    properties: {
      axes: {
        type: "array",
        maxItems: 6,
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            key: { type: "string", enum: ["a", "b"] },
            score: { type: ["integer", "null"], minimum: 0, maximum: 100 },
            why: { type: "string", maxLength: 240, description: "One line." },
            when: { type: "string", format: "date" },
            site: { type: "string", format: "hostname-ish" },
            tags: { type: "array", minItems: 2, items: { type: "string" } },
            either: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["key", "score", "why"],
        },
      },
    },
    required: ["axes"],
  };
  const before = JSON.stringify(input);
  const out = mod.outputSchema(input) as Record<string, any>;
  assert.equal(JSON.stringify(input), before, "the input is not changed");
  assert.equal(out.additionalProperties, false);
  assert.equal(out.description, "Axes.");
  const axes = out.properties.axes;
  assert.equal(axes.minItems, 1, "minItems 1 is a real constraint");
  assert.equal(axes.maxItems, undefined);
  assert.equal(axes.description, "{maxItems: 6}");
  const item = axes.items;
  assert.equal(item.additionalProperties, false, "a nested object is closed, even one that said true");
  assert.deepEqual(item.required, ["key", "score", "why"]);
  assert.deepEqual(item.properties.key, { type: "string", enum: ["a", "b"] }, "enum is kept as a constraint");
  assert.deepEqual(item.properties.score, { type: ["integer", "null"], description: "{minimum: 0, maximum: 100}" });
  assert.deepEqual(item.properties.why, { type: "string", description: "One line.\n\n{maxLength: 240}" });
  assert.deepEqual(item.properties.when, { type: "string", format: "date" });
  assert.deepEqual(item.properties.site, { type: "string", description: '{format: "hostname-ish"}' });
  assert.deepEqual(item.properties.tags, { type: "array", items: { type: "string" }, description: "{minItems: 2}" });
  assert.deepEqual(item.properties.either, { anyOf: [{ type: "string" }, { type: "null" }] });
});

test("every schema a DEEP_MODEL feature sends comes out with no unsupported keyword and every object closed", async () => {
  const { TRANSLATE_SCHEMA } = await import("../../src/lib/translate.js");
  const { REASONING_SCHEMA } = await import("../../src/lib/chat.js");
  const { polygonEstimateSchema } = await import("../../src/lib/polygonEstimate.js");
  const { EXTRACTION_SCHEMA } = await import("../../src/lib/ingest/collegeFeatures.js");
  const unsupported = ["minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "uniqueItems", "oneOf"];
  const walk = (node: unknown, path: string, enums: string[]) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`, enums));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const k of unsupported) assert.ok(!(k in o), `${path}: ${k} left in`);
    if (o.type === "object" || "properties" in o) assert.equal(o.additionalProperties, false, `${path} is not closed`);
    if (typeof o.minItems === "number") assert.ok(o.minItems <= 1, `${path}: minItems ${o.minItems}`);
    if (Array.isArray(o.enum)) enums.push(path);
    for (const [k, v] of Object.entries(o)) if (k !== "enum" && k !== "required") walk(v, `${path}.${k}`, enums);
  };
  const cases: [string, unknown, number][] = [
    ["translate", TRANSLATE_SCHEMA, 0],
    ["chat plan", REASONING_SCHEMA, 0],
    ["polygon", polygonEstimateSchema(["academics", "leadership"]), 1],
    ["college features", EXTRACTION_SCHEMA, 1],
  ];
  for (const [name, schema, minEnums] of cases) {
    const enums: string[] = [];
    walk(mod.outputSchema(schema), name, enums);
    assert.ok(enums.length >= minEnums, `${name}: enums kept (${enums.join(", ")})`);
  }
});

// ---- Reading the answer ---------------------------------------------------------------------------------

test("structuredValue reads the forced tool's input or the JSON text, by block type", () => {
  assert.deepEqual(mod.structuredValue({ content: [{ type: "tool_use", input: { a: 1 } } as { type: string }] }), { a: 1 });
  assert.deepEqual(
    mod.structuredValue({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a": [1, 2]}' }] as { type: string }[] }),
    { a: [1, 2] },
    "a thinking block may come first"
  );
  assert.deepEqual(mod.structuredValue({ content: [{ type: "text", text: '{"a": ' }, { type: "text", text: "3}" }] as { type: string }[] }), { a: 3 });
  assert.equal(mod.structuredValue({ content: [{ type: "text", text: '{"flags": [{"severity": "hi' }] as { type: string }[] }), undefined, "cut off");
  assert.equal(mod.structuredValue({ content: [] }), undefined);
});

test("the college-features batch entry follows the model: forced tool on Haiku 4.5, structured outputs on Sonnet 5.5", async () => {
  const cf = await import("../../src/lib/ingest/collegeFeatures.js");
  const shown = cf.shownPages([{ url: "https://example.edu/a", text: "Robotics lab." }]);
  const haiku = cf.toBatchRequest(cf.buildExtractionRequest({ id: "11111111-1111-4111-8111-111111111111", name: "Example" }, shown, mod.FAST_MODEL));
  assert.deepEqual(haiku.params.tool_choice, { type: "tool", name: haiku.params.tools?.[0]?.name });
  assert.equal(haiku.params.thinking, undefined);
  const sonnet = cf.toBatchRequest(cf.buildExtractionRequest({ id: "11111111-1111-4111-8111-111111111111", name: "Example" }, shown, mod.DEEP_MODEL));
  assert.equal(sonnet.params.tool_choice, undefined);
  assert.equal(sonnet.params.output_config?.format?.type, "json_schema");
  assert.deepEqual(sonnet.params.thinking, { type: "adaptive" });
});

// ---- The wrapper, end to end ----------------------------------------------------------------------------

test("a Sonnet 5.5 structured call sends structured outputs and returns the parsed JSON", async () => {
  backend();
  nextMessage = message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: '{"flags":[{"severity":"high","what":"x"}]}' }], "end_turn");
  const out = await call(mod.DEEP_MODEL);
  assert.deepEqual(out, { flags: [{ severity: "high", what: "x" }] });
  const sent = sentToModel();
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.equal(sent.tool_choice, undefined, "no forced tool: Sonnet 5.5 answers that with a 400");
  assert.equal(sent.tools, undefined);
  assert.deepEqual(sent.thinking, { type: "adaptive" });
  assert.deepEqual((sent.output_config as { effort: string }).effort, "low");
  assert.equal(sent.max_tokens, 5900);
  assert.equal(reserved.length, 1, "one reservation for the one call");
  assert.deepEqual(finishes().map((f) => f.status), ["succeeded"]);
});

test("a refusal is a 422 the counselor can read, audited as blocked (not overwritten as failed)", async () => {
  backend();
  nextMessage = message([], "refusal");
  await assert.rejects(call(mod.DEEP_MODEL), (e: Error & { statusCode?: number; code?: string }) => e.statusCode === 422 && e.code === "ai_declined" && /declined/.test(e.message));
  assert.deepEqual(finishes().map((f) => [f.status, f.error]), [["blocked", "refusal"]]);
});

test("an answer cut off at max_tokens is a 503 to try again, audited with why", async () => {
  backend();
  nextMessage = message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: '{"flags":[{"severity":"hi' }], "max_tokens");
  await assert.rejects(call(mod.DEEP_MODEL), (e: Error & { statusCode?: number }) => e.statusCode === 503);
  assert.deepEqual(finishes().map((f) => [f.status, f.error]), [["failed", "model ran out of output tokens"]]);
});

test("a Haiku 4.5 structured call still forces the tool and reads its input", async () => {
  backend();
  nextMessage = message([{ type: "tool_use", id: "toolu_1", name: "flags_out", input: { flags: [] } }], "tool_use");
  assert.deepEqual(await call(mod.FAST_MODEL, 900), { flags: [] });
  const sent = sentToModel();
  assert.deepEqual(sent.tool_choice, { type: "tool", name: "flags_out" });
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.output_config, undefined);
  assert.equal(sent.max_tokens, 900);
});

// ---- The chat stream ------------------------------------------------------------------------------------

const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const streamOf = (text: string, stop_reason: string) =>
  sse([
    { type: "message_start", message: { ...message([], "end_turn"), stop_reason: null, usage: { input_tokens: 50, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ]);
const fakeRequest = { auth: { userId: "22222222-2222-4222-8222-222222222222" }, log } as unknown as Parameters<typeof mod.streamChat>[0]["request"];

test("chat on Sonnet 5.5 thinks at low effort with room, and streams only the text", async () => {
  backend();
  nextStream = streamOf("Two flags.", "end_turn");
  const deltas: string[] = [];
  const out = await mod.streamChat({ request: fakeRequest, system: "s", messages: [{ role: "user", content: "hi" }], model: mod.DEEP_MODEL, maxTokens: 1400, onDelta: (t) => deltas.push(t) });
  assert.equal(out.text, "Two flags.");
  assert.deepEqual(deltas, ["Two flags."]);
  const sent = sentToModel();
  assert.deepEqual(sent.thinking, { type: "adaptive" });
  assert.deepEqual(sent.output_config, { effort: "low" });
  assert.equal(sent.max_tokens, mod.withThinkingRoom(1400));
});

test("chat that the model declines part-way is a 422, not a saved answer", async () => {
  backend();
  nextStream = streamOf("I can", "refusal");
  await assert.rejects(
    mod.streamChat({ request: fakeRequest, system: "s", messages: [{ role: "user", content: "hi" }], model: mod.DEEP_MODEL, onDelta: () => undefined }),
    (e: Error & { statusCode?: number; code?: string }) => e.statusCode === 422 && e.code === "ai_declined"
  );
  assert.deepEqual(finishes().map((f) => f.status), ["blocked"]);
});

test("chat on Haiku 4.5 sends no thinking and no effort, with its own max_tokens", async () => {
  backend();
  nextStream = streamOf("Hi.", "end_turn");
  await mod.streamChat({ request: fakeRequest, system: "s", messages: [{ role: "user", content: "hi" }], model: mod.FAST_MODEL, maxTokens: 1400, onDelta: () => undefined });
  const sent = sentToModel();
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.output_config, undefined);
  assert.equal(sent.max_tokens, 1400);
});
