// The activity draft's saved state (AxIS activity drafts, plan Task 5): header in `state`, rows in `draft_rows`,
// card statuses synced each turn, saves that never lose a concurrent turn's work, and the eval-only clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceClock, axisNow, evalClockRefusal } from "../../src/lib/axis/clock.js";
import {
  closeDraft,
  closeIfDone,
  dismissCards,
  isOpen,
  isStale,
  loadDraft,
  newRow,
  openDraft,
  resetDraftsReady,
  saveDraft,
  setStatus,
  setValue,
  syncCards,
  type DraftHeader,
} from "../../src/lib/axis/drafts/state.js";
import { loadHistory, saveState } from "../../src/lib/axis/memory.js";
import type { OperationEvent } from "../../src/lib/axis/ops/run.js";
import { fakeDb, fakeRequest } from "./axis-fakes.js";

type Row = Record<string, unknown>;
const ME = "counselor-1";
const CONV = "conv-1";
const T0 = "2026-11-08T12:00:00.000Z";
const header = (o: Partial<DraftHeader> = {}): DraftHeader => ({
  kind: "activity", student_id: "s1", student_name: "Avery Lee", opened_at: T0, updated_at: T0, opened_msg: "m1", ...o,
});
const dialogue = { students: [{ id: "s1", name: "Avery Lee" }], colleges: [], at: T0 };

function world(o: { draft?: DraftHeader; rows?: Row[]; actions?: Row[]; missing?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    ai_conversations: [{ id: CONV, owner_id: ME, updated_at: "v1", state: { ...dialogue, ...(o.draft ? { draft: o.draft } : {}) }, draft_rows: o.rows ?? null, summary: null, summary_through: null }],
    ai_messages: [],
    axis_actions: o.actions ?? [],
    "touch:updated_at": [{ table: "ai_conversations" }],
    ...(o.missing ? { "missing:columns": o.missing } : {}),
  };
  resetDraftsReady();
  return { tables, request: fakeRequest(tables, ME), db: fakeDb(tables) as never };
}
const row = (key: string, org: string, extra: Row = {}): Row => ({
  key, op: "add", fields: { organization: org }, sources: { organization: { label: "your message", outside: false } }, read_as: {}, status: "collecting", ...extra,
});

test("the draft header survives the state schema and the rows their own column", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club")] });
  const history = await loadHistory(w.request, CONV);
  assert.deepEqual(history.state?.draft, header());
  const d = await loadDraft(w.request, CONV);
  assert.equal(d.ready, true);
  assert.equal(d.version, "v1");
  assert.deepEqual(d.header, header());
  assert.equal(d.rows[0]?.fields.organization, "Code Club");
  assert.equal(isOpen(d), true);
  assert.equal(isStale(d, new Date(Date.parse(T0) + 29 * 60_000)), false);
  assert.equal(isStale(d, new Date(Date.parse(T0) + 31 * 60_000)), true);
});

test("rows that don't fit their schema are dropped on load", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club"), { key: "bogus" }] });
  assert.equal((await loadDraft(w.request, CONV)).rows.length, 1);
});

test("a confirmed card saves its rows with their new ids; a dismissed one closes the draft", async () => {
  const w = world({
    draft: header(),
    rows: [row("r1", "Code Club", { status: "card", card_id: "k1" }), row("r2", "Debate Club", { status: "card", card_id: "k2" })],
    actions: [
      { id: "k1", status: "confirmed", result: { ok: true, rows: [{ key: "r1", ok: true, id: "act-1" }] } },
      { id: "k2", status: "dismissed", result: null },
    ],
  });
  const d = await loadDraft(w.request, CONV);
  await syncCards(w.request, d);
  assert.equal(d.rows[0]!.status, "saved");
  assert.equal(d.rows[0]!.activity_id, "act-1");
  assert.equal(d.rows[1]!.status, "dismissed");
  assert.deepEqual(d.notes.map((n) => [n.kind, n.key]), [["saved", "r1"]]);
  closeIfDone(d);
  assert.equal(d.header, null);
  assert.deepEqual(d.rows, []);
});

