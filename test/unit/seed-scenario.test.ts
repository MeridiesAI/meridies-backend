// The e2e seed's pure parts: the Payment Tracker figures written by hand in
// scripts/seed/billing-scenario.mjs must be what src/lib/payments.ts derives,
// and the local-only guard must refuse anything that isn't this machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAccount, totals } from "../../src/lib/payments.js";
// @ts-expect-error plain ESM script, no types
import { BILLING_FAMILIES, BILLING_TOTALS, shiftDate } from "../../scripts/seed/billing-scenario.mjs";
// @ts-expect-error plain ESM script, no types
import { assertLocalStack, isLocalUrl, LIBPQ_HOST_ENV, psqlEnv } from "../../scripts/seed/local-only.mjs";

type Row = Record<string, unknown>;
type Invoice = { label: string; amountCents: number; issuedDaysAgo: number; dueInDays: number };
type Payment = { amountCents: number; daysAgo: number; method: string };
type Family = {
  key: string;
  package: { name: string; totalCents: number; installments: number };
  invoices: Invoice[];
  payments: Payment[];
  expected: Record<string, unknown> & { afterVoidingSecond?: Record<string, unknown> };
};

const TODAY = "2026-10-15";

function rowsFor(fam: Family, { voidSecond = false } = {}) {
  const pkg: Row = { contact_id: fam.key, package_name: fam.package.name, total_cents: fam.package.totalCents, installments: fam.package.installments };
  const invoices: Row[] = fam.invoices.map((inv, i) => ({
    id: `${fam.key}-inv-${i}`, number: `INV-${i + 1}`, label: inv.label, amount_cents: inv.amountCents,
    issued_on: shiftDate(TODAY, -inv.issuedDaysAgo), due_on: shiftDate(TODAY, inv.dueInDays),
    voided_at: voidSecond && i === 1 ? "2026-10-15T12:00:00Z" : null, created_at: `2026-10-15T00:00:0${i}Z`,
  }));
  const payments: Row[] = fam.payments.map((p, i) => ({
    id: `${fam.key}-pay-${i}`, amount_cents: p.amountCents, received_on: shiftDate(TODAY, -p.daysAgo), method: p.method, created_at: `2026-10-15T00:00:0${i}Z`,
  }));
  return deriveAccount(pkg, invoices, payments, TODAY);
}

test("billing scenario: every hand-computed figure is what deriveAccount says", () => {
  for (const fam of BILLING_FAMILIES as Family[]) {
    const a = rowsFor(fam);
    const e = fam.expected;
    assert.deepEqual(a.invoices.map((i) => i.state), e.invoiceStates, `family ${fam.key} states`);
    assert.deepEqual(a.invoices.map((i) => i.paidCents), e.invoicePaidCents, `family ${fam.key} paid per invoice`);
    assert.equal(a.billedCents, e.billedCents);
    assert.equal(a.paidCents, e.paidCents);
    assert.equal(a.balanceCents, e.balanceCents);
    assert.equal(a.overdueCents, e.overdueCents);
    assert.equal(a.status, e.status);
    for (const inv of fam.invoices) assert.ok(inv.dueInDays >= -inv.issuedDaysAgo, "due_on >= issued_on (the table's CHECK)");
  }
});

test("billing scenario: voiding family A's second invoice leaves them paid up", () => {
  const fam = (BILLING_FAMILIES as Family[]).find((f) => f.key === "A")!;
  const a = rowsFor(fam, { voidSecond: true });
  const e = fam.expected.afterVoidingSecond!;
  assert.equal(a.billedCents, e.billedCents);
  assert.equal(a.balanceCents, e.balanceCents);
  assert.equal(a.overdueCents, e.overdueCents);
  assert.equal(a.status, e.status);
  assert.equal(a.invoices[1].state, "void");
  assert.equal(totals([a]).outstandingCents, 0, "a credit is not outstanding");
});

