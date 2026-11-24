// A structured call's `temperature` reaches the Messages request when set, and is left out when not, so every other
// AI call sends exactly what it sent before. The model client and the service client both point at a stand-in on
// this machine that records each request.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";

const messages: Record<string, unknown>[] = [];
const server = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      messages.push(JSON.parse(raw) as Record<string, unknown>);
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "tool_use", id: "toolu_1", name: "t", input: { ok: true } }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      );
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/rest/v1/ai_runs")) {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "00000000-0000-4000-8000-0000000000a1" }));
      return;
    }
    res.end("[]");
  });
});

let mod: typeof import("../../src/lib/anthropic.js");
let budget: typeof import("../../src/lib/aiBudget.js");
const log = { warn: () => undefined, error: () => undefined };

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Before env.ts is first read.
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-service-role-key-000000";
  process.env.ANTHROPIC_API_KEY = "stand-in-model-key-0000000000";
  process.env.ANTHROPIC_BASE_URL = base;
  mod = await import("../../src/lib/anthropic.js");
  budget = await import("../../src/lib/aiBudget.js");
  budget.setBudgetBackend({
    probe: async () => undefined,
    prices: async () => [{ model: "claude-haiku-4-5", input_usd: 1, output_usd: 5, read_mult: 0.1, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 }],
    reserve: async () => ({ ok: true, totals: {} }),
    settle: async () => undefined,
    total: async () => 0,
  });
});
after(() => {
  budget.setBudgetBackend(null);
  server.close();
});
afterEach(() => {
  messages.length = 0;
});

const opts = { job: "college-features" as const, module: "college-features" as const, system: "s", prompt: "p", schema: { type: "object" }, toolName: "t", maxTokens: 100, log };

test("temperature 0 is sent when the caller sets it", async () => {
  assert.deepEqual(await mod.runSystemStructured({ ...opts, temperature: 0 }), { ok: true });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.temperature, 0);
});

test("a thinking model (structured outputs, no forced tool) never gets a temperature: it refuses non-default values", () => {
  const base = { maxTokens: 100, system: "s", content: "p", schema: { type: "object" }, toolName: "t", temperature: 0 };
  assert.equal(mod.structuredRequest({ ...base, model: "claude-haiku-4-5" }).temperature, 0);
  for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
    assert.ok(!("temperature" in mod.structuredRequest({ ...base, model })), model);
  }
});

test("no temperature is sent when the caller doesn't set one", async () => {
  await mod.runSystemStructured(opts);
  assert.equal(messages.length, 1);
  assert.ok(!("temperature" in messages[0]!));
});
