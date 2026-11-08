// Whole AxIS turns for the activity-draft suites: a fake database, a scripted model, the draft saved through an
// injected server client, and each turn saved the way the route saves it. Not a test file itself.
import type { FastifyRequest } from "fastify";
import { runAxisTurn, type Emit } from "../../src/lib/axis/engine.js";
import { resetDraftsReady } from "../../src/lib/axis/drafts/state.js";
import { resetFlagsReadyForTest } from "../../src/lib/axis/failsafe.js";
import { fakeDb, fakeOpsRequest, nextStamp, scriptedApi, type Turn } from "./axis-fakes.js";

export type Row = Record<string, unknown>;
export const ME = "counselor-1";
export const CONV = "conv-1";
export const ETHAN = "50000000-0000-4000-8000-000000000002";
export const SOPHIA = "50000000-0000-4000-8000-000000000001";

export function world(o: { draftDb?: unknown } = {}) {
  resetDraftsReady();
  resetFlagsReadyForTest?.();
  const tables: Record<string, Row[]> = {
    profiles: [
      { id: SOPHIA, full_name: "Sophia Martinez", counselor_id: ME, role: "student", archived_at: null, grad_year: 2027, high_school: "Lincoln High" },
      { id: ETHAN, full_name: "Ethan Park", counselor_id: ME, role: "student", archived_at: null, grad_year: 2027, high_school: "Lincoln High" },
    ],
    student_academics: [{ student_id: ETHAN, gpa_unweighted: 3.912, gpa_weighted: 4.31, gpa_scale: "4.0", sat_superscore: 1490, act_composite: null }],
    student_personal_details: [],
    colleges: [
      { id: "c1", name: "Cornell University", city: "Ithaca", state: "NY", website: "cornell.edu", search_name: "cornell university", search_aka_list: [], catalog_source: "meridies" },
      { id: "c3", name: "Santa Clara University", city: "Santa Clara", state: "CA", website: "scu.edu", search_name: "santa clara university", search_aka_list: [], catalog_source: "meridies" },
    ],
    college_stats: [{ college_id: "c3", admit_rate: 0.5, data_year: "2022-23", source_verified_at: new Date().toISOString() }],
    deliverables: [], deadlines: [], red_flags: [], meetings: [], accountability_settings: [], practice_settings: [],
    "rpc:crm_my_workspace": [{ firm_id: null, is_admin: false }],
    ai_conversations: [{ id: CONV, owner_id: ME, summary: null, summary_through: null, state: null, draft_rows: null, updated_at: "v0" }],
    ai_messages: [], axis_actions: [], meeting_notes: [], documents: [], ai_attachments: [],
    "touch:updated_at": [{ table: "ai_conversations" }],
  };
  const { request } = fakeOpsRequest(tables, { userId: ME });
  const logs: unknown[] = [];
  (request.log as unknown as Record<string, unknown>).info = (obj: unknown) => logs.push(obj);
  return { tables, request: request as FastifyRequest, db: (o.draftDb ?? fakeDb(tables)) as never, logs, n: 0 };
}
export type World = ReturnType<typeof world>;

/** One counselor message through the engine, saved the way the route saves it. */
export async function say(w: World, content: string, model: Turn[] = [{ text: "Okay." }], studentId = ETHAN) {
  const id = `m${++w.n}`;
  w.tables.ai_messages!.push({ id, conversation_id: CONV, role: "user", content, created_at: nextStamp() });
  const scripted = scriptedApi(model);
  const events: [string, unknown][] = [];
  const emit: Emit = (e, d) => events.push([e, d]);
  const res = await runAxisTurn({
    request: w.request, conversationId: CONV, studentId, content, emit, signal: new AbortController().signal, api: scripted.api, messageId: id, draftDb: w.db,
  });
  if (!res.stateSaved) Object.assign(w.tables.ai_conversations![0]!, { state: res.state, updated_at: nextStamp() });
  w.tables.ai_messages!.push({ id: `a${w.n}`, conversation_id: CONV, role: "assistant", content: res.text, created_at: nextStamp() });
  const text = events.filter(([e]) => e === "delta").map(([, d]) => (d as { text: string }).text).join("");
  return { res, text, events, calls: scripted.calls };
}
export const add = (input: Row, id = "t1"): Turn => ({ tools: [{ id, name: "perform_action", input: { action: "application.add_activity", input } }] });
export const conv = (w: World) => w.tables.ai_conversations![0]!;
export const draftOf = (w: World) => (conv(w).state as Row | null)?.draft as Row | undefined;
export const rowsOf = (w: World) => (conv(w).draft_rows ?? []) as Row[];
export const cardsOf = (w: World, op = "application.add_activities") => w.tables.axis_actions!.filter((a) => (a.payload as Row).op === op);
/** The counselor's turn as the model first saw it (the first call's last user message). */
export const lastUser = (calls: { params: { messages: { role: string; content: unknown }[] } }[]) => JSON.stringify(calls[0]?.params.messages.filter((m) => m.role === "user").at(-1)?.content);

/** Opens a draft for Ethan with Code Club, cofounder, then asks for the rest. */
export async function opened(w: World) {
  await say(w, "Add Code Club for Ethan, cofounder", [add({ organization: "Code Club", position: "cofounder" }), { text: "What grades, timing and hours?" }]);
}


let actIds = 0;
/** The counselor clicks Confirm on the pending add card (every row, or `keep`): the rows are saved with new ids. */
export function confirmCard(w: World, keep?: string[]): string[] {
  const card = cardsOf(w).find((c) => c.status === "pending");
  if (!card) throw new Error("no pending card");
  const rows = (((card.payload as Row).input as Row).rows as Row[]).filter((r) => !keep || keep.includes(String(r.key)));
  const ids = rows.map(() => `a1000000-0000-4000-8000-${String(++actIds).padStart(12, "0")}`);
  Object.assign(card, { status: "confirmed", result: { ok: true, rows: rows.map((r, i) => ({ key: r.key, ok: true, id: ids[i] })) } });
  return ids;
}
/** A model turn that calls one op through perform_action. */
export const act = (action: string, input: Row, id = "t1"): Turn => ({ tools: [{ id, name: "perform_action", input: { action, input } }] });
