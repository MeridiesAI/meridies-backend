// The Stripe Connect webhook end to end, in test mode, with no Stripe account
// and no network: every event is a constructed payload signed with the real
// SDK's test-header helper and a made-up webhook secret, posted to the real
// route, which writes to an in-memory stand-in for the database. Charges and
// accounts are re-read from a fake Stripe (the route never trusts a payload's
// running totals: events arrive in any order).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Fastify from "fastify";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resetCardIssuesReadyForTests, withCardIssues } from "../../src/lib/cardIssues.js";
import { HttpError } from "../../src/lib/errors.js";
import { META_CONTACT, META_INVOICE, META_PRACTICE, FAILED_ASYNC_REASON, planStripeEvent, keyLivemode } from "../../src/lib/stripeConnect.js";
import { readAccount, resetStripeReadyForTests } from "../../src/lib/stripePractice.js";
import { failureNote } from "../../src/routes/pay.js";
import stripeWebhookRoutes, { type WebhookDeps, type WebhookStripe } from "../../src/routes/stripeWebhook.js";

type Row = Record<string, unknown>;

const INVOICE = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const PRACTICE = "33333333-3333-4333-8333-333333333333";
const COUNSELOR = PRACTICE; // a solo counselor: the practice id is their profile id
const ACCT = "acct_1PracticeAbc";
const OTHER = "acct_1SomeoneElse";
const SECRET = "whsec_unittestsecret000000"; // made up: test mode only, never a real secret
const TODAY = "2026-11-10";

// ---- An in-memory stand-in for the service-role client ----------------------------

type Err = { code: string; message?: string } | null;
const UNIQUE: Record<string, string[]> = {
  pipeline_payments: ["stripe_payment_intent_id"],
  stripe_webhook_events: ["id"],
  pipeline_card_issues: ["stripe_event_id"],
};

