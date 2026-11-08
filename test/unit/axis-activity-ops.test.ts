// Activity changes wait for Confirm, and one card holds several activities (AxIS activity drafts, plan Task 4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityRowLine } from "../../src/lib/axis/ops/catalog/application.js";
import { getOp, riskOf } from "../../src/lib/axis/ops/registry.js";
import { confirmOperation, newTurnBudget, runWrite, undoOperation, type OpContext, type OperationEvent } from "../../src/lib/axis/ops/run.js";
import { TRASH_COVERED } from "../../src/lib/axis/ops/trash.js";
import { fakeOpsRequest, type Injected } from "./axis-fakes.js";
import { sampleInput } from "./axis-op-samples.js";

type Row = Record<string, unknown>;
const ME = "c0000000-0000-4000-8000-000000000001";
const STUDENT = "50000000-0000-4000-8000-000000000001";
const tables = (): Record<string, Row[]> => ({ profiles: [{ id: STUDENT, counselor_id: ME }], axis_actions: [] });

function ctxFor(t: Record<string, Row[]>, o: { tainted?: boolean; answer?: (c: Injected) => { status: number; body: unknown } } = {}) {
  const { request, injected } = fakeOpsRequest(t, { userId: ME, answer: o.answer });
  const events: OperationEvent[] = [];
  const ctx: OpContext = {
    request, conversationId: "33333333-3333-4333-8333-333333333333", studentId: STUDENT,
    roster: { get: () => ({ name: "Avery Lee" }) }, turn: newTurnBudget(o.tainted ?? false), signal: new AbortController().signal,
    onOperation: (e) => events.push(e),
  };
  return { ctx, injected, events };
}

const row = (key: string, org: string, extra: Row = {}) => ({
  key, organization: org, position: "Cofounder", grade_levels: ["11"], timing: ["break"], hours_per_week: 6, weeks_per_year: 2,
  sources: { organization: "your message", position: "your message" }, read_as: { timing: "summer" }, ...extra,
});
const batchInput = (rows: Row[]) => ({ student_id: STUDENT, rows });

test("adding or changing an activity always waits for Confirm", () => {
  for (const n of ["application.add_activity", "application.update_activity", "application.add_activities", "application.delete_activities"]) {
    assert.equal(riskOf(getOp(n)!, sampleInput(n)), "confirm", n);
  }
  assert.ok(TRASH_COVERED.has("application.delete_activities"));
});

test("a card filed with outside set says outside-content and is recalled by operation only", async () => {
  const t = tables();
  const { ctx, events } = ctxFor(t);
  let filed: string | null = null;
  const out = await runWrite(ctx, "application.add_activities", batchInput([row("r1", "Code Club")]), { outside: true, onFiled: (id) => (filed = id) });
  assert.ok(!out.isError, out.content);
  const stored = t.axis_actions![0]!;
  assert.equal((stored.payload as Row).reason, "outside-content");
  assert.equal((stored.payload as Row).outside, true);
  assert.equal(stored.status, "pending");
  assert.equal(filed, stored.id);
  assert.equal(events[0]!.payload.reason, "outside-content");
});

test("without outside, a card in a clean turn has no reason", async () => {
  const t = tables();
  const { ctx } = ctxFor(t);
  await runWrite(ctx, "application.add_activities", batchInput([row("r1", "Code Club")]));
  assert.equal((t.axis_actions![0]!.payload as Row).reason, null);
});

test("in a tainted turn an activity card is outside-content even without the option", async () => {
  const t = tables();
  const { ctx } = ctxFor(t, { tainted: true });
  await runWrite(ctx, "application.add_activities", batchInput([row("r1", "Code Club")]), { outside: ctx.turn.tainted });
  assert.equal((t.axis_actions![0]!.payload as Row).reason, "outside-content");
});

test("the batch card shows every row on one line each, the description whole, and a row view for the app", async () => {
  const t = tables();
  const { ctx, events } = ctxFor(t);
  const desc = (i: number) => `${"Taught kids to build robots and code games. ".repeat(23)}Row ${i}.`.slice(0, 1000);
  const rows = Array.from({ length: 10 }, (_, i) => row(`r${i + 1}`, `Club ${i + 1}`, { description: desc(i), sources: { organization: "your message", description: "resume" } }));
  const out = await runWrite(ctx, "application.add_activities", batchInput(rows));
  assert.ok(!out.isError, out.content);
  const p = events[0]!.payload;
  assert.equal(p.details.length, 10);
  assert.ok(p.details.every((d) => !d.endsWith("…")), "no line is cut");
  assert.ok(p.details[3]!.includes(desc(3)), "the description is whole");
  assert.equal(p.rows?.length, 10);
  assert.deepEqual(p.rows?.map((r) => r.key), rows.map((r) => r.key));
  assert.equal(p.rows?.[0]?.description?.chars, 1000);
  assert.equal(p.rows?.[0]?.description?.source, "resume");
  assert.equal(p.rows?.[0]?.description?.overLimit, true);
  assert.ok(!("description" in (p.rows?.[0]?.fields ?? {})), "the row view never repeats the description text");
});

