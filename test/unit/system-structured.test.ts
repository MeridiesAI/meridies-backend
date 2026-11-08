// runSystemStructured: a model call for a job that acts for nobody (the catalog proposer). It reserves on its own
// system budget, writes the ai_runs row with no actor, and a call with neither an actor nor a system budget is a
// programming mistake refused before anything is reserved or written. Modeled on events-discovery-budget.test.ts.
// The service client points at a stand-in PostgREST on this machine that records what is written; there is no
// ANTHROPIC_API_KEY, so the call itself ends in the wrapper's 503 after the audit row is written.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";

type Seen = { method: string; path: string; body: unknown };
const seen: Seen[] = [];
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
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url?.startsWith("/rest/v1/ai_runs")) {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: "00000000-0000-4000-8000-0000000000a1" }));
      return;
    }
    res.statusCode = 200;
    res.end("[]");
  });
});

let mod: typeof import("../../src/lib/anthropic.js");
let budget: typeof import("../../src/lib/aiBudget.js");
const reserves: { subject: string }[][] = [];
const log = { warn: () => undefined, error: () => undefined };

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  // Before env.ts is first read: the service client talks to the stand-in, and there is no model key.
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-service-role-key-000000";
  delete process.env.ANTHROPIC_API_KEY;
  mod = await import("../../src/lib/anthropic.js");
  budget = await import("../../src/lib/aiBudget.js");
});
after(() => server.close());
afterEach(() => {
  budget.setBudgetBackend(null);
  seen.length = 0;
  reserves.length = 0;
});

const PRICES = [{ model: "claude-haiku-4-5", input_usd: 1, output_usd: 5, read_mult: 0.1, write_5m_mult: 1.25, write_1h_mult: 2, long_above: null, long_mult: 1, web_search_usd: 0.01 }];
function recordingBackend() {
  budget.setBudgetBackend({
    probe: async () => undefined,
    prices: async () => PRICES,
    reserve: async (lines) => (reserves.push(lines), { ok: true, totals: {} }),
    settle: async () => undefined,
    total: async () => 0,
  });
}

const opts = {
  module: "catalog-proposals" as const,
  system: "s",
  prompt: "p",
  schema: { type: "object" },
  toolName: "t",
  maxTokens: 100,
};

test("a system call reserves on system:catalog-proposals and writes ai_runs with no actor", async () => {
  recordingBackend();
  await assert.rejects(mod.runSystemStructured({ ...opts, job: "catalog-proposals", log }), (e: Error & { statusCode?: number }) => e.statusCode === 503);
  assert.equal(reserves.length, 1);
  const subjects = reserves[0]!.map((l) => l.subject);
  assert.ok(subjects.includes("system:catalog-proposals"), JSON.stringify(subjects));
  assert.ok(!subjects.some((s) => s.startsWith("user:")), "no user is charged");
  const insert = seen.find((s) => s.method === "POST" && s.path.startsWith("/rest/v1/ai_runs"));
  assert.ok(insert, "an ai_runs row is written");
  const row = (Array.isArray(insert.body) ? insert.body[0] : insert.body) as Record<string, unknown>;
  assert.equal(row.actor_id, null);
  assert.equal(row.student_id, null);
  assert.equal(row.module, "catalog-proposals");
  assert.equal(row.status, "running");
  assert.ok(seen.some((s) => s.method === "PATCH" && s.path.startsWith("/rest/v1/ai_runs")), "the row is finished (failed) after the call");
});

test("the system budget's refusal stops the call before anything is audited", async () => {
  budget.setBudgetBackend({
    probe: async () => undefined,
    prices: async () => PRICES,
    reserve: async (lines) => (reserves.push(lines), { ok: false, subject: "system:catalog-proposals", metric: "calls", period: "month" }),
    settle: async () => undefined,
    total: async () => 0,
  });
  await assert.rejects(mod.runSystemStructured({ ...opts, job: "catalog-proposals", log }), (e: Error & { statusCode?: number }) => e.statusCode === 429);
  assert.equal(reserves[0]![0]!.subject, "system:catalog-proposals");
  assert.equal(seen.filter((s) => s.path.startsWith("/rest/v1/ai_runs")).length, 0);
});

test("a call with neither an actor nor a system budget is refused before anything is reserved or written", async () => {
  recordingBackend();
  await assert.rejects(
    mod.runStructuredUnattended({ ...opts, actorId: "" as string, log }),
    /no actor and no system budget/
  );
  assert.equal(reserves.length, 0);
  assert.equal(seen.length, 0);
});
