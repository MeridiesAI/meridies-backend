// The push sweep with grouped student updates (migration 20261126100001): rows wait for push_after, staleness counts
// from it, a row already read in the app is never pushed, and the mark leaves a group the student changed meanwhile
// open. The database's filters are PostgREST strings, so the fake below records them; their wording is pinned here and
// they were checked against a real PostgREST.
import assert from "node:assert/strict";
import { test } from "node:test";

// hasPush is read when env.ts loads, so the keys go in before the module is imported (each test file is its own process).
process.env.VAPID_PUBLIC_KEY = "B".repeat(87);
process.env.VAPID_PRIVATE_KEY = "p".repeat(43);
process.env.VAPID_SUBJECT = "mailto:test@example.com";
const push = await import("../../src/lib/push.js");

type Row = Record<string, unknown>;
type Call = { table: string; op: "select" | "update" | "delete"; columns?: string; values?: Row; filters: unknown[][]; returning?: string };

function fakeSvc(opts: { due: Row[]; subs: Row[]; profiles: { id: string; role: string; approved: boolean }[]; stillDue?: (ids: string[]) => string[] }) {
  const calls: Call[] = [];
  const answer = (call: Call): { data: unknown; error: null } => {
    if (call.table === "notifications" && call.op === "select") return { data: opts.due, error: null };
    if (call.table === "notifications" && call.op === "update" && call.returning) {
      const ids = (call.filters.find((f) => f[0] === "in")?.[2] ?? []) as string[];
      return { data: (opts.stillDue ? opts.stillDue(ids) : ids).map((id) => ({ id })), error: null };
    }
    if (call.table === "push_subscriptions" && call.op === "select") return { data: opts.subs, error: null };
    if (call.table === "profiles" && call.columns === "id, role") return { data: opts.profiles.map(({ id, role }) => ({ id, role })), error: null };
    if (call.table === "profiles") return { data: opts.profiles.filter((p) => p.approved).map(({ id }) => ({ id })), error: null };
    return { data: null, error: null };
  };
  const chain = (call: Call) => {
    calls.push(call);
    const b: Record<string, unknown> = {};
    for (const m of ["is", "lt", "in", "eq", "not", "or", "order", "limit"]) {
      b[m] = (...args: unknown[]) => {
        call.filters.push([m, ...args]);
        return b;
      };
    }
    b.select = (cols: string) => {
      call.returning = cols;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer(call)).then(resolve, reject);
    return b;
  };
  const svc = {
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => ({
      select: (columns: string) => chain({ table, op: "select", columns, filters: [] }),
      update: (values: Row) => chain({ table, op: "update", values, filters: [] }),
      delete: () => chain({ table, op: "delete", filters: [] }),
    }),
  };
  return { svc: svc as never, calls };
}

const log = { warn() {}, info() {}, error() {} } as never;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const counselor = "c0000000-0000-4000-8000-000000000001";
const device = { id: "d1", user_id: counselor, endpoint: "https://push.example/1", p256dh: "k", auth: "a", channel: "web" };

test("the filters: due means no push_after or one that has passed; stale counts from push_after when there is one", () => {
  assert.equal(push.dueFilter("2026-11-15T12:00:00.000Z"), "push_after.is.null,push_after.lte.2026-11-15T12:00:00.000Z");
  assert.equal(
    push.staleFilter("2026-11-15T11:00:00.000Z"),
    "push_after.lt.2026-11-15T11:00:00.000Z,and(push_after.is.null,created_at.lt.2026-11-15T11:00:00.000Z)"
  );
});

test("a student update's push is the generic line: no name, no college, no file", () => {
  const p = push.payloadFor({ kind: "student-update", href: "/dashboard/counselor/students/1/college-list" });
  assert.equal(p.body, "A student updated their profile.");
  assert.equal(p.href, "/dashboard/counselor/students/1/college-list");
  const withWords = push.payloadFor({ kind: "student-update", title: "Maya added 3 colleges: Duke, NYU, Cornell", body: "Added: Duke." } as never);
  for (const word of ["Maya", "Duke", "NYU", "Cornell"]) assert.ok(!JSON.stringify(withWords).includes(word), word);
});

