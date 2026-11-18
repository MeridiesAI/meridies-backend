// The plan-billing webhook, in test mode, no Stripe account, no network: events are constructed payloads signed with the real
// SDK's test-header helper and made-up secrets, posted to the real routes over an in-memory stand-in for the database.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import billingWebhookRoutes, { type BillingWebhookDeps } from "../../src/routes/billingWebhook.js";
import stripeWebhookRoutes, { type WebhookDeps } from "../../src/routes/stripeWebhook.js";

type Row = Record<string, unknown>;
const BILLING_SECRET = "whsec_billingtestsecret0000"; // made up
const CONNECT_SECRET = "whsec_connecttestsecret0000"; // made up
const COUNSELOR = "11111111-1111-4111-8111-111111111111";
const stripe = new Stripe("sk_test_unit0000000000");

class Db {
  tables = new Map<string, Row[]>();
  rows(t: string): Row[] {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  client(): SupabaseClient {
    const db = this;
    const from = (t: string) => {
      let filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" = "select";
      let patch: Row = {};
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        maybeSingle: async () => ({ data: db.rows(t).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
        insert: async (row: Row) => {
          if (t === "plan_billing_events" && db.rows(t).some((r) => r.id === row.id)) return { error: { code: "23505" } };
          db.rows(t).push({ ...row });
          return { error: null };
        },
        upsert: async (row: Row, o: { onConflict: string }) => {
          const hit = db.rows(t).find((r) => r[o.onConflict] === row[o.onConflict]);
          if (hit) Object.assign(hit, row);
          else db.rows(t).push({ ...row });
          return { error: null };
        },
        update: (p: Row) => ((op = "update"), (patch = p), q),
        then: (resolve: (v: unknown) => void) => {
          const hits = db.rows(t).filter((r) => filters.every((f) => f(r)));
          if (op === "update") for (const h of hits) Object.assign(h, patch);
          resolve({ data: hits.map((h) => ({ counselor_id: h.counselor_id })), error: null });
        },
      };
      return q;
    };
    return { from } as unknown as SupabaseClient;
  }
}

function signed(secret: string, type: string, object: Record<string, unknown>, id = "evt_" + Math.random().toString(36).slice(2, 12)) {
  const payload = JSON.stringify({ id, object: "event", type, created: 1_800_000_000, livemode: false, data: { object } });
  return { payload, header: stripe.webhooks.generateTestHeaderString({ payload, secret }) };
}

async function build(db: Db, cancelled: string[] = []) {
  const deps: BillingWebhookDeps = {
    stripe: { webhooks: stripe.webhooks, subscriptions: { cancel: async (id: string) => (cancelled.push(id), {}) } } as unknown as BillingWebhookDeps["stripe"],
    svc: db.client(),
    secret: BILLING_SECRET,
    livemode: false,
    enabled: true,
  };
  const app = Fastify();
  await app.register(billingWebhookRoutes, { prefix: "/webhooks", deps: () => deps });
  const connectDeps: WebhookDeps = { stripe: { webhooks: stripe.webhooks, charges: {}, accounts: {} } as unknown as WebhookDeps["stripe"], svc: db.client(), webhookSecret: CONNECT_SECRET, livemode: false, enabled: true };
  const connect = Fastify();
  await connect.register(stripeWebhookRoutes, { prefix: "/webhooks", deps: () => connectDeps });
  return { app, connect };
}

const post = (app: ReturnType<typeof Fastify>, path: string, p: { payload: string; header: string }) =>
  app.inject({ method: "POST", url: path, headers: { "content-type": "application/json", "stripe-signature": p.header }, payload: p.payload });

test("checkout links the customer, then a failed and a paid invoice move the plan", async () => {
  const db = new Db();
  const { app } = await build(db);
  let r = await post(app, "/webhooks/stripe-billing", signed(BILLING_SECRET, "checkout.session.completed", { mode: "subscription", customer: "cus_A1", subscription: "sub_A1", metadata: { counselor_id: COUNSELOR } }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual([db.rows("plan_subscriptions")[0].stripe_customer_id, db.rows("plan_subscriptions")[0].status], ["cus_A1", "active"]);

  r = await post(app, "/webhooks/stripe-billing", signed(BILLING_SECRET, "invoice.payment_failed", { customer: "cus_A1" }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows("plan_subscriptions")[0].status, "past_due");
  const since = db.rows("plan_subscriptions")[0].past_due_since;
  assert.ok(since);

  // a retry keeps the first failure's date: the ladder is not restarted
  await post(app, "/webhooks/stripe-billing", signed(BILLING_SECRET, "invoice.payment_failed", { customer: "cus_A1" }));
  assert.equal(db.rows("plan_subscriptions")[0].past_due_since, since);

  await post(app, "/webhooks/stripe-billing", signed(BILLING_SECRET, "invoice.paid", { customer: "cus_A1" }));
  assert.deepEqual([db.rows("plan_subscriptions")[0].status, db.rows("plan_subscriptions")[0].past_due_since], ["active", null]);
});

test("a redelivered event is answered without doing the work again", async () => {
  const db = new Db();
  const { app } = await build(db);
  const ev = signed(BILLING_SECRET, "checkout.session.completed", { mode: "subscription", customer: "cus_B1", subscription: "sub_B1", metadata: { counselor_id: COUNSELOR } }, "evt_same");
  assert.equal((await post(app, "/webhooks/stripe-billing", ev)).statusCode, 200);
  const again = await post(app, "/webhooks/stripe-billing", ev);
  assert.equal(JSON.parse(again.body).duplicate, true);
});

test("a full refund cancels the plan and spends the money-back; a second one does nothing", async () => {
  const db = new Db();
  const cancelled: string[] = [];
  const { app } = await build(db, cancelled);
  db.rows("plan_subscriptions").push({ counselor_id: COUNSELOR, kind: "standard", status: "active", stripe_customer_id: "cus_C1", stripe_subscription_id: "sub_C1", money_back_used_at: null });
  await post(app, "/webhooks/stripe-billing", signed(BILLING_SECRET, "charge.refunded", { customer: "cus_C1", amount: 9900, amount_refunded: 9900 }));
  assert.deepEqual(cancelled, ["sub_C1"]);
  assert.equal(db.rows("plan_subscriptions")[0].status, "canceled");
  assert.ok(db.rows("plan_subscriptions")[0].money_back_used_at);
  await post(app, "/webhooks/stripe-billing", signed(BILLING_SECRET, "charge.refunded", { customer: "cus_C1", amount: 9900, amount_refunded: 9900 }));
  assert.deepEqual(cancelled, ["sub_C1"]);
});

test("a founding account keeps its kind when it checks out again", async () => {
  const db = new Db();
  const { app } = await build(db);
  db.rows("plan_subscriptions").push({ counselor_id: COUNSELOR, kind: "founding", status: "active", stripe_customer_id: "cus_F1" });
  await post(app, "/webhooks/stripe-billing", signed(BILLING_SECRET, "checkout.session.completed", { mode: "subscription", customer: "cus_F1", subscription: "sub_F1", metadata: { counselor_id: COUNSELOR } }));
  assert.equal(db.rows("plan_subscriptions")[0].kind, "founding");
});

test("the two webhooks do not accept each other's events", async () => {
  const db = new Db();
  const { app, connect } = await build(db);
  // a billing-signed event sent to the Connect endpoint is refused
  const b = signed(BILLING_SECRET, "invoice.paid", { customer: "cus_X" });
  assert.equal((await post(connect, "/webhooks/stripe", b)).statusCode, 400);
  // a Connect-signed event sent to the billing endpoint is refused, and changes nothing
  db.rows("plan_subscriptions").push({ counselor_id: COUNSELOR, kind: "standard", status: "past_due", stripe_customer_id: "cus_X" });
  const c = signed(CONNECT_SECRET, "invoice.paid", { customer: "cus_X" });
  assert.equal((await post(app, "/webhooks/stripe-billing", c)).statusCode, 400);
  assert.equal(db.rows("plan_subscriptions")[0].status, "past_due");
});

test("with billing off, or no signature, nothing is accepted", async () => {
  const db = new Db();
  const off = Fastify();
  await off.register(billingWebhookRoutes, { prefix: "/webhooks", deps: () => ({ stripe: null, svc: db.client(), secret: BILLING_SECRET, livemode: false, enabled: false }) });
  assert.equal((await post(off, "/webhooks/stripe-billing", signed(BILLING_SECRET, "invoice.paid", { customer: "cus_X" }))).statusCode, 503);
  const { app } = await build(db);
  const r = await app.inject({ method: "POST", url: "/webhooks/stripe-billing", headers: { "content-type": "application/json" }, payload: "{}" });
  assert.equal(r.statusCode, 400);
});
