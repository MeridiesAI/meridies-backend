import assert from "node:assert/strict";
import { test } from "node:test";
import { PURGE_BATCH, PURGE_RECLAIM_MS, pickDue, runClosurePurge } from "../../src/lib/accountClosure.js";
import { DeletionFailed, type DeletionSubject } from "../../src/lib/accountDeletion.js";

// An in-memory stand-in for the service client: enough of PostgREST's builder for the purge and deletionBlocker
// (select/update/insert, eq/is/in/lte, maybeSingle, count) over plain arrays, with an `updated_at` bump on update
// like the table's trigger.

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Hooks = { beforeUpdate?: (table: string, values: Row, tables: Tables) => void; leaseOk?: boolean; auditError?: (row: Row) => boolean };

function memorySvc(tables: Tables, hooks: Hooks = {}) {
  let tick = 0;
  const rpcs: string[] = [];
  const client = {
    rpc: async (name: string) => {
      rpcs.push(name);
      return name === "acquire_job_lease" ? { data: hooks.leaseOk ?? true, error: null } : { data: null, error: null };
    },
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let values: Row = {};
      let head = false;
      let returning = false;
      const rows = () => (tables[table] ??= []);
      const run = () => {
        if (op === "insert") {
          const bad = table === "audit_log" && hooks.auditError?.(values);
          if (bad) return { data: null, error: { code: "42501", message: "denied" }, count: null };
          rows().push({ ...values });
          return { data: null, error: null, count: null };
        }
        const hit = rows().filter((r) => preds.every((p) => p(r)));
        if (op === "update") {
          hooks.beforeUpdate?.(table, values, tables);
          const still = rows().filter((r) => preds.every((p) => p(r)));
          for (const r of still) Object.assign(r, values, { updated_at: new Date(Date.parse("2026-11-08T00:00:00Z") + ++tick).toISOString() });
          return { data: returning ? still.map((r) => ({ ...r })) : null, error: null, count: null };
        }
        return { data: head ? null : hit.map((r) => ({ ...r })), error: null, count: hit.length };
      };
      const b: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (op === "update") returning = true;
          head = Boolean(opts?.head);
          return b;
        },
        update: (v: Row) => ((op = "update"), (values = v), b),
        insert: (v: Row) => ((op = "insert"), (values = v), b),
        eq: (col: string, v: unknown) => (preds.push((r) => r[col] === v), b),
        is: (col: string, v: unknown) => (preds.push((r) => (r[col] ?? null) === v), b),
        in: (col: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[col])), b),
        lte: (col: string, v: string) => (preds.push((r) => Date.parse(String(r[col])) <= Date.parse(v)), b),
        order: () => b,
        limit: () => b,
        maybeSingle: async () => {
          const r = run();
          return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data };
        },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
      };
      return b;
    },
  };
  return { svc: client as never, rpcs };
}

const log = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-11-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function closure(id: string, o: Partial<Row> = {}): Row {
  return { counselor_id: id, status: "pending", requested_at: ago(31 * 86_400_000), purge_after: ago(86_400_000), updated_at: ago(31 * 86_400_000), last_error: null, ...o };
}
const counselorRow = (id: string, o: Partial<Row> = {}): Row => ({ id, role: "counselor", firm_id: null, counselor_id: null, archived_at: null, ...o });

function world(extra: Partial<Tables> = {}): Tables {
  return { account_closures: [], profiles: [], audit_log: [], firms: [], practice_stripe_accounts: [], agreements: [], ...extra };
}

/** A purge whose deletion and revoke are stand-ins that record what they were asked. */
async function purge(tables: Tables, hooks: Hooks = {}, failDelete = false) {
  const removed: string[] = [];
  const revoked: string[] = [];
  const { svc, rpcs } = memorySvc(tables, hooks);
  const out = await runClosurePurge(svc, log, {
    enabled: true,
    now: NOW,
    revoke: async (id) => {
      revoked.push(id);
      return ["google"];
    },
    remove: async (who: DeletionSubject) => {
      if (failDelete) throw new DeletionFailed("auth-user");
      removed.push(who.id);
      tables.profiles = tables.profiles!.filter((p) => p.id !== who.id);
      tables.account_closures = tables.account_closures!.filter((r) => r.counselor_id !== who.id);
    },
  });
  return { out, removed, revoked, rpcs };
}
const actions = (t: Tables, id: string) => t.audit_log!.filter((a) => a.entity_id === id).map((a) => a.action);

test("disabled: nothing is read, nothing is deleted", async () => {
  const t = world({ account_closures: [closure("a")], profiles: [counselorRow("a")] });
  const { svc, rpcs } = memorySvc(t);
  const out = await runClosurePurge(svc, log, { enabled: false, remove: async () => assert.fail("must not delete") });
  assert.deepEqual(out, { ran: false, reason: "purge_disabled" });
  assert.equal(rpcs.length, 0);
});

