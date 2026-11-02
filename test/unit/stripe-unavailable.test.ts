// Card payments not switched on (the unit env has no Stripe keys, no service
// role and no PUBLIC_API_URL): GET /pipeline/stripe answers configured: false,
// and every other Stripe route answers 503 stripe_unavailable, before touching
// the database or Stripe. The fake database fails the test if anything but the
// workspace read reaches it.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasStripe } from "../../src/env.js";
import { HttpError } from "../../src/lib/errors.js";
import payRoutes from "../../src/routes/pay.js";
import pipelineRoutes from "../../src/routes/pipeline.js";
import pipelineStripeRoutes from "../../src/routes/pipelineStripe.js";
import stripeWebhookRoutes from "../../src/routes/stripeWebhook.js";
import { resetStripeReadyForTests, stripeReady } from "../../src/lib/stripePractice.js";

const ID = "11111111-1111-4111-8111-111111111111";

function fakeDb(): SupabaseClient {
  return {
    rpc: async (name: string) => {
      assert.equal(name, "crm_my_workspace", "only the workspace is read");
      return { data: [{ firm_id: null, is_admin: true }], error: null };
    },
    from: (table: string) => {
      throw new Error(`the database was read (${table}) while card payments are off`);
    },
  } as unknown as SupabaseClient;
}

async function build() {
  const app = Fastify();
  app.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    request.auth = { userId: ID, token: "t" };
    request.profile = { id: ID, role: "counselor", timezone: "America/New_York" } as unknown as FastifyRequest["profile"];
    request.db = fakeDb();
  });
  app.setErrorHandler((err: Error, _request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    return reply.code(500).send({ error: String(err) });
  });
  app.register(pipelineRoutes, { prefix: "/pipeline" });
  app.register(pipelineStripeRoutes, { prefix: "/pipeline" });
  app.register(payRoutes);
  app.register(stripeWebhookRoutes, { prefix: "/webhooks" });
  await app.ready();
  return app;
}

test("the unit environment has card payments off", () => {
  assert.equal(hasStripe, false);
});

test("GET /pipeline/stripe says configured: false, with who could connect", async () => {
  const app = await build();
  const r = await app.inject({ method: "GET", url: "/pipeline/stripe" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { configured: false, connected: false, chargesEnabled: false, payoutsEnabled: false, canManage: true });
  await app.close();
});

test("Connect and the pay link answer 503 stripe_unavailable", async () => {
  const app = await build();
  for (const [method, url] of [
    ["POST", "/pipeline/stripe/connect"],
    ["GET", `/pipeline/invoices/${ID}/pay-link`],
  ] as const) {
    const r = await app.inject({ method, url });
    assert.equal(r.statusCode, 503, url);
    assert.equal(r.json().code, "stripe_unavailable", url);
  }
  await app.close();
});

test("the webhook answers 503 so Stripe keeps the event and retries", async () => {
  const app = await build();
  const r = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=x" },
    payload: JSON.stringify({ id: "evt_1", type: "checkout.session.completed" }),
  });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, "stripe_unavailable");
  await app.close();
});

test("the public pay page says card payments aren't available, and starts nothing", async () => {
  const app = await build();
  const token = "a".repeat(43);
  for (const method of ["GET", "POST"] as const) {
    const r = await app.inject({ method, url: `/pay/${token}` });
    assert.equal(r.statusCode, 503, method);
    assert.match(r.body, /Card payments aren't available right now/);
    assert.equal(r.headers["cache-control"], "no-store");
  }
  await app.close();
});

// ---- Before the migration: the probe -------------------------------------------

function probeDb(error: { code: string; message?: string } | null): SupabaseClient {
  const chain = { select: () => chain, limit: async () => ({ data: [], error }) };
  return { from: () => chain } as unknown as SupabaseClient;
}

test("the migration probe: missing is false (and remembered a while), present is true and kept", async () => {
  resetStripeReadyForTests();
  assert.equal(await stripeReady(probeDb({ code: "PGRST205", message: "Could not find the table" })), false);
  // Within 30 s the answer is remembered without asking again.
  assert.equal(await stripeReady(probeDb(null)), false);
  resetStripeReadyForTests();
  assert.equal(await stripeReady(probeDb({ code: "42703", message: "column does not exist" })), false);
  resetStripeReadyForTests();
  assert.equal(await stripeReady(probeDb(null)), true);
  assert.equal(await stripeReady(probeDb({ code: "PGRST205" })), true, "once in, it stays in for the process");
  resetStripeReadyForTests();
  await assert.rejects(stripeReady(probeDb({ code: "08006" })), "a real database error isn't read as 'not applied'");
  resetStripeReadyForTests();
});