test("billing scenario: the totals strip is the two families added up", () => {
  const accounts = (BILLING_FAMILIES as Family[]).map((f) => rowsFor(f));
  assert.deepEqual(totals(accounts), BILLING_TOTALS);
});

test("shiftDate moves across month and year ends in whole days", () => {
  assert.equal(shiftDate("2026-10-15", -30), "2026-09-15");
  assert.equal(shiftDate("2026-12-28", 10), "2027-01-07");
  assert.equal(shiftDate("2028-03-01", -1), "2028-02-29");
});

test("local-only guard: this machine only, and never the production project", () => {
  for (const ok of ["http://127.0.0.1:54321", "http://localhost:4100", "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "http://[::1]:3000"]) {
    assert.equal(isLocalUrl(ok), true, ok);
  }
  for (const bad of [
    "https://kerstlpuvpmstiavxblv.supabase.co", "https://api.meridiesai.com", "postgresql://postgres:pw@db.example.com:5432/postgres",
    "http://127.0.0.1.nip.io:54321", "http://localhost.example.com", "file:///tmp/x", "", "not a url",
  ]) {
    assert.equal(isLocalUrl(bad), false, bad);
  }
  assert.doesNotThrow(() => assertLocalStack({ SUPABASE_URL: "http://127.0.0.1:54321", DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", API_URL: "http://127.0.0.1:4100" }));
  assert.throws(() => assertLocalStack({ SUPABASE_URL: "https://kerstlpuvpmstiavxblv.supabase.co" }), /production project/);
  assert.throws(() => assertLocalStack({ SUPABASE_URL: "http://127.0.0.1:54321", DB_URL: undefined }), /DB_URL is not set/);
  assert.throws(() => assertLocalStack({ API_URL: "https://api.meridiesai.com" }), /API_URL is not a localhost address/);
  // A local tunnel that still names the production project is refused too.
  assert.throws(() => assertLocalStack({ DB_URL: "postgresql://postgres.kerstlpuvpmstiavxblv:pw@127.0.0.1:6543/postgres" }), /production project/);
});

test("local-only guard: a postgres URL can't name another host through libpq keywords or a parser gap", () => {
  for (const bad of [
    // libpq reads these from the query string and they beat the URL's host.
    "postgresql://postgres:pw@127.0.0.1:5432/postgres?hostaddr=203.0.113.5",
    "postgresql://postgres:pw@localhost/postgres?host=203.0.113.5",
    "postgresql://postgres:pw@localhost/postgres?HOST=db.example.com",
    "postgresql://postgres:pw@localhost/postgres?h%6Fst=203.0.113.5",
    "postgresql://postgres:pw@localhost/postgres?service=prod",
    "postgresql://postgres:pw@localhost/postgres?sslmode=require&hostaddr=203.0.113.5",
    // libpq splits userinfo at the first "@" (WHATWG at the last) and reads "a,b" as two hosts.
    "postgresql://user@db.example.com@127.0.0.1/postgres",
    "postgresql://localhost,db.example.com/postgres",
    "postgresql://localhost/postgres%3Fhost%3Ddb.example.com",
  ]) {
    assert.equal(isLocalUrl(bad), false, bad);
  }
  for (const ok of ["postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable", "postgres://localhost/postgres", "postgresql://[::1]:5432/postgres"]) {
    assert.equal(isLocalUrl(ok), true, ok);
  }
  assert.throws(() => assertLocalStack({ DB_URL: "postgresql://postgres:pw@127.0.0.1:5432/postgres?hostaddr=203.0.113.5" }), /DB_URL is not a localhost address/);
});

test("psql runs without the libpq variables that could move its host", () => {
  const env = psqlEnv({ PATH: "/usr/bin", PGHOSTADDR: "203.0.113.5", PGHOST: "db.example.com", PGSERVICE: "prod", PGSERVICEFILE: "/tmp/x", PGSYSCONFDIR: "/tmp", PGCONNECT_TIMEOUT: "5" });
  for (const k of LIBPQ_HOST_ENV) assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.PGCONNECT_TIMEOUT, "5");
});
