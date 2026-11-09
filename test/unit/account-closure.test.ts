import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOSURE_GRACE_DAYS,
  closureEmail,
  closureView,
  daysLeft,
  isClosureTableMissing,
  purgeAfterFrom,
  purgeFlag,
} from "../../src/lib/accountClosure.js";
import { deletionBlocker } from "../../src/lib/accountDeletion.js";

// ---- Date math ----

test("the purge date is 30 days after the request", () => {
  assert.equal(CLOSURE_GRACE_DAYS, 30);
  assert.equal(purgeAfterFrom(new Date("2026-11-08T12:00:00.000Z")).toISOString(), "2026-12-08T12:00:00.000Z");
});

test("daysLeft counts whole days up, never below zero", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  assert.equal(daysLeft("2026-12-08T12:00:00.000Z", now), 30);
  assert.equal(daysLeft("2026-12-08T00:00:00.000Z", now), 30); // 29.5 days reads as 30
  assert.equal(daysLeft("2026-11-08T12:00:01.000Z", now), 1);
  assert.equal(daysLeft("2026-11-08T12:00:00.000Z", now), 0);
  assert.equal(daysLeft("2026-11-01T00:00:00.000Z", now), 0);
});

// ---- The OFF switch ----

test("the purge runs only when the flag is exactly \"true\"", () => {
  assert.equal(purgeFlag("true"), true);
  for (const v of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "]) assert.equal(purgeFlag(v), false, String(v));
});

// ---- What GET /account/closure answers ----

test("no row, or a cancelled one, reads as none", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  const none = { status: "none", requestedAt: null, purgeAfter: null, daysLeft: null, purgeEnabled: false, blockedReason: null };
  assert.deepEqual(closureView(null, now, false), none);
  assert.deepEqual(
    closureView({ status: "cancelled", requested_at: "2026-11-01T00:00:00Z", purge_after: "2026-12-01T00:00:00Z", last_error: null }, now, false),
    none
  );
});

test("a pending row reads with its dates, days left and the flag", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  const v = closureView(
    { status: "pending", requested_at: "2026-11-08T12:00:00.000Z", purge_after: "2026-12-08T12:00:00.000Z", last_error: null },
    now,
    true
  );
  assert.deepEqual(v, {
    status: "pending",
    requestedAt: "2026-11-08T12:00:00.000Z",
    purgeAfter: "2026-12-08T12:00:00.000Z",
    daysLeft: 30,
    purgeEnabled: true,
    blockedReason: null,
  });
});

test("a failed row reads as on hold, with the reason and no date", () => {
  const v = closureView(
    { status: "failed", requested_at: "2026-10-01T00:00:00Z", purge_after: "2026-10-31T00:00:00Z", last_error: "You still have 2 students on your roster." },
    new Date("2026-11-08T00:00:00Z"),
    true
  );
  assert.deepEqual(v, {
    status: "on_hold",
    requestedAt: "2026-10-01T00:00:00.000Z",
    purgeAfter: null,
    daysLeft: null,
    purgeEnabled: true,
    blockedReason: "You still have 2 students on your roster.",
  });
});

test("a row being purged reads as pending with 0 days left", () => {
  const v = closureView({ status: "purging", requested_at: "2026-10-01T00:00:00Z", purge_after: "2026-10-31T00:00:00Z", last_error: null }, new Date("2026-11-08T00:00:00Z"), true);
  assert.equal(v.status, "pending");
  assert.equal(v.daysLeft, 0);
});

test("a missing table is told apart from other errors", () => {
  for (const code of ["42P01", "PGRST205"]) assert.equal(isClosureTableMissing({ code }), true, code);
  for (const code of ["42501", "23505", undefined]) assert.equal(isClosureTableMissing({ code }), false, String(code));
});

// ---- The emails ----

test("the request email gives the date, how to cancel and to export first", () => {
  const m = closureEmail("requested", { purgeAfter: "2026-12-08T17:00:00.000Z", timeZone: "America/Los_Angeles", appUrl: "https://app.example" });
  assert.match(m.subject, /close/i);
  for (const body of [m.text, m.html]) {
    assert.match(body, /December 8, 2026/);
    assert.match(body, /Settings/);
    assert.match(body, /cancel/i);
    assert.match(body, /export/i);
  }
  assert.match(m.text, /https:\/\/app\.example\/dashboard\/counselor\/settings/);
  // Nothing is disconnected at request time: the connections go only when the account is purged.
  assert.doesNotMatch(m.text, /disconnect/i);
  assert.match(m.text, /connections included/);
});