test("a card confirmed with r1 only: r1 saved, r2 skipped", async () => {
  const w = world({
    draft: header(),
    rows: [row("r1", "A", { status: "card", card_id: "k1" }), row("r2", "B", { status: "card", card_id: "k1" })],
    actions: [{ id: "k1", status: "confirmed", result: { ok: true, rows: [{ key: "r1", ok: true, id: "act-1" }] } }],
  });
  const d = await loadDraft(w.request, CONV);
  await syncCards(w.request, d);
  assert.deepEqual(d.rows.map((r) => r.status), ["saved", "skipped"]);
});

test("a row the route refused is failed with the route's reason", async () => {
  const w = world({
    draft: header(),
    rows: [row("r1", "A", { status: "card", card_id: "k1" })],
    actions: [{ id: "k1", status: "failed", result: { ok: false, message: "A sheet holds at most 30 rows", rows: [{ key: "r1", ok: false, message: "A sheet holds at most 30 rows" }] } }],
  });
  const d = await loadDraft(w.request, CONV);
  await syncCards(w.request, d);
  assert.equal(d.rows[0]!.status, "failed");
  assert.equal(d.rows[0]!.message, "A sheet holds at most 30 rows");
  assert.deepEqual(d.notes.map((n) => [n.kind, n.key, n.reason]), [["failed", "r1", "A sheet holds at most 30 rows"]]);
});

test("a draft saves header and rows together, through the server's own client", async () => {
  const w = world();
  const d = await loadDraft(w.request, CONV);
  openDraft(d, header());
  setValue(d, newRow(d, "add"), "organization", "Code Club", { label: "your message", outside: false });
  assert.equal(await saveDraft(w.request, CONV, dialogue, d, w.db), true);
  const conv = w.tables.ai_conversations![0]!;
  assert.deepEqual((conv.state as Row).draft, header());
  assert.equal((conv.draft_rows as Row[])[0]!.key, "r1");
  assert.notEqual(conv.updated_at, "v1", "the write moved updated_at");
  assert.equal(d.version, conv.updated_at);
});

test("saving before the column exists keeps the state and reports the lost draft", async () => {
  const w = world({ missing: [{ table: "ai_messages", column: "outside_quotes" }, { table: "ai_conversations", column: "draft_rows" }] });
  const d = await loadDraft(w.request, CONV);
  assert.equal(d.ready, false);
  openDraft(d, header());
  setValue(d, newRow(d, "add"), "organization", "Code Club", { label: "your message", outside: false });
  assert.equal(await saveDraft(w.request, CONV, dialogue, d, w.db), false);
  const conv = w.tables.ai_conversations![0]!;
  assert.deepEqual((conv.state as Row).students, dialogue.students, "the dialogue state is still saved");
  assert.equal((conv.state as Row).draft, undefined);
});

test("a failed save answers false and never throws", async () => {
  const w = world();
  const d = await loadDraft(w.request, CONV);
  openDraft(d, header());
  const broken = { from: () => { throw new Error("db down"); } } as never;
  assert.equal(await saveDraft(w.request, CONV, dialogue, d, broken), false);
});

test("two concurrent turns adding different fields lose neither", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club")] });
  const a = await loadDraft(w.request, CONV);
  const b = await loadDraft(w.request, CONV);
  setValue(a, a.rows[0]!, "hours_per_week", 6, { label: "your message", outside: false });
  setValue(b, b.rows[0]!, "weeks_per_year", 2, { label: "your message", outside: false });
  assert.equal(await saveDraft(w.request, CONV, dialogue, a, w.db), true);
  assert.equal(await saveDraft(w.request, CONV, dialogue, b, w.db), true, "the second save reloads, merges and retries");
  const saved = (w.tables.ai_conversations![0]!.draft_rows as Row[])[0]!.fields as Row;
  assert.equal(saved.hours_per_week, 6);
  assert.equal(saved.weeks_per_year, 2);
  assert.equal(saved.organization, "Code Club");
});

