// AxIS tool definitions (lib/axis/tools.ts): what the model is shown and what the tools accept. propose_action only
// drafts an email (a Work Queue item is perform_action work_queue.add), and rank_caseload takes the window the
// counselor asked about, as the fast path does ("this week").
import assert from "node:assert/strict";
import { test } from "node:test";
import { caseloadWindow, runTool, toolList, type ToolContext } from "../../src/lib/axis/tools.js";

const tools = toolList([], true);
const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `${name} is in the list`);
  return t;
};
const props = (name: string) => (tool(name).input_schema as { properties: Record<string, unknown> }).properties;

test("propose_action shows only the email draft: no work_item text, no due date", () => {
  const t = tool("propose_action");
  const json = JSON.stringify(t);
  assert.doesNotMatch(json, /work_item/);
  assert.doesNotMatch(json, /due_date/);
  assert.deepEqual(Object.keys(props("propose_action")).sort(), ["detail", "student_id", "title", "to", "type"]);
  assert.deepEqual((props("propose_action").type as { enum: string[] }).enum, ["email_draft"]);
});

// The run fails on its input before it touches the request, so a bare context is enough.
const bare = { memo: new Map() } as unknown as ToolContext;
const run = (name: string, input: unknown) => runTool(bare, name, input, new AbortController().signal);

test("propose_action refuses a work_item, and a due date is no longer part of its input", async () => {
  const out = await run("propose_action", { type: "work_item", title: "Call the Chens" });
  assert.equal(out.isError, true);
  assert.match(out.content, /^Invalid input: type /);
  const extra = await run("propose_action", { type: "email_draft", title: "", due_date: "2026-12-01" });
  // Fails on the empty title; due_date is ignored (zod strips unknown keys), never an error of its own.
  assert.match(extra.content, /title/);
  assert.doesNotMatch(extra.content, /due_date/);
});

test("rank_caseload takes an optional window in days", async () => {
  const days = props("rank_caseload").days as { type: string; description: string };
  assert.equal(days.type, "integer");
  assert.match(days.description, /this week/i);
  assert.deepEqual((tool("rank_caseload").input_schema as { required?: string[] }).required ?? [], []);
  for (const bad of [0, 61, 2.5, "7"]) {
    const out = await run("rank_caseload", { days: bad });
    assert.equal(out.isError, true, `days ${JSON.stringify(bad)} is refused`);
    assert.match(out.content, /^Invalid input: days /);
  }
});

test("the ranking's window: two weeks by default, said the way the fast path says it", () => {
  assert.deepEqual(caseloadWindow(undefined), { horizon: 14, span: "in the next 14 days" });
  assert.deepEqual(caseloadWindow(7), { horizon: 7, span: "in the next 7 days" });
  assert.deepEqual(caseloadWindow(1), { horizon: 1, span: "by tomorrow" });
  assert.deepEqual(caseloadWindow(60), { horizon: 60, span: "in the next 60 days" });
});

test("the tool order is fixed (the cached prompt prefix)", () => {
  assert.deepEqual(
    tools.map((t) => t.name),
    ["search_documents", "read_document", "find_student", "get_student_record", "list_upcoming", "rank_caseload", "search_colleges", "propose_action", "lookup", "perform_action"]
  );
});
