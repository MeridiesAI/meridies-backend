import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import healthRoutes from "../../src/routes/health.js";

test("health shares schema probes and retries an inconclusive result instead of caching success", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let mode: "unknown" | "missing" | "present" = "unknown";
  let schemaReads = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    schemaReads++;
    // Let concurrent health requests join the same schema probe.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (mode === "unknown") {
      return Response.json({ code: "57014", message: "timeout" }, { status: 500 });
    }
    if (mode === "missing") {
      return Response.json({ code: "42703", message: "missing column" }, { status: 400 });
    }
    return Response.json([]);
  });

  const app = Fastify();
  app.register(healthRoutes);
  t.after(() => app.close());
  for (const expected of [false, false, true]) {
    const before = schemaReads;
    const replies = await Promise.all([app.inject("/health"), app.inject("/health")]);
    for (const reply of replies) {
      assert.equal(reply.json().schema, expected);
      assert.equal(reply.statusCode, expected ? 200 : 503);
    }
    assert.equal(schemaReads - before, 3, "concurrent requests share one probe per table");
    now += 5001;
    mode = mode === "unknown" ? "missing" : "present";
  }
  const before = schemaReads;
  await app.inject("/health");
  assert.equal(schemaReads, before, "only a verified schema is cached for the process");
});