test("a due closure is claimed, recorded, its connections revoked, then deleted", async () => {
  const t = world({ account_closures: [closure("a")], profiles: [counselorRow("a")] });
  const order: string[] = [];
  const { svc } = memorySvc(t);
  const out = await runClosurePurge(svc, log, {
    enabled: true,
    now: NOW,
    revoke: async () => {
      order.push(`revoke after ${actions(t, "a").join(",")}`);
      return ["google"];
    },
    remove: async () => {
      order.push("remove");
    },
  });
  assert.deepEqual(out, { ran: true, due: 1, purged: 1, blocked: 0, failed: 0, skipped: 0 });
  assert.deepEqual(order, ["revoke after account.closure.purging", "remove"]);
  assert.deepEqual(actions(t, "a"), ["account.closure.purging", "account.closure.purged"]);
  assert.deepEqual(t.audit_log!.at(-1)!.metadata, { role: "counselor", connectionsRevoked: ["google"] });
});

test("a cancel that lands before the claim wins: skipped, nothing deleted or revoked", async () => {
  const t = world({ account_closures: [closure("a")], profiles: [counselorRow("a")] });
  const { out, removed, revoked } = await purge(t, {
    beforeUpdate: (table, values, tables) => {
      if (table === "account_closures" && values.status === "purging") tables.account_closures![0]!.status = "cancelled";
    },
  });
  assert.equal(out.ran && out.skipped, 1);
  assert.deepEqual(removed, []);
  assert.deepEqual(revoked, []);
  assert.equal(t.account_closures![0]!.status, "cancelled");
});

test("a row stuck in purging is taken again only after PURGE_RECLAIM_MS", async () => {
  const fresh = world({ account_closures: [closure("a", { status: "purging", updated_at: ago(PURGE_RECLAIM_MS - 1000) })], profiles: [counselorRow("a")] });
  const r1 = await purge(fresh);
  assert.equal(r1.out.ran && r1.out.due, 0);
  assert.deepEqual(r1.removed, []);

  const stale = world({ account_closures: [closure("a", { status: "purging", updated_at: ago(PURGE_RECLAIM_MS + 1000) })], profiles: [counselorRow("a")] });
  const r2 = await purge(stale);
  assert.deepEqual(r2.removed, ["a"]);
});

test("a deletion that fails leaves the account, marks the row failed with a reason", async () => {
  const t = world({ account_closures: [closure("a")], profiles: [counselorRow("a")] });
  const { out } = await purge(t, {}, true);
  assert.equal(out.ran && out.failed, 1);
  assert.equal(t.profiles!.length, 1);
  assert.equal(t.account_closures![0]!.status, "failed");
  assert.match(String(t.account_closures![0]!.last_error), /couldn't be deleted \(auth-user\)/);
  assert.deepEqual(actions(t, "a"), ["account.closure.purging", "account.closure.failed"]);
});

test("if the purging audit row can't be written, nothing is deleted", async () => {
  const t = world({ account_closures: [closure("a")], profiles: [counselorRow("a")] });
  const { out, removed, revoked } = await purge(t, { auditError: (row) => row.action === "account.closure.purging" });
  assert.equal(out.ran && out.failed, 1);
  assert.deepEqual(removed, []);
  assert.deepEqual(revoked, []);
  assert.equal(t.account_closures![0]!.status, "failed");
});

test("another runner holds the lease: locked, nothing read", async () => {
  const t = world({ account_closures: [closure("a")], profiles: [counselorRow("a")] });
  const { out, removed } = await purge(t, { leaseOk: false });
  assert.deepEqual(out, { ran: false, reason: "locked" });
  assert.deepEqual(removed, []);
});

test("at most PURGE_BATCH a run, oldest due first", async () => {
  const ids = ["g", "f", "e", "d", "c", "b", "a"];
  const t = world({
    account_closures: ids.map((id, i) => closure(id, { purge_after: ago((i + 1) * 3_600_000) })), // "a" is the oldest
    profiles: ids.map((id) => counselorRow(id)),
  });
  const { removed } = await purge(t);
  assert.equal(PURGE_BATCH, 5);
  assert.deepEqual(removed, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(t.account_closures!.map((r) => r.counselor_id).sort(), ["f", "g"]);
});

test("pickDue: not yet due and cancelled rows are never taken", () => {
  const rows = [
    closure("future", { purge_after: new Date(NOW.getTime() + 1000).toISOString() }),
    closure("cancelled", { status: "cancelled" }),
    closure("failed", { status: "failed" }),
    closure("due"),
  ] as never[];
  assert.deepEqual(pickDue(rows, NOW).map((r: { counselor_id: string }) => r.counselor_id), ["due"]);
});

test("a profile that isn't a counselor is failed, never deleted", async () => {
  const t = world({ account_closures: [closure("s")], profiles: [counselorRow("s", { role: "student" })] });
  const { out, removed } = await purge(t);
  assert.equal(out.ran && out.blocked, 1);
  assert.deepEqual(removed, []);
  assert.equal(t.account_closures![0]!.status, "failed");
  assert.match(String(t.account_closures![0]!.last_error), /Only a counselor/);
});

test("a precondition that fails at purge time holds the account (failed, reason kept)", async () => {
  const t = world({
    account_closures: [closure("a")],
    profiles: [counselorRow("a"), { id: "kid", role: "student", counselor_id: "a", archived_at: null, firm_id: null }],
  });
  const { out, removed } = await purge(t);
  assert.equal(out.ran && out.blocked, 1);
  assert.deepEqual(removed, []);
  assert.match(String(t.account_closures![0]!.last_error), /still have 1 student/);
  assert.deepEqual(actions(t, "a"), ["account.closure.blocked"]);
});