class FakeDb {
  tables = new Map<string, Row[]>();
  missing = new Set<string>();
  rows(t: string): Row[] {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  client(): SupabaseClient {
    return { from: (t: string) => new Query(this, t) } as unknown as SupabaseClient;
  }
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private max = Infinity;
  constructor(private db: FakeDb, private table: string) {}
  select() {
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  private run(): { data: unknown; error: Err } {
    if (this.db.missing.has(this.table)) return { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
    const rows = this.db.rows(this.table);
    if (this.op === "insert") {
      const row: Row = { id: `${this.table}-${rows.length + 1}`, created_at: new Date().toISOString(), ...this.payload };
      for (const k of UNIQUE[this.table] ?? []) {
        if (row[k] != null && rows.some((r) => r[k] === row[k])) return { data: null, error: { code: "23505" } };
      }
      rows.push(row);
      return { data: null, error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.payload);
      return { data: null, error: null };
    }
    return { data: hit.slice(0, this.max), error: null };
  }
  maybeSingle() {
    const r = this.run();
    const list = (r.data as Row[] | null) ?? [];
    return Promise.resolve({ data: r.error ? null : (list[0] ?? null), error: r.error });
  }
  then<T>(resolve: (v: { data: unknown; error: Err }) => T, reject?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
}

// ---- A fake Stripe: the real signature check, made-up charges and accounts -----------

const realStripe = new Stripe("sk_test_unit000000000000");

class FakeStripe {
  charges = new Map<string, { id: string; payment_intent: string; amount_refunded: number }>();
  accounts = new Map<string, { charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean } | "gone">();
  client(): WebhookStripe {
    return {
      webhooks: realStripe.webhooks,
      charges: {
        retrieve: async (id: string) => {
          const c = this.charges.get(id);
          if (!c) throw Object.assign(new Error("No such charge"), { type: "StripeInvalidRequestError", statusCode: 404 });
          return c;
        },
      },
      accounts: {
        retrieve: async (id: string) => {
          const a = this.accounts.get(id);
          if (!a || a === "gone") throw Object.assign(new Error("no access"), { type: "StripePermissionError", statusCode: 403 });
          return { id, ...a };
        },
      },
    } as unknown as WebhookStripe;
  }
}

let db: FakeDb;
let stripe: FakeStripe;

function seed() {
  db = new FakeDb();
  stripe = new FakeStripe();
  db.rows("pipeline_packages").push({ contact_id: CONTACT, package_name: "Senior", total_cents: 100000, installments: 2 });
  db.rows("pipeline_invoices").push({
    id: INVOICE,
    contact_id: CONTACT,
    number: "INV-1001",
    number_scope: PRACTICE,
    label: "Deposit",
    amount_cents: 50000,
    issued_on: "2026-11-01",
    due_on: "2026-12-01",
    created_at: "2026-11-01T00:00:00Z",
  });
  db.rows("pipeline_contacts").push({ id: CONTACT, counselor_id: COUNSELOR });
  db.rows("profiles").push({ id: COUNSELOR, timezone: "America/New_York" });
  db.rows("practice_stripe_accounts").push({
    practice_id: PRACTICE,
    counselor_id: COUNSELOR,
    stripe_account_id: ACCT,
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
  });
  stripe.accounts.set(ACCT, { charges_enabled: true, payouts_enabled: true, details_submitted: true });
}

beforeEach(() => {
  seed();
  resetStripeReadyForTests();
  resetCardIssuesReadyForTests();
});

async function build(over: Partial<WebhookDeps> = {}) {
  const app = Fastify();
  app.setErrorHandler((err: Error, _request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    return reply.code(500).send({ error: String(err) });
  });
  const deps = (): WebhookDeps => ({ stripe: stripe.client(), svc: db.client(), webhookSecret: SECRET, livemode: false, enabled: true, ...over });
  app.register(stripeWebhookRoutes, { prefix: "/webhooks", deps });
  await app.ready();
  return app;
}

let seq = 0;
const meta = { [META_INVOICE]: INVOICE, [META_CONTACT]: CONTACT, [META_PRACTICE]: PRACTICE };
function evt(type: string, object: Row, over: Row = {}) {
  seq += 1;
  return { id: `evt_test_${seq}`, object: "event", type, account: ACCT, livemode: false, created: 1_794_000_000 + seq, data: { object }, ...over };
}
const session = (over: Row = {}) => ({
  id: "cs_test_1",
  object: "checkout.session",
  mode: "payment",
  payment_status: "paid",
  currency: "usd",
  amount_total: 50000,
  payment_intent: "pi_test_1",
  metadata: meta,
  ...over,
});
const failedIntent = (over: Row = {}) => ({
  id: "pi_test_1",
  object: "payment_intent",
  amount: 50000,
  currency: "usd",
  status: "requires_payment_method",
  metadata: meta,
  last_payment_error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." },
  ...over,
});
const dispute = (over: Row = {}) => ({
  id: "dp_test_1",
  object: "dispute",
  amount: 50000,
  charge: "ch_test_1",
  payment_intent: "pi_test_1",
  reason: "fraudulent",
  status: "needs_response",
  ...over,
});

async function post(app: Awaited<ReturnType<typeof build>>, event: Row | string, headers: Record<string, string> | null = {}) {
  const payload = typeof event === "string" ? event : JSON.stringify(event);
  const signed = headers === null ? {} : { "stripe-signature": realStripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }), ...headers };
  return app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "content-type": "application/json", ...signed }, payload });
}

const payments = () => db.rows("pipeline_payments");
const issues = () => db.rows("pipeline_card_issues");
const account = async () => {
  const a = await readAccount(db.client(), CONTACT, TODAY);
  assert.ok(a);
  return a;
};
const invoice = async () => (await account()).invoices[0];

// ---- Paid -----------------------------------------------------------------------

test("paid: checkout.session.completed records one card payment and the invoice reads paid", async () => {
  const app = await build();
  const r = await post(app, evt("checkout.session.completed", session()));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, "recorded");
  assert.equal(payments().length, 1);
  assert.equal(payments()[0].via_stripe, true);
  assert.equal(payments()[0].amount_cents, 50000);
  assert.equal(payments()[0].stripe_payment_intent_id, "pi_test_1");
  assert.equal((await invoice()).state, "paid");
  assert.equal(db.rows("stripe_webhook_events").length, 1);
  await app.close();
});

test("async paid: an unpaid completion waits, async_payment_succeeded records, a late completed adds nothing", async () => {
  const app = await build();
  assert.equal((await post(app, evt("checkout.session.completed", session({ payment_status: "unpaid" })))).json().outcome, "not paid yet");
  assert.equal(payments().length, 0);
  assert.equal((await post(app, evt("checkout.session.async_payment_succeeded", session()))).json().outcome, "recorded");
  assert.equal((await post(app, evt("checkout.session.completed", session()))).json().outcome, "already recorded");
  assert.equal(payments().length, 1, "keyed by the PaymentIntent");
  await app.close();
});

