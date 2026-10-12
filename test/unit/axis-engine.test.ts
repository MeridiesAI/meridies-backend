import assert from "node:assert/strict";
import { test } from "node:test";
import { runAxisTurn, type Emit } from "../../src/lib/axis/engine.js";
import { AXIS_MODEL, PER_MESSAGE_EFFORT_BETA, resetFeatures } from "../../src/lib/axis/models.js";
import { fakeRequest, scriptedApi } from "./axis-fakes.js";

const ME = "counselor-1";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const TABLES = {
  profiles: [
    { id: "s1", full_name: "Sophia Martinez", counselor_id: ME, role: "student", archived_at: null, grad_year: 2027, high_school: "Lincoln High" },
    { id: "s2", full_name: "Ethan Park", counselor_id: ME, role: "student", archived_at: null, grad_year: 2027, high_school: "Lincoln High" },
  ],
  student_academics: [{ student_id: "s2", gpa_unweighted: 3.912, gpa_weighted: 4.31, gpa_scale: "4.0", sat_superscore: 1490, act_composite: null }],
  student_personal_details: [{ student_id: "s2", intended_majors: ["Mechanical Engineering"] }],
  colleges: [
    { id: "c1", name: "Cornell University", city: "Ithaca", state: "NY", website: "cornell.edu", search_name: "cornell university", search_aka_list: [], catalog_source: "meridies" },
    { id: "c2", name: "Brown University", city: "Providence", state: "RI", website: "brown.edu", search_name: "brown university", search_aka_list: [], catalog_source: "meridies" },
  ],
  college_stats: [
    { college_id: "c1", admit_rate: 0.073, sat_total_25: 1480, sat_total_75: 1560, act_25: 33, act_75: 35, avg_net_price: 31456, undergrad_enrollment: 15735, data_year: "2022-23", source_verified_at: new Date().toISOString() },
  ],
  deliverables: [
    { student_id: "s1", title: "Common App essay", status: "in-progress", due_date: day(-4), last_activity_at: new Date(Date.now() - 12 * 86_400_000).toISOString(), source: "counselor", visible_to_student: true },
    { student_id: "s2", title: "Activity list", status: "in-progress", due_date: day(9), last_activity_at: new Date().toISOString(), source: "counselor", visible_to_student: true },
  ],
  deadlines: [{ student_id: "s1", title: "Early decision application", school: "Cornell", type: "application", due_date: day(20), done: false }],
  red_flags: [],
  meetings: [],
  accountability_settings: [],
  practice_settings: [],
  "rpc:crm_my_workspace": [{ firm_id: null, is_admin: false }],
  ai_conversations: [{ id: "conv-1", summary: null, summary_through: null, state: null }],
  ai_messages: [{ conversation_id: "conv-1", role: "user", content: "placeholder", created_at: new Date().toISOString() }],
};

function collect() {
  const events: [string, unknown][] = [];
  const emit: Emit = (e, d) => events.push([e, d]);
  return { events, emit, text: () => events.filter(([e]) => e === "delta").map(([, d]) => (d as { text: string }).text).join("") };
}

async function turn(content: string, studentId: string | null, api = scriptedApi([{ text: "unused" }]).api) {
  const ev = collect();
  const res = await runAxisTurn({ request: fakeRequest(TABLES, ME), conversationId: "conv-1", studentId, content, emit: ev.emit, signal: new AbortController().signal, api });
  return { res, ...ev };
}

test("who is behind: ranked in code, no model call", async () => {
  const { api, calls } = scriptedApi([{ text: "should not be called" }]);
  const { res, text, events } = await turn("Who is behind this week?", null, api);
  assert.equal(res.path, "direct");
  assert.equal(calls.length, 0);
  assert.match(text(), /^Ranked by overdue work/);
  assert.match(text(), /1\. Sophia Martinez: "Common App essay" is 4 days overdue/);
  assert.deepEqual(events.find(([e]) => e === "route")?.[1], { intent: "roster", path: "direct", frame: "caseload-risk" });
});

test("a named student's GPA in a roster chat: answered from the row, exactly", async () => {
  const { res, text } = await turn("What's Ethan's GPA?", null);
  assert.equal(res.path, "direct");
  assert.equal(text(), "Ethan's GPA is 3.912 (4.0 scale) unweighted and 4.31 (4.0 scale) weighted.");
});

test("a school's admit rate: answered from the catalog with its data year and a citation", async () => {
  const { res, text, events } = await turn("What's Cornell's admit rate?", "s1");
  assert.equal(res.path, "direct");
  assert.equal(text(), "Cornell University admitted 7.3% of applicants (College Scorecard, 2022-23) [S1].");
  const cites = events.find(([e]) => e === "citations")?.[1] as { citations: { id: string; kind: string }[] };
  assert.deepEqual(cites.citations.map((c) => [c.id, c.kind]), [["S1", "catalog"]]);
});

