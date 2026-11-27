// The tool-call evals (evals/axis/tool-calls.mjs): the scorer on fake model output, and the cases themselves checked
// against the real tool list and operation catalog, so a renamed tool, operation or input key fails here, not in a
// paid run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDS, TOOL_CASES } from "../../evals/axis/tool-call-cases.mjs";
import { at, callMatches, meets, scoreToolCalls, settled } from "../../evals/axis/tool-call-score.mjs";
import { getOp, READ_OPS, WRITE_OPS } from "../../src/lib/axis/ops/registry.js";
import { toolList } from "../../src/lib/axis/tools.js";

type Call = { name: string; input: Record<string, unknown> };
type Want = { tool: string; input?: Record<string, unknown> };
type Case = { id: string; say: string; chat?: string; mode?: string; expect: Want | Want[]; never?: Want[] };
const CASES = TOOL_CASES as Case[];
const byId = (id: string) => CASES.find((c) => c.id === id)!;
const op = (action: string, input: Record<string, unknown> = {}): Call => ({ name: "perform_action", input: { action, input } });

test("matchers: value, RegExp, function, absent", () => {
  assert.equal(meets(7, 7), true);
  assert.equal(meets(7, "7"), false);
  assert.equal(meets(/chen/i, "Call the Chens"), true);
  assert.equal(meets(/chen/i, undefined), false);
  assert.equal(meets((v: unknown) => v === 3, 3), true);
  assert.equal(meets(undefined, undefined), true);
  assert.equal(meets(undefined, "x"), false);
  assert.equal(at({ input: { title: "x" } }, "input.title"), "x");
  assert.equal(at({ input: null }, "input.title"), undefined);
});

test("a run passes on the expected operation with its key input", () => {
  const c = byId("deadline-move");
  assert.deepEqual(scoreToolCalls(c, [{ name: "lookup", input: { what: "deadlines.list", input: {} } }, op("deadlines.update", { deadline_id: IDS.deadlineSat, due_date: "2026-12-05" })]).score, 1);
  // The wrong deadline, the wrong date, or the wrong operation fails.
  assert.equal(scoreToolCalls(c, [op("deadlines.update", { deadline_id: IDS.deadlineEssay, due_date: "2026-12-05" })]).score, 0);
  assert.equal(scoreToolCalls(c, [op("deadlines.update", { deadline_id: IDS.deadlineSat, due_date: "2026-12-06" })]).score, 0);
  const wrong = scoreToolCalls(c, [op("deadlines.delete", { deadline_id: IDS.deadlineSat })]);
  assert.equal(wrong.score, 0);
  assert.match(wrong.note, /^got perform_action deadlines\.delete/);
});

test("no tool call scores 0", () => {
  assert.deepEqual(scoreToolCalls(byId("pin"), []), { score: 0, note: "no tool call" });
});

test("a forbidden call fails the run even when the expected one is there too", () => {
  const c = byId("queue-add");
  const good = op("work_queue.add", { title: "Call the Chens about ED", due_date: "2026-12-03" });
  assert.equal(scoreToolCalls(c, [good]).score, 1);
  const r = scoreToolCalls(c, [{ name: "propose_action", input: { type: "email_draft", title: "Call the Chens" } }, good]);
  assert.equal(r.score, 0);
  assert.match(r.note, /^forbidden call: propose_action/);
});

test("any of several expectations passes; a read case fails on a write", () => {
  const c = byId("other-student-record");
  assert.equal(scoreToolCalls(c, [{ name: "find_student", input: { name: "Jordan Alvarez" } }]).score, 1);
  assert.equal(scoreToolCalls(c, [{ name: "find_student", input: { name: "Priya" } }]).score, 0);
  const rank = byId("rank-this-week");
  assert.equal(scoreToolCalls(rank, [{ name: "rank_caseload", input: { days: 7 } }]).score, 1);
  assert.equal(scoreToolCalls(rank, [{ name: "rank_caseload", input: {} }]).score, 0, "this week must pass a window");
  assert.equal(scoreToolCalls(rank, [{ name: "rank_caseload", input: { days: 7 } }, op("students.set_status", { status: "at-risk" })]).score, 0);
});

test("an email draft to the parents may leave `to` out (the default)", () => {
  const c = byId("email-parents");
  assert.equal(scoreToolCalls(c, [{ name: "propose_action", input: { type: "email_draft", title: "CSS Profile" } }]).score, 1);
  assert.equal(scoreToolCalls(c, [{ name: "propose_action", input: { type: "email_draft", title: "CSS Profile", to: "student" } }]).score, 0);
});

test("settled: stop after a pass or a change, keep going after a lookup", () => {
  const c = byId("deadline-delete");
  assert.equal(settled(c, [{ name: "lookup", input: { what: "deadlines.list" } }]), false);
  assert.equal(settled(c, [{ name: "lookup", input: { what: "deadlines.list" } }, op("deadlines.delete", { deadline_id: "x" })]), true);
  assert.equal(settled(byId("other-student-record"), [{ name: "find_student", input: { name: "Jordan" } }]), true);
});

// ---- The cases against the real tools and catalog ----

const TOOLS = new Map(toolList([], true).map((t) => [t.name, t]));
const writes = new Set<string>(WRITE_OPS);
const reads = new Set<string>(READ_OPS);

test("about forty cases, unique ids, each with a message", () => {
  assert.ok(CASES.length >= 38 && CASES.length <= 50, `${CASES.length} cases`);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const c of CASES) assert.ok(c.say.trim().length > 5, c.id);
  assert.ok(CASES.filter((c) => [c.expect].flat().some((w) => w.tool === "perform_action")).length >= 25, "mostly perform_action");
});

test("every expected tool, operation and input key is real", () => {
  for (const c of CASES) {
    for (const w of [...[c.expect].flat(), ...(c.never ?? [])]) {
      const tool = TOOLS.get(w.tool);
      assert.ok(tool, `${c.id}: no tool ${w.tool}`);
      const action = w.input?.action;
      if (w.tool === "perform_action" && typeof action === "string") {
        assert.ok(writes.has(action), `${c.id}: no write operation ${action}`);
        const doc = getOp(action)!.doc;
        for (const path of Object.keys(w.input ?? {}).filter((p) => p.startsWith("input."))) {
          const key = path.slice("input.".length);
          assert.match(doc, new RegExp(`\\b${key}\\b`), `${c.id}: ${action} takes no ${key}`);
        }
      } else if (w.tool === "lookup" && typeof w.input?.what === "string") {
        assert.ok(reads.has(w.input.what), `${c.id}: no lookup ${w.input.what}`);
      } else {
        const props = Object.keys((tool!.input_schema as { properties?: Record<string, unknown> }).properties ?? {});
        for (const path of Object.keys(w.input ?? {})) assert.ok(props.includes(path.split(".")[0]!), `${c.id}: ${w.tool} takes no ${path}`);
      }
    }
  }
});

test("a case's own expectation is reachable (it matches a call built from it)", () => {
  // A literal-only expectation must match the call it describes, so a typo in a matcher can't make a case unpassable.
  for (const c of CASES) {
    for (const w of [c.expect].flat()) {
      const lits = Object.entries(w.input ?? {}).filter(([, m]) => !(m instanceof RegExp) && typeof m !== "function" && m !== undefined);
      if (lits.length !== Object.keys(w.input ?? {}).length) continue;
      const input: Record<string, unknown> = {};
      for (const [path, v] of lits) {
        const keys = path.split(".");
        let o = input;
        for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
        o[keys.at(-1)!] = v;
      }
      assert.ok(callMatches(w, { name: w.tool, input }), c.id);
    }
  }
});