// ---- Failed -------------------------------------------------------------------------

test("failed: payment_intent.payment_failed notes the reason on the invoice and records no payment", async () => {
  const app = await build();
  const r = await post(app, evt("payment_intent.payment_failed", failedIntent()));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, "noted");
  assert.equal(payments().length, 0, "a failure is never a payment");
  assert.equal(issues().length, 1);
  assert.equal(issues()[0].kind, "payment_failed");
  assert.equal(issues()[0].reason_code, "generic_decline");
  const inv = await invoice();
  assert.equal(inv.state, "open", "still owed");
  assert.equal(inv.paidCents, 0);
  assert.deepEqual(
    { reason: inv.cardFailure?.reason, code: inv.cardFailure?.code, amountCents: inv.cardFailure?.amountCents },
    { reason: "Your card was declined.", code: "generic_decline", amountCents: 50000 }
  );
  assert.equal((await account()).collectedCents, 0);
  await app.close();
});

test("failed, then paid with another card: the failure line goes away and the payment counts once", async () => {
  const app = await build();
  await post(app, evt("payment_intent.payment_failed", failedIntent({ last_payment_error: { decline_code: "insufficient_funds", message: "Your card has insufficient funds." } })));
  assert.equal((await invoice()).cardFailure?.code, "insufficient_funds");
  await post(app, evt("checkout.session.completed", session()));
  const inv = await invoice();
  assert.equal(inv.state, "paid");
  assert.equal(inv.cardFailure, null);
  assert.equal((await account()).collectedCents, 50000);
  await app.close();
});

test("failed without Stripe's words reads a plain sentence; async_payment_failed is a failure too", async () => {
  const app = await build();
  await post(app, evt("payment_intent.payment_failed", failedIntent({ last_payment_error: null })));
  assert.equal((await invoice()).cardFailure?.reason, "The card payment didn't go through.");
  await post(app, evt("checkout.session.async_payment_failed", session({ payment_status: "unpaid", payment_intent: "pi_test_2" })));
  assert.equal(issues().length, 2);
  assert.equal((await invoice()).cardFailure?.reason, FAILED_ASYNC_REASON, "the latest failure shows");
  assert.equal(payments().length, 0);
  await app.close();
});

test("expired: an abandoned Checkout writes nothing but the handled event", async () => {
  const app = await build();
  const r = await post(app, evt("checkout.session.expired", session({ status: "expired", payment_status: "unpaid" })));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, "checkout expired unpaid");
  assert.equal(payments().length, 0);
  assert.equal(issues().length, 0);
  assert.equal((await invoice()).cardFailure, null);
  assert.equal(db.rows("stripe_webhook_events").length, 1);
  await app.close();
});

test("failed before the card issues migration: noted in audit_log, 200, and the tracker reads as before", async () => {
  db.missing.add("pipeline_card_issues");
  const app = await build();
  const r = await post(app, evt("payment_intent.payment_failed", failedIntent()));
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().outcome, "noted in audit_log");
  const audit = db.rows("audit_log");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "pipeline.card_payment_failed");
  assert.equal(audit[0].entity_id, INVOICE);
  assert.equal((audit[0].metadata as Row).reason, "Your card was declined.");
  assert.equal(payments().length, 0);
  assert.equal((await invoice()).cardFailure, null);
  await app.close();
});

// ---- Refunds -------------------------------------------------------------------------

async function paid(app: Awaited<ReturnType<typeof build>>) {
  await post(app, evt("checkout.session.completed", session()));
  stripe.charges.set("ch_test_1", { id: "ch_test_1", payment_intent: "pi_test_1", amount_refunded: 0 });
}
const refundEvent = (amountRefunded: number) =>
  evt("charge.refunded", { id: "ch_test_1", object: "charge", amount_refunded: amountRefunded, payment_intent: "pi_test_1", metadata: meta });