test("a judgement goes to Haiku 5.5 with evidence gathered first, and the request is shaped for the cache", async () => {
  resetFeatures();
  const scripted = scriptedApi([{ text: "Cornell is a reach: her record is strong but the admit rate is 7.3% [S1]." }]);
  const { res, events } = await turn("Is Cornell realistic for her?", "s1", scripted.api);
  assert.equal(res.path, "agent");
  assert.equal(scripted.calls.length, 1, "the planner fetched Cornell's figures, so no tool round was needed");
  const p = scripted.calls[0]!.params;
  assert.equal(p.model, AXIS_MODEL);
  assert.equal(p.model, "claude-haiku-5-5");
  assert.deepEqual(p.thinking, { type: "adaptive" });
  assert.equal(p.output_config?.effort, "high", "pinned at the top level");
  assert.deepEqual(p.betas, [PER_MESSAGE_EFFORT_BETA]);
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  const system = p.system as { text: string; cache_control?: { ttl?: string } }[];
  assert.equal(system[0]!.cache_control?.ttl, "1h");
  assert.equal(system[1]!.cache_control?.ttl, "1h");
  assert.match(system[1]!.text, /^Today is \d{4}-\d{2}-\d{2}\./);
  assert.ok((p.tools ?? []).every((t) => "eager_input_streaming" in t && t.eager_input_streaming === true));
  const roles = p.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-3), ["system", "user", "system"], "effort before the question, mode after it");
  assert.deepEqual((p.messages.at(-3) as { output_config?: unknown }).output_config, { effort: "high" });
  assert.equal(p.messages.at(-1)!.content, "Mode: strategy.");
  assert.match(String(p.messages.at(-2)!.content), /\[S1\] \(catalog/);
  assert.deepEqual(events.find(([e]) => e === "route")?.[1], { intent: "strategy", path: "agent", mode: "strategy", effort: "high" });
  const grounding = events.filter(([e]) => e === "grounding").map(([, d]) => d as { status: string });
  assert.deepEqual(grounding.map((g) => g.status), ["grounded"]);
});

test("the same tool list and system prompt on every turn, so the cache holds", async () => {
  const a = scriptedApi([{ text: "One." }]);
  const b = scriptedApi([{ text: "Two." }]);
  await turn("How should we approach her list?", "s1", a.api);
  await turn("What are her biggest gaps?", "s1", b.api);
  assert.deepEqual(a.calls[0]!.params.tools, b.calls[0]!.params.tools);
  assert.deepEqual(a.calls[0]!.params.system, b.calls[0]!.params.system);
});

test("essay writing is refused into bullets, never sent to the free-text path", async () => {
  const scripted = scriptedApi([{ text: "should not be called" }]);
  const { res, text } = await turn("Write her Why Cornell essay", "s1", scripted.api);
  assert.equal(res.path, "essay");
  assert.equal(scripted.calls.length, 0);
  assert.match(text(), /^- I don't write essay text/);
});

test("a time the parser can't read keeps the question off the direct path", async () => {
  const scripted = scriptedApi([{ text: "Two things are due before Thanksgiving." }]);
  const { res } = await turn("anything due for her before thanksgiving", "s1", scripted.api);
  assert.equal(res.path, "agent");
  assert.equal(scripted.calls.length, 1);
});

test("a judgement about her GPA is not a lookup", async () => {
  const scripted = scriptedApi([{ text: "Her 3.912 is strong for Cornell." }]);
  const { res } = await turn("Is Ethan's GPA good enough for Cornell?", null, scripted.api);
  assert.equal(res.path, "agent");
});

// Last in the file: it registers ports, which are process-wide.
test("two parts the planner couldn't find go to specialists in parallel, then one streamed synthesis", async () => {
  const { registerConnectors, registerRetrieval } = await import("../../src/lib/axis/ports.js");
  registerRetrieval({ search: async () => [], read: async () => null });
  registerConnectors({ connected: async () => ["google"], searchMail: async () => [], searchFiles: async () => [] });
  const scripted = scriptedApi([
    { text: "- No reply found in the mailbox.\nNot found: a message about the CSS Profile." },
    { text: "- No junior-year transcript on file.\nNot found: the transcript." },
    { text: "I couldn't find either: no reply about the CSS Profile, and no junior-year transcript on file." },
  ]);
  const { res, events } = await turn("Did her mom reply about the Cornell CSS Profile, and what does her transcript show for junior year?", "s1", scripted.api);
  assert.equal(res.path, "specialists");
  assert.equal(scripted.calls.length, 3);
  const [first, second, synthesis] = scripted.calls.map((c) => c.params);
  for (const p of [first!, second!]) {
    const user = p.messages.find((m) => m.role === "user")!;
    const blocks = user.content as { type: string; text: string; cache_control?: unknown }[];
    assert.deepEqual(blocks[0]!.cache_control, { type: "ephemeral" }, "the shared evidence (Cornell's figures) is a cache breakpoint");
    assert.match(blocks[0]!.text, /Cornell University/);
    assert.equal(p.messages.at(-1)!.content.toString().startsWith("Mode: specialist."), true);
  }
  assert.deepEqual(first!.system, synthesis!.system, "specialists reuse the parent's exact prefix");
  assert.deepEqual(first!.tools, synthesis!.tools);
  assert.equal(synthesis!.messages.at(-1)!.content, "Mode: synthesis.");
  assert.match(String(synthesis!.messages.at(-2)!.content), /Specialist findings:/);
  const route = events.find(([e]) => e === "route")?.[1] as { path: string; parts: string[] };
  assert.deepEqual([route.path, route.parts], ["specialists", ["email", "documents"]]);
});