test("a row line names converted values, blanks and sources", () => {
  const line = activityRowLine(row("r1", "Code Club", { category: undefined }) as never);
  assert.equal(line, "Code Club · Cofounder · grades 11 · timing break (from 'summer') · 6 h/wk · 2 wk/yr · not given: category, continuing · sources: your message");
  const long = activityRowLine(row("r1", "Code Club", { description: "x".repeat(151), sources: { organization: "your message", description: "your message" } }) as never);
  assert.match(long, /description \(your message\): "x{151}" Over the Common App's 150-character limit\./);
});

test("the batch op never sends draft_row, key, sources or read_as to the route", () => {
  const def = getOp("application.add_activities")!;
  const call = def.request(batchInput([row("r1", "Code Club"), row("r2", "Debate Club")]));
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/application/activities/batch");
  const body = call.body as { studentId: string; rows: Row[] };
  assert.equal(body.studentId, STUDENT);
  for (const r of body.rows) for (const k of ["key", "sources", "read_as", "draft_row"]) assert.ok(!(k in r), k);
  const single = getOp("application.add_activity")!.request({ student_id: STUDENT, organization: "Code Club", draft_row: "r1" });
  assert.ok(!("draft_row" in (single.body as Row)));
});

const storedCard = (rows: Row[]) => ({ student_id: STUDENT, payload: { op: "application.add_activities", summary: "Add", input: batchInput(rows) } });
const okBatch = (c: Injected) => {
  const n = (JSON.parse(c.payload ?? "{}") as { rows?: unknown[] }).rows?.length ?? 0;
  return { status: 200, body: { results: Array.from({ length: n }, (_, i) => ({ ok: true, id: `a${i}` })) } };
};

test("Confirm keeps only the chosen rows, and without a choice keeps all", async () => {
  const three = [row("r1", "A Club"), row("r2", "B Club"), row("r3", "C Club")];
  const some = fakeOpsRequest(tables(), { userId: ME, answer: okBatch });
  const kept = await confirmOperation(some.request, storedCard(three), { keep: ["r1", "r3"] });
  assert.equal(kept.status, "confirmed");
  const sent = JSON.parse(some.injected.find((c) => c.method === "POST")!.payload!) as { rows: Row[] };
  assert.deepEqual(sent.rows.map((r) => r.organization), ["A Club", "C Club"]);
  assert.deepEqual(kept.status === "confirmed" ? kept.result.rows?.map((r) => r.key) : [], ["r1", "r3"]);

  const all = fakeOpsRequest(tables(), { userId: ME, answer: okBatch });
  await confirmOperation(all.request, storedCard(three));
  assert.equal((JSON.parse(all.injected.find((c) => c.method === "POST")!.payload!) as { rows: Row[] }).rows.length, 3);

  const none = fakeOpsRequest(tables(), { userId: ME, answer: okBatch });
  const bad = await confirmOperation(none.request, storedCard(three), { keep: ["r9"] });
  assert.equal(bad.status, "failed");
});

test("Confirm answers per row; a refused row doesn't stop the others; all refused is a failure", async () => {
  const two = [row("r1", "A Club"), row("r2", "B Club")];
  const mixed = fakeOpsRequest(tables(), {
    userId: ME,
    answer: () => ({ status: 200, body: { results: [{ ok: true, id: "a0000000-0000-4000-8000-000000000001" }, { ok: false, message: "A sheet holds at most 30 rows" }] } }),
  });
  const done = await confirmOperation(mixed.request, storedCard(two));
  assert.equal(done.status, "confirmed");
  if (done.status !== "confirmed") return;
  assert.deepEqual(done.result.rows, [{ key: "r1", ok: true, id: "a0000000-0000-4000-8000-000000000001" }, { key: "r2", ok: false, message: "A sheet holds at most 30 rows" }]);
  assert.deepEqual(done.result.undo, { op: "application.delete_activities", input: { student_id: STUDENT, activity_ids: ["a0000000-0000-4000-8000-000000000001"], only_unedited: true } });

  const refused = fakeOpsRequest(tables(), {
    userId: ME,
    answer: () => ({ status: 200, body: { results: [{ ok: false, message: "A sheet holds at most 30 rows" }, { ok: false, message: "other" }] } }),
  });
  const failed = await confirmOperation(refused.request, storedCard(two));
  assert.equal(failed.status, "failed");
  assert.equal(failed.status === "failed" ? failed.result.message : "", "A sheet holds at most 30 rows");
});

test("Undo of a batch card deletes exactly the rows it saved, unedited only, and returns the answer", async () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const { request, injected } = fakeOpsRequest(tables(), { userId: ME, answer: () => ({ status: 200, body: { deleted: 1, skipped: [{ id: ids[1], organization: "Art Club" }] } }) });
  const body = await undoOperation(request, { result: { undo: { op: "application.delete_activities", input: { student_id: STUDENT, activity_ids: ids, only_unedited: true } } } });
  assert.deepEqual(injected.map((c) => [c.method, decodeURIComponent(c.url)]), [["DELETE", `/application/activities?studentId=${STUDENT}&ids=${ids.join(",")}&onlyUnedited=true`]]);
  assert.deepEqual(body, { deleted: 1, skipped: [{ id: ids[1], organization: "Art Club" }] });
});

test("add_activity and update_activity take a description and a draft row key; update's Undo restores the description", () => {
  const add = getOp("application.add_activity")!;
  assert.ok(add.input.safeParse({ student_id: STUDENT, organization: "Code Club", description: "Taught kids.", draft_row: "r1" }).success);
  assert.ok(!add.input.safeParse({ student_id: STUDENT, draft_row: "r11" }).success);
  const upd = getOp("application.update_activity")!;
  const undo = upd.undo!({ student_id: STUDENT, activity_id: "a1", description: "New." }, {}, { id: "a1", description: "Old." });
  assert.deepEqual(undo, { op: "application.update_activity", input: { student_id: STUDENT, activity_id: "a1", description: "Old." } });
});