test("refunded, partly then fully: refunded_cents is Stripe's running total and the invoice is owed again", async () => {
  const app = await build();
  await paid(app);
  stripe.charges.get("ch_test_1")!.amount_refunded = 20000;
  assert.equal((await post(app, refundEvent(20000))).json().outcome, "refund recorded");
  assert.equal(payments()[0].refunded_cents, 20000);
  let a = await account();
  assert.equal(a.collectedCents, 30000, "a refunded amount stops counting (netOfRefund)");
  assert.equal(a.invoices[0].state, "open");
  assert.equal(a.invoices[0].paidCents, 30000);

  stripe.charges.get("ch_test_1")!.amount_refunded = 50000;
  await post(app, refundEvent(50000));
  a = await account();
  assert.equal(payments()[0].refunded_cents, 50000);
  assert.equal(a.collectedCents, 0);
  assert.equal(a.invoices[0].paidCents, 0);
  await app.close();
});

test("refunds out of order: a stale charge.refunded can't lower the total (the charge is re-read)", async () => {
  const app = await build();
  await paid(app);
  stripe.charges.get("ch_test_1")!.amount_refunded = 30000; // two partial refunds: 10,000 then 20,000
  await post(app, refundEvent(30000));
  await post(app, refundEvent(10000)); // the first refund's event, delivered last
  assert.equal(payments()[0].refunded_cents, 30000);
  await app.close();
});

test("a refund of a Meridies charge whose payment isn't recorded yet answers 503 so Stripe retries", async () => {
  const app = await build();
  stripe.charges.set("ch_test_1", { id: "ch_test_1", payment_intent: "pi_test_1", amount_refunded: 50000 });
  const r = await post(app, refundEvent(50000));
  assert.equal(r.statusCode, 503);
  assert.equal(db.rows("stripe_webhook_events").length, 0, "not marked handled, so the retry does the work");
  await app.close();
});

// ---- Disputes -----------------------------------------------------------------------

test("dispute: created flags the card payment, closed updates it, and nothing it paid changes", async () => {
  const app = await build();
  await paid(app);
  assert.equal((await post(app, evt("charge.dispute.created", dispute()))).json().outcome, "noted");
  let a = await account();
  assert.equal(a.payments[0].dispute?.status, "needs_response");
  assert.equal(a.payments[0].dispute?.reason, "fraudulent");
  assert.equal(a.collectedCents, 50000, "a dispute is a flag, not a refund");
  await post(app, evt("charge.dispute.closed", dispute({ status: "lost" })));
  a = await account();
  assert.equal(a.payments[0].dispute?.status, "lost");
  assert.equal(a.invoices[0].state, "paid");
  assert.equal(issues().length, 2);
  await app.close();
});

test("a dispute on a charge Meridies didn't take is ignored", async () => {
  const app = await build();
  const r = await post(app, evt("charge.dispute.created", dispute({ payment_intent: "pi_elsewhere", charge: "ch_elsewhere" })));
  assert.equal(r.json().outcome, "not a Meridies payment");
  assert.equal(issues().length, 0);
  await app.close();
});

// ---- Accounts -----------------------------------------------------------------------

test("account.updated sets the flags from Stripe's current account, not the event's copy", async () => {
  const app = await build();
  stripe.accounts.set(ACCT, { charges_enabled: true, payouts_enabled: false, details_submitted: true });
  // A stale event saying charges are off.
  await post(app, evt("account.updated", { id: ACCT, object: "account", charges_enabled: false, payouts_enabled: false, details_submitted: false }));
  const row = db.rows("practice_stripe_accounts")[0];
  assert.equal(row.charges_enabled, true);
  assert.equal(row.payouts_enabled, false);
  await app.close();
});

test("deauthorized: the practice disconnected, so it takes no more cards (and a late account.updated agrees)", async () => {
  const app = await build();
  await post(app, evt("account.application.deauthorized", { id: "ca_test_1", object: "application" }));
  let row = db.rows("practice_stripe_accounts")[0];
  assert.equal(row.charges_enabled, false);
  assert.equal(row.payouts_enabled, false);
  stripe.accounts.set(ACCT, "gone");
  await post(app, evt("account.updated", { id: ACCT, object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true }));
  row = db.rows("practice_stripe_accounts")[0];
  assert.equal(row.charges_enabled, false, "Stripe refuses to read it: still disconnected");
  await app.close();
});

// ---- Who sent it -------------------------------------------------------------------