test("the date is the counselor's local day, and an unknown zone falls back to UTC", () => {
  // 03:00 UTC on Dec 9 is still Dec 8 in Los Angeles.
  assert.match(closureEmail("requested", { purgeAfter: "2026-12-09T03:00:00.000Z", timeZone: "America/Los_Angeles", appUrl: "https://a.b" }).text, /December 8, 2026/);
  assert.match(closureEmail("requested", { purgeAfter: "2026-12-09T03:00:00.000Z", timeZone: "Not/AZone", appUrl: "https://a.b" }).text, /December 9, 2026/);
  assert.match(closureEmail("requested", { purgeAfter: "2026-12-09T03:00:00.000Z", timeZone: null, appUrl: "https://a.b" }).text, /December 9, 2026/);
});

test("cancelling an on-hold closure names no stale date", () => {
  const m = closureEmail("cancelled", { purgeAfter: null, timeZone: null, appUrl: "https://a.b" });
  assert.match(m.text, /It won't be closed, and nothing in it has changed/);
  assert.doesNotMatch(m.text, /\b20\d\d\b/);
});

test("the cancel email says the account stays open", () => {
  const m = closureEmail("cancelled", { purgeAfter: "2026-12-08T17:00:00.000Z", timeZone: null, appUrl: "https://a.b" });
  assert.match(m.subject, /stays open|cancel/i);
  assert.match(m.text, /won't be closed|stays open/i);
});

// ---- The shared preconditions ----

type Result = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number | null };
type Call = { table: string; filters: string[] };

/** A stand-in for the service client: each table answers what `answers` says; every filter is recorded. */
function fakeSvc(answers: Record<string, Result | ((c: Call) => Result)>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const c: Call = { table, filters: [] };
      calls.push(c);
      const answer = () => {
        const a = answers[table];
        const r = typeof a === "function" ? a(c) : a ?? { data: null, error: null, count: 0 };
        return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "limit", "in", "order"]) {
        b[m] = (...args: unknown[]) => {
          c.filters.push(`${m}:${args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(",")}`);
          return b;
        };
      }
      b.maybeSingle = async () => {
        const r = answer();
        return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data };
      };
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej);
      return b;
    },
  };
  return { svc: client as never, calls };
}

const counselor = (firm: string | null = null) => ({ id: "c1", role: "counselor", firm_id: firm });

test("a firm member with any student, archived included, is told to ask an owner or admin", async () => {
  const { svc, calls } = fakeSvc({ profiles: { count: 2 } });
  const b = await deletionBlocker(svc, counselor("f1"));
  assert.equal(b?.code, "caseload_not_empty");
  assert.match(b!.message, /You still have 2 students on your caseload\. Ask a firm owner or admin to transfer them/);
  assert.ok(!calls[0]!.filters.some((f) => f.startsWith("is:archived_at")), "a firm counts archived students");
});

test("a solo counselor counts only active students", async () => {
  const { svc, calls } = fakeSvc({ profiles: { count: 1 } });
  const b = await deletionBlocker(svc, counselor());
  assert.equal(b?.code, "caseload_not_empty");
  assert.match(b!.message, /1 student on your roster\. Archive them/);
  assert.ok(calls[0]!.filters.includes("is:archived_at,null"));
});

test("a firm owner is refused", async () => {
  const { svc } = fakeSvc({ profiles: { count: 0 }, firms: { data: { id: "f1" } } });
  assert.equal((await deletionBlocker(svc, counselor()))?.code, "owns_firm");
});

/** practice_stripe_accounts answers only rows the query's filters let through (charges_enabled is the one that matters). */
const stripeRows = (rows: Array<{ practice_id: string; charges_enabled: boolean }>) => (c: Call) => ({
  data: rows.filter((r) => !c.filters.includes("eq:charges_enabled,true") || r.charges_enabled),
});

test("a solo practice whose Stripe account takes charges is told to disconnect first", async () => {
  const { svc, calls } = fakeSvc({ profiles: { count: 0 }, practice_stripe_accounts: stripeRows([{ practice_id: "c1", charges_enabled: true }]) });
  const b = await deletionBlocker(svc, counselor());
  assert.equal(b?.code, "stripe_connected");
  assert.match(b!.message, /Disconnect Meridies in your Stripe dashboard first, then try again/);
  assert.ok(calls.find((c) => c.table === "practice_stripe_accounts")!.filters.includes("eq:counselor_id,c1"));
});