test("two concurrent turns that each start a new row keep both, under different keys", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club")] });
  const a = await loadDraft(w.request, CONV);
  const b = await loadDraft(w.request, CONV);
  setValue(a, newRow(a, "add"), "organization", "Debate Club", { label: "your message", outside: false });
  setValue(b, newRow(b, "add"), "organization", "Chess Club", { label: "your message", outside: false });
  await saveDraft(w.request, CONV, dialogue, a, w.db);
  await saveDraft(w.request, CONV, dialogue, b, w.db);
  const rows = w.tables.ai_conversations![0]!.draft_rows as Row[];
  assert.deepEqual(rows.map((r) => [r.key, (r.fields as Row).organization]), [["r1", "Code Club"], ["r2", "Debate Club"], ["r3", "Chess Club"]]);
});

test("a header field one turn changed survives another turn's save", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club")] });
  const a = await loadDraft(w.request, CONV);
  const b = await loadDraft(w.request, CONV);
  a.header!.asked = { at: T0, fields: ["hours_per_week"], after_msg: "m2" };
  (await import("../../src/lib/axis/drafts/state.js")).touchHeader(a, "asked");
  setStatus(b, b.rows[0]!, "card", { card_id: "k9" });
  await saveDraft(w.request, CONV, dialogue, a, w.db);
  await saveDraft(w.request, CONV, dialogue, b, w.db);
  const conv = w.tables.ai_conversations![0]!;
  assert.deepEqual(((conv.state as Row).draft as Row).asked, { at: T0, fields: ["hours_per_week"], after_msg: "m2" });
  assert.equal((conv.draft_rows as Row[])[0]!.card_id, "k9");
});

test("dismissing cards touches only pending ones, tells the app, and answers how many", async () => {
  const w = world({
    actions: [
      { id: "k1", status: "pending", student_id: "s1", payload: { op: "application.add_activities", area: "Sheets", summary: "Add", details: ["Code Club"], warning: null, reason: null, input: { secret: true } } },
      { id: "k2", status: "confirmed", student_id: "s1", payload: { op: "application.add_activities", summary: "Add", details: [], input: {} } },
    ],
  });
  const events: OperationEvent[] = [];
  const d = await loadDraft(w.request, CONV);
  const n = await dismissCards({ request: w.request, onOperation: (e) => events.push(e) }, d, ["k1", "k2"], "Replaced by an updated card.");
  assert.equal(n, 1);
  assert.equal(w.tables.axis_actions![0]!.status, "dismissed");
  assert.equal(w.tables.axis_actions![1]!.status, "confirmed");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.status, "dismissed");
  assert.equal(events[0]!.payload.message, "Replaced by an updated card.");
  assert.ok(!("input" in events[0]!.payload), "the app never gets the stored input");
});

test("clock mode: off without the flag; refuses production, a remote project, any non-local host; on with a local stack", () => {
  assert.equal(evalClockRefusal({}), null);
  assert.match(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "production", SUPABASE_URL: "http://127.0.0.1:54321" })!, /refusing to start/);
  assert.match(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development", SUPABASE_URL: "https://abcdefghij.supabase.co" })!, /refusing to start/);
  assert.match(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development", SUPABASE_URL: "https://staging.example.com" })!, /refusing to start/);
  assert.match(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development" })!, /refusing to start/);
  assert.equal(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development", SUPABASE_URL: "http://127.0.0.1:54321" }), null);
  assert.equal(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "test", SUPABASE_URL: "http://localhost:54321" }), null);
  assert.equal(evalClockRefusal({ AXIS_EVAL_CLOCK: "on", NODE_ENV: "development", SUPABASE_URL: "http://host.docker.internal:54321" }), null);
  assert.throws(() => advanceClock(60_000), /eval clock/, "the flag is off in tests");
  assert.ok(Math.abs(axisNow().getTime() - Date.now()) < 1000, "no offset without the flag");
});