test("wrong account: a payment or a failure on another practice's account doesn't touch this invoice", async () => {
  const app = await build();
  assert.equal((await post(app, evt("checkout.session.completed", session(), { account: OTHER }))).json().outcome, "account-mismatch");
  assert.equal((await post(app, evt("payment_intent.payment_failed", failedIntent(), { account: OTHER }))).json().outcome, "account-mismatch");
  assert.equal((await post(app, evt("checkout.session.completed", session(), { account: null }))).json().outcome, "not from a connected account");
  assert.equal(payments().length, 0);
  assert.equal(issues().length, 0);
  await app.close();
});

test("unsigned, badly signed or tampered: 400 and nothing is read or written", async () => {
  const app = await build();
  const body = JSON.stringify(evt("checkout.session.completed", session()));
  assert.equal((await post(app, body, null)).statusCode, 400, "no Stripe-Signature");
  assert.equal((await post(app, body, { "stripe-signature": "t=1,v1=deadbeef" })).statusCode, 400, "a made-up signature");
  const otherSecret = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_someOtherSecret000" });
  assert.equal((await post(app, body, { "stripe-signature": otherSecret })).statusCode, 400, "signed with another secret");
  const good = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  assert.equal((await post(app, body.replace("50000", "1"), { "stripe-signature": good })).statusCode, 400, "the body changed after signing");
  const old = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await post(app, body, { "stripe-signature": old })).statusCode, 400, "a replay an hour later");
  assert.equal(payments().length, 0);
  assert.equal(db.rows("stripe_webhook_events").length, 0);
  await app.close();
});

test("duplicate delivery: the same event twice is answered without work", async () => {
  const app = await build();
  const e = evt("payment_intent.payment_failed", failedIntent());
  assert.equal((await post(app, e)).json().outcome, "noted");
  const again = await post(app, e);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { received: true, duplicate: true });
  assert.equal(issues().length, 1);
  // Even if the handled-events note was lost, the issue's event id is unique.
  db.tables.set("stripe_webhook_events", []);
  assert.equal((await post(app, e)).json().outcome, "already noted");
  assert.equal(issues().length, 1);
  await app.close();
});

test("a live-mode event on the test-mode key is ignored (and the other way round)", async () => {
  const app = await build();
  const r = await post(app, evt("checkout.session.completed", session(), { livemode: true }));
  assert.equal(r.json().outcome, "a live-mode event on a test-mode key");
  assert.equal(payments().length, 0);
  await app.close();
  const live = await build({ livemode: true });
  assert.equal((await post(live, evt("checkout.session.completed", session()))).json().outcome, "a test-mode event on a live-mode key");
  await live.close();
  assert.equal(keyLivemode("sk_test_abc"), false);
  assert.equal(keyLivemode("rk_live_abc"), true);
  assert.equal(keyLivemode(undefined), null);
});

test("switched off: 503 so Stripe keeps the event", async () => {
  const app = await build({ enabled: false });
  assert.equal((await post(app, evt("checkout.session.completed", session()))).statusCode, 503);
  await app.close();
});

// ---- The pure parts ---------------------------------------------------------------

test("planning: Stripe's codes and words are kept tidy", () => {
  const a = planStripeEvent(evt("payment_intent.payment_failed", failedIntent({ last_payment_error: { code: "Bad Code!", message: "<b>Declined</b>\n by bank" } })));
  assert.equal(a.kind, "card-failure");
  if (a.kind !== "card-failure") return;
  assert.equal(a.reasonCode, null);
  assert.equal(a.reason, "b Declined /b by bank");
  assert.equal(planStripeEvent(evt("payment_intent.payment_failed", failedIntent({ metadata: {} }))).kind, "ignore", "not a Meridies pay link");
});

test("a paid or cancelled invoice shows no failure; the pay page tells the family what happened", async () => {
  const base = await account();
  const row = { kind: "payment_failed", contact_id: CONTACT, invoice_id: INVOICE, reason: "Your card was declined.", occurred_at: "2026-11-09T12:00:00Z" };
  assert.equal(withCardIssues(base, [row], []).invoices[0].cardFailure?.reason, "Your card was declined.");
  const voided = { ...base, invoices: base.invoices.map((i) => ({ ...i, state: "void" as const })) };
  assert.equal(withCardIssues(voided, [row], []).invoices[0].cardFailure, null);
  assert.equal(
    failureNote({ reason: "Your card was declined." }),
    "Your last card payment didn't go through (Your card was declined), and nothing was charged. You can try again, with another card if you need to."
  );
  assert.equal(failureNote(null), null);
});