test("a deauthorized or never-finished Stripe account (charges off) doesn't block", async () => {
  const { svc } = fakeSvc({ profiles: { count: 0 }, practice_stripe_accounts: stripeRows([{ practice_id: "c1", charges_enabled: false }]) });
  assert.equal(await deletionBlocker(svc, counselor()), null);
});

test("a firm member's Stripe account is the firm's, not theirs", async () => {
  const { svc, calls } = fakeSvc({ profiles: { count: 0 } });
  assert.equal(await deletionBlocker(svc, counselor("f1")), null);
  assert.ok(!calls.some((c) => c.table === "practice_stripe_accounts"));
});

test("signed agreements are kept: the account is refused", async () => {
  const { svc } = fakeSvc({ profiles: { count: 0 }, agreements: { data: [{ id: "a1" }] } });
  assert.equal((await deletionBlocker(svc, counselor()))?.code, "signed_agreements_kept");
});

test("a database without the Stripe or agreements tables blocks nothing", async () => {
  const missing = { error: { code: "42P01", message: "relation does not exist" } };
  const { svc } = fakeSvc({ profiles: { count: 0 }, practice_stripe_accounts: missing, agreements: { error: { code: "PGRST205" } } });
  assert.equal(await deletionBlocker(svc, counselor()), null);
});

test("any other read error throws, so the caller refuses instead of guessing", async () => {
  await assert.rejects(deletionBlocker(fakeSvc({ profiles: { error: { code: "57014", message: "timeout" } } }).svc, counselor()));
  await assert.rejects(deletionBlocker(fakeSvc({ profiles: { count: 0 }, agreements: { error: { code: "42501" } } }).svc, counselor()));
});

test("a student is never blocked (their record goes with them)", async () => {
  const { svc, calls } = fakeSvc({});
  assert.equal(await deletionBlocker(svc, { id: "s1", role: "student", firm_id: null }), null);
  assert.equal(calls.length, 0);
});

test("a Stripe read that errors throws (fail closed)", async () => {
  const { svc } = fakeSvc({ profiles: { count: 0 }, practice_stripe_accounts: { error: { code: "57014", message: "timeout" } } });
  await assert.rejects(deletionBlocker(svc, counselor()));
});

// ---- Billing history: invoices, payments and credit refunds RESTRICT their package, so the deletion would fail ----

test("an invoice on one of the counselor's own contacts blocks: billing_history", async () => {
  const { svc, calls } = fakeSvc({ profiles: { count: 0 }, pipeline_invoices: { data: [{ id: "i1" }] } });
  const b = await deletionBlocker(svc, counselor());
  assert.equal(b?.code, "billing_history");
  assert.equal(b?.message, "Your account has invoices or payments on record, which Meridies has to keep. Ask the team to close it for you.");
  const q = calls.find((c) => c.table === "pipeline_invoices")!;
  assert.ok(q.filters.includes("eq:pipeline_packages.pipeline_contacts.counselor_id,c1"), q.filters.join(" "));
});

test("a payment or a credit refund blocks too, in a firm as well", async () => {
  for (const table of ["pipeline_payments", "pipeline_credit_refunds"]) {
    const { svc } = fakeSvc({ profiles: { count: 0 }, [table]: { data: [{ id: "x" }] } });
    assert.equal((await deletionBlocker(svc, counselor("f1")))?.code, "billing_history", table);
  }
});

test("no billing rows, or a database without those tables, doesn't block", async () => {
  assert.equal(await deletionBlocker(fakeSvc({ profiles: { count: 0 } }).svc, counselor()), null);
  const missing = { error: { code: "42P01" } };
  assert.equal(
    await deletionBlocker(fakeSvc({ profiles: { count: 0 }, pipeline_invoices: missing, pipeline_payments: missing, pipeline_credit_refunds: { error: { code: "PGRST205" } } }).svc, counselor()),
    null
  );
});

test("a billing read that errors throws (fail closed)", async () => {
  await assert.rejects(deletionBlocker(fakeSvc({ profiles: { count: 0 }, pipeline_payments: { error: { code: "57014" } } }).svc, counselor()));
});