test("a turn that closed a finished draft doesn't erase a new draft another turn opened meanwhile (finding E i)", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club", { status: "saved", activity_id: "a1" })] });
  const a = await loadDraft(w.request, CONV);
  const b = await loadDraft(w.request, CONV);
  closeDraft(b);
  openDraft(b, header({ opened_at: "2026-11-08T12:05:00.000Z", updated_at: "2026-11-08T12:05:00.000Z" }));
  setValue(b, newRow(b, "add"), "organization", "Debate Club", { label: "your message", outside: false });
  assert.equal(await saveDraft(w.request, CONV, dialogue, b, w.db), true);
  closeIfDone(a);
  assert.equal(await saveDraft(w.request, CONV, dialogue, a, w.db), true);
  const conv = w.tables.ai_conversations![0]!;
  assert.equal(((conv.state as Row).draft as Row)?.opened_at, "2026-11-08T12:05:00.000Z", "B's new draft survives");
  assert.equal(((conv.draft_rows as Row[])[0]!.fields as Row).organization, "Debate Club");
});

test("a turn that only touched a draft another turn cancelled doesn't bring it back (finding E ii)", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club")] });
  const a = await loadDraft(w.request, CONV);
  const b = await loadDraft(w.request, CONV);
  closeDraft(b);
  assert.equal(await saveDraft(w.request, CONV, dialogue, b, w.db), true);
  setValue(a, a.rows[0]!, "hours_per_week", 6, { label: "your message", outside: false });
  await saveDraft(w.request, CONV, dialogue, a, w.db);
  const conv = w.tables.ai_conversations![0]!;
  assert.equal((conv.state as Row).draft, undefined, "the cancelled draft stays cancelled");
  assert.equal(conv.draft_rows, null);
});

test("a save retries past two writes that landed first", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club")] });
  const d = await loadDraft(w.request, CONV);
  setValue(d, d.rows[0]!, "hours_per_week", 6, { label: "your message", outside: false });
  let bumps = 2;
  const inner = w.db as unknown as { from(t: string): Record<string, unknown> };
  const racy = {
    from(t: string) {
      if (t === "ai_conversations" && bumps > 0) {
        bumps--;
        w.tables.ai_conversations![0]!.updated_at = `bumped-${bumps}`;
      }
      return inner.from(t);
    },
  };
  assert.equal(await saveDraft(w.request, CONV, dialogue, d, racy as never), true);
  assert.equal(((w.tables.ai_conversations![0]!.draft_rows as Row[])[0]!.fields as Row).hours_per_week, 6);
});

test("the route's after-done state write never lands on a conversation another turn changed (finding D)", async () => {
  const w = world({ draft: header(), rows: [row("r1", "Code Club")] });
  const history = await loadHistory(w.request, CONV);
  assert.equal(history.version, "v1");
  // Another turn saved a draft header after this turn read the conversation.
  Object.assign(w.tables.ai_conversations![0]!, { updated_at: "v2" });
  await saveState(w.request, CONV, { ...dialogue }, history.version);
  assert.deepEqual(((w.tables.ai_conversations![0]!.state as Row).draft as Row)?.student_id, "s1", "the header is still there");
  await saveState(w.request, CONV, { ...dialogue, at: "2026-11-08T12:30:00.000Z" }, "v2");
  assert.equal((w.tables.ai_conversations![0]!.state as Row).at, "2026-11-08T12:30:00.000Z", "a write on the version it read lands");
});

test("a Confirm still running (claimed, no result yet) is left for the next turn, never read as saved (final #1)", async () => {
  const w = world({
    draft: header(),
    rows: [row("r1", "Code Club", { status: "card", card_id: "k1" })],
    actions: [{ id: "k1", status: "confirmed", result: null }],
  });
  const d = await loadDraft(w.request, CONV);
  await syncCards(w.request, d);
  assert.equal(d.rows[0]!.status, "card");
  assert.deepEqual(d.notes, []);
});

test("long labels and phrases are clipped on the way in, so a row never fails its own schema on the next load (final #3)", async () => {
  const w = world();
  const d = await loadDraft(w.request, CONV);
  openDraft(d, header());
  const r = newRow(d, "add");
  setValue(d, r, "organization", "Code Club", { label: `${"Very long file name ".repeat(8)}.pdf`, outside: true }, "x".repeat(250));
  r.label = "L".repeat(300);
  assert.equal(await saveDraft(w.request, CONV, dialogue, d, w.db), true);
  const again = await loadDraft(w.request, CONV);
  assert.equal(again.rows.length, 1, "the row survives its next load");
});