test("only an unread row is sent", () => {
  assert.equal(push.shouldSend({ read_at: null }), true);
  assert.equal(push.shouldSend({}), true);
  assert.equal(push.shouldSend({ read_at: "2026-11-15T11:59:00Z" }), false);
});

test("the sweep marks stale rows from push_after, reads only due rows, and pushes only what is unread", async () => {
  const due = [
    { id: "n1", recipient_id: counselor, kind: "student-update", href: "/dashboard/counselor/students/s1/college-list", created_at: "2026-11-15T11:30:00Z", read_at: null },
    { id: "n2", recipient_id: counselor, kind: "student-update", href: "/dashboard/counselor/students/s1/application", created_at: "2026-11-15T11:31:00Z", read_at: "2026-11-15T11:40:00Z" },
  ];
  const { svc, calls } = fakeSvc({ due, subs: [device], profiles: [{ id: counselor, role: "counselor", approved: true }] });
  const sent: unknown[] = [];
  const tally = await push.dispatchPush(svc, log, {
    now: () => NOW,
    send: async (_sub, payload) => {
      sent.push(payload);
      return "sent";
    },
  });

  const notif = calls.filter((c) => c.table === "notifications");
  // 1. stale rows: unpushed, and older than an hour counted from push_after (else created_at).
  assert.equal(notif[0].op, "update");
  assert.deepEqual(notif[0].filters, [
    ["is", "pushed_at", null],
    ["or", push.staleFilter("2026-11-15T11:00:00.000Z")],
  ]);
  // 2. the read: unpushed and due, oldest first.
  assert.equal(notif[1].op, "select");
  assert.ok(String(notif[1].columns).includes("read_at"));
  assert.deepEqual(notif[1].filters.slice(0, 2), [
    ["is", "pushed_at", null],
    ["or", push.dueFilter(NOW.toISOString())],
  ]);
  // 3. one push (n2 was read in the app), both rows handled.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { title: "Meridies", body: "A student updated their profile.", href: "/dashboard/counselor/students/s1/college-list" });
  const mark = notif[2];
  assert.equal(mark.op, "update");
  assert.deepEqual(mark.filters, [
    ["in", "id", ["n1", "n2"]],
    ["or", push.dueFilter(NOW.toISOString())],
  ]);
  assert.deepEqual(tally, { ran: true, handled: 2, pushed: 1, pruned: 0 });
});

test("a group the student changed during the run stays open: it is not counted as handled", async () => {
  const due = [{ id: "n1", recipient_id: counselor, kind: "student-update", href: "/x", created_at: "2026-11-15T11:30:00Z", read_at: null }];
  const { svc } = fakeSvc({ due, subs: [device], profiles: [{ id: counselor, role: "counselor", approved: true }], stillDue: () => [] });
  const tally = await push.dispatchPush(svc, log, { now: () => NOW, send: async () => "sent" });
  assert.equal(tally.pushed, 1);
  assert.equal(tally.handled, 0);
});

test("only read rows: nothing is sent and no device is looked up, the rows are still handled", async () => {
  const due = [{ id: "n1", recipient_id: counselor, kind: "student-update", href: "/x", created_at: "2026-11-15T11:30:00Z", read_at: "2026-11-15T11:35:00Z" }];
  const { svc, calls } = fakeSvc({ due, subs: [device], profiles: [{ id: counselor, role: "counselor", approved: true }] });
  let sends = 0;
  const tally = await push.dispatchPush(svc, log, {
    now: () => NOW,
    send: async () => {
      sends += 1;
      return "sent";
    },
  });
  assert.equal(sends, 0);
  assert.equal(calls.some((c) => c.table === "push_subscriptions"), false);
  assert.deepEqual(tally, { ran: true, handled: 1, pushed: 0, pruned: 0 });
});

test("a pending counselor still gets nothing", async () => {
  const due = [{ id: "n1", recipient_id: counselor, kind: "student-update", href: "/x", created_at: "2026-11-15T11:30:00Z", read_at: null }];
  const { svc } = fakeSvc({ due, subs: [device], profiles: [{ id: counselor, role: "counselor", approved: false }] });
  let sends = 0;
  const tally = await push.dispatchPush(svc, log, {
    now: () => NOW,
    send: async () => {
      sends += 1;
      return "sent";
    },
  });
  assert.equal(sends, 0);
  assert.equal(tally.handled, 1);
});
