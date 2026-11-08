// The draft write path (AxIS activity drafts, plan Task 7): activity calls are checked field by field and merged
// into draft rows; one card per draft is filed after the model's answer; the status lines are written by code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftBlock, LINES, statusLines } from "../../src/lib/axis/drafts/lines.js";
import { sourcesFor } from "../../src/lib/axis/drafts/provenance.js";
import { emptyDraft, newRow, openDraft, setStatus, setValue, type Draft, type DraftHeader } from "../../src/lib/axis/drafts/state.js";
import { draftWrite, fileIfReady, type DraftTurn } from "../../src/lib/axis/drafts/write.js";
import { newTurnBudget, type OpContext, type OperationEvent } from "../../src/lib/axis/ops/run.js";
import { fakeOpsRequest } from "./axis-fakes.js";

type Row = Record<string, unknown>;
const ME = "c0000000-0000-4000-8000-000000000001";
const S1 = "50000000-0000-4000-8000-000000000001";
const S2 = "50000000-0000-4000-8000-000000000002";
const CONV = "33333333-3333-4333-8333-333333333333";
const ACT = "a0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-08T12:00:00Z");
const NAMES: Record<string, string> = { [S1]: "Avery Lee", [S2]: "Jordan Park" };

function setup(o: { messages: string[]; draft?: Draft; tainted?: boolean; verdict?: DraftTurn["verdict"]; askedBefore?: boolean; fileNow?: boolean; documents?: Row[]; actions?: Row[]; notes?: Row[]; sheet?: Row[] }) {
  const tables: Record<string, Row[]> = {
    profiles: [{ id: S1, counselor_id: ME }, { id: S2, counselor_id: ME }],
    ai_messages: o.messages.map((content, i) => ({ id: `m${i + 1}`, conversation_id: CONV, role: "user", content, created_at: `2026-11-08T11:${String(10 + i).padStart(2, "0")}:00Z` })),
    meeting_notes: (o.notes ?? []).map((n) => ({ student_id: S1, ...n })),
    ai_attachments: [],
    documents: (o.documents ?? []).map((d) => ({ student_id: S1, kind_confirmed: true, available_to_llm: true, ai_access: "default", ferpa_waived: false, ...d })),
    axis_actions: o.actions ?? [],
  };
  const sheet = o.sheet ?? [];
  const { request } = fakeOpsRequest(tables, {
    userId: ME,
    answer: (c) => (c.method === "GET" && c.url.startsWith("/application/sheets") ? { status: 200, body: { activities: sheet, honors: [] } } : { status: 200, body: { id: "x" } }),
  });
  const events: OperationEvent[] = [];
  const ctx: OpContext = {
    request, conversationId: CONV, studentId: S1, roster: { get: (id) => (NAMES[id] ? { name: NAMES[id]! } : undefined) },
    turn: newTurnBudget(o.tainted ?? false), signal: new AbortController().signal, onOperation: (e) => events.push(e),
  };
  const draft = o.draft ?? emptyDraft();
  const turn: DraftTurn = {
    draft, verdict: o.verdict ?? "draft", now: NOW, messageId: `m${o.messages.length}`,
    sources: (sid) => sourcesFor(request, CONV, sid, { practiceReadsDocuments: async () => true, extract: async () => undefined }),
    studentName: (id) => NAMES[id] ?? "the student", fileNow: o.fileNow ?? false, askedBefore: o.askedBefore ?? false,
  };
  return { tables, ctx, turn, draft, events };
}
const header = (o: Partial<DraftHeader> = {}): DraftHeader => ({ kind: "activity", student_id: S1, student_name: "Avery Lee", opened_at: NOW.toISOString(), updated_at: NOW.toISOString(), opened_msg: "m1", ...o });
const you = { label: "your message", outside: false };
/** A draft with one Code Club row, values typed in m1. */
function codeClub(extra: (d: Draft, r: ReturnType<typeof newRow>) => void = () => undefined): Draft {
  const d = emptyDraft(true, "v1");
  openDraft(d, header());
  const r = newRow(d, "add");
  setValue(d, r, "organization", "Code Club", you);
  setValue(d, r, "position", "Cofounder", you);
  setValue(d, r, "grade_levels", ["11"], you);
  setValue(d, r, "timing", ["break"], you, "summer");
  setValue(d, r, "hours_per_week", 6, you);
  setValue(d, r, "weeks_per_year", 2, you);
  extra(d, r);
  d.touched.rows.clear();
  d.touched.header.clear();
  return d;
}
const cards = (t: Record<string, Row[]>, op = "application.add_activities") => t.axis_actions!.filter((a) => (a.payload as Row).op === op);
const inputOf = (a: Row) => (a.payload as Row).input as Row;
const DETAILS = "Code Club / Cofounder / Grade 11 Summer / 6hr week, 2 week/yr";

test("a partial add opens a draft, keeps what passes, and asks once for the rest", async () => {
  const s = setup({ messages: ["add Code Club for Avery, cofounder"], verdict: "none" });
  const out = await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Code Club", position: "cofounder" });
  assert.equal(s.draft.header?.student_id, S1);
  assert.equal(s.draft.header?.opened_msg, "m1");
  assert.deepEqual(s.draft.notes.map((n) => n.kind), ["opened"]);
  assert.deepEqual(s.draft.rows[0]!.fields, { organization: "Code Club", position: "cofounder" });
  assert.match(out.content, /Kept in draft row r1: organization, position\./);
  assert.match(out.content, /Still missing in r1: grade_levels, timing, hours_per_week, weeks_per_year\. Ask the counselor once, in one message, for just these\./);
  assert.match(out.content, /status lines written by the server follow your answer/);
  await fileIfReady(s.ctx, s.turn, false);
  assert.equal(s.tables.axis_actions!.length, 0, "missing fields and not asked yet: no card");
  assert.deepEqual(statusLines(s.draft), ["Still need for Code Club row: grades, timing, hours, weeks."]);
});

test("the transcript's detail line completes the row and files one card", async () => {
  const s = setup({ messages: ["add Code Club for Avery", DETAILS] });
  await draftWrite(s.ctx, s.turn, "application.add_activity", {
    organization: "Code Club", position: "Cofounder", grade_levels: 11, timing: "summer", hours_per_week: "6hr week", weeks_per_year: "2 week/yr",
  });
  await fileIfReady(s.ctx, s.turn, false);
  const [card] = cards(s.tables);
  assert.ok(card, "one card filed");
  assert.equal((card.payload as Row).reason, null, "typed values don't flag the card");
  const r = (inputOf(card).rows as Row[])[0]!;
  assert.deepEqual([r.grade_levels, r.timing, r.hours_per_week, r.weeks_per_year], [["11"], ["break"], 6, 2]);
  assert.deepEqual(r.read_as, { timing: "summer", hours_per_week: "6hr week", weeks_per_year: "2 week/yr" });
  assert.equal(s.draft.rows[0]!.status, "card");
  assert.equal(s.draft.rows[0]!.card_id, card.id);
  assert.deepEqual(statusLines(s.draft), ["Waiting for your Confirm: add Code Club to Avery Lee's Activities sheet."]);
});

test("a value the counselor never wrote is refused by name and the rest is kept", async () => {
  const s = setup({ messages: ["City Library, please add it now"] });
  const out = await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "City Library", position: "Host, library workshop" });
  assert.match(out.content, /Not kept: position 'Host, library workshop' isn't in the counselor's words; use their wording or leave it blank and ask/);
  assert.equal(s.draft.rows[0]!.fields.organization, "City Library");
  assert.equal(s.draft.rows[0]!.fields.position, undefined);
  assert.deepEqual(s.draft.notes.filter((n) => n.kind === "rejected").map((n) => n.field), ["position"]);
});

test("200 hours a week is refused in plain words; no raw zod reaches the model or the lines", async () => {
  const s = setup({ messages: ["Code Club, 200 hours a week"] });
  const out = await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Code Club", hours_per_week: 200, grade_levels: [11, 13] });
  assert.doesNotMatch(out.content, /Invalid input|Expected|ZodError|too_big/);
  assert.match(out.content, /hours_per_week: 200 is more than 168\. Ask the counselor; don't guess\./);
  const lines = statusLines(s.draft).join("\n");
  assert.match(lines, /Couldn't save Code Club yet: hours per week: 200 is more than 168\./);
  assert.doesNotMatch(lines, /Ask the counselor|Invalid input|Expected/);
});

test("after asking once, the next draft turn files with blanks", async () => {
  const s = setup({ messages: ["add Code Club, cofounder", "that's all I know"], askedBefore: true });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Code Club", position: "cofounder" });
  await fileIfReady(s.ctx, s.turn, false);
  const [card] = cards(s.tables);
  assert.ok(card);
  assert.match(((card.payload as Row).details as string[])[0]!, /not given: category, grades, timing, hours per week, weeks per year, continuing/);
});

test("a row with no organization is never filed, even when asked", async () => {
  const s = setup({ messages: ["she was treasurer"], askedBefore: true });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { position: "treasurer" });
  await fileIfReady(s.ctx, s.turn, true);
  assert.equal(s.tables.axis_actions!.length, 0);
  assert.deepEqual(statusLines(s.draft), ["Still need for treasurer row: organization, grades, timing, hours, weeks."]);
});

test("a correction while the card waits replaces it, with every row", async () => {
  const draft = codeClub((d, r) => setStatus(d, r, "card", { card_id: "k1" }));
  const s = setup({
    messages: [DETAILS, "actually 8 hours"], draft,
    actions: [{ id: "k1", status: "pending", student_id: S1, payload: { op: "application.add_activities", summary: "Add", details: [], input: {} } }],
  });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { draft_row: "r1", hours_per_week: 8 });
  await fileIfReady(s.ctx, s.turn, false);
  assert.equal(s.tables.axis_actions![0]!.status, "dismissed");
  assert.deepEqual(s.tables.axis_actions![0]!.result, { ok: false, message: "Replaced by an updated card." });
  const fresh = cards(s.tables).filter((a) => a.status === "pending");
  assert.equal(fresh.length, 1);
  assert.equal((inputOf(fresh[0]!).rows as Row[])[0]!.hours_per_week, 8);
  assert.ok(s.draft.notes.some((n) => n.kind === "replaced"));
  assert.equal(s.events.find((e) => e.id === "k1")?.payload.status, "dismissed", "the app hears the old card was replaced");
});

test("Confirm landing during a correction turn: one sheet row and one update card, no replacement", async () => {
  const draft = codeClub((d, r) => setStatus(d, r, "card", { card_id: "k1" }));
  const s = setup({
    messages: [DETAILS, "actually 8 hours"], draft,
    // The counselor's click landed after the turn loaded the draft.
    actions: [{ id: "k1", status: "confirmed", student_id: S1, payload: { op: "application.add_activities" }, result: { ok: true, rows: [{ key: "r1", ok: true, id: ACT }] } }],
  });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { draft_row: "r1", hours_per_week: 8 });
  await fileIfReady(s.ctx, s.turn, false);
  assert.equal(s.tables.axis_actions![0]!.status, "confirmed", "the confirmed card is left alone");
  assert.equal(cards(s.tables).length, 1, "no new add card");
  const updates = cards(s.tables, "application.update_activity");
  assert.equal(updates.length, 1);
  assert.deepEqual(inputOf(updates[0]!), { student_id: S1, activity_id: ACT, hours_per_week: 8 });
  assert.equal(s.draft.rows.find((r) => r.key === "r1")?.status, "saved");
});

test("two activities in one go make one card with two rows", async () => {
  const s = setup({ messages: ["add Code Club, cofounder, grade 11, summer, 6hr week, 2 week/yr and Debate Club, captain, grade 11, school year, 3 hrs a week, 30 weeks"] });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Code Club", position: "cofounder", grade_levels: "11", timing: "summer", hours_per_week: 6, weeks_per_year: 2 });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Debate Club", position: "captain", grade_levels: "11", timing: "school year", hours_per_week: 3, weeks_per_year: 30 });
  await fileIfReady(s.ctx, s.turn, false);
  const all = cards(s.tables);
  assert.equal(all.length, 1);
  assert.deepEqual((inputOf(all[0]!).rows as Row[]).map((r) => r.key), ["r1", "r2"]);
  assert.deepEqual(statusLines(s.draft), ["Waiting for your Confirm: add Code Club and Debate Club to Avery Lee's Activities sheet."]);
});

test("an eleventh activity is refused by name; the first ten stay", async () => {
  const d = emptyDraft(true, "v1");
  openDraft(d, header());
  for (let i = 1; i <= 10; i++) setValue(d, newRow(d, "add"), "organization", `Club ${i}`, you);
  const s = setup({ messages: ["also Chess Club"], draft: d });
  const out = await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Chess Club" });
  assert.match(out.content, /a draft holds 10 activities; file this card first/);
  assert.equal(s.draft.rows.length, 10);
});

test("an update of a saved row is its own card, checking only the changed fields", async () => {
  const s = setup({ messages: ["make Code Club 8 hours a week"] });
  await draftWrite(s.ctx, s.turn, "application.update_activity", { activity_id: ACT, hours_per_week: 8 });
  await fileIfReady(s.ctx, s.turn, false);
  const [u] = cards(s.tables, "application.update_activity");
  assert.ok(u);
  assert.deepEqual(inputOf(u), { student_id: S1, activity_id: ACT, hours_per_week: 8 });
});

test("an add for another student while a draft is open files nothing and merges nothing", async () => {
  const s = setup({ messages: [DETAILS, "add Debate Club for Jordan Park, 5 hrs a week"], draft: codeClub() });
  const out = await draftWrite(s.ctx, s.turn, "application.add_activity", { student_id: S2, organization: "Debate Club", hours_per_week: 5 });
  assert.ok(out.isError);
  assert.match(out.content, /there's an open activity draft for Avery Lee; don't add anything for another student/);
  assert.equal(s.draft.rows.length, 1);
  assert.deepEqual(s.draft.header?.switch_to, { student_id: S2, name: "Jordan Park" });
  await fileIfReady(s.ctx, s.turn, false);
  assert.ok(cards(s.tables).every((c) => (inputOf(c).student_id as string) !== S2));
  assert.ok(statusLines(s.draft).includes("Your activity draft for Avery Lee isn't finished. Drop it and start one for Jordan Park?"));
});

test("in an unrelated turn activity ops are refused", async () => {
  const s = setup({ messages: [DETAILS, "what's her GPA?"], draft: codeClub(), verdict: "unrelated" });
  const out = await draftWrite(s.ctx, s.turn, "application.add_activity", { draft_row: "r1", hours_per_week: 7 });
  assert.equal(out.content, "Not done: there's an open activity draft; ask the counselor to continue it");
  assert.equal(s.draft.rows[0]!.fields.hours_per_week, 6);
});

test("a resume-sourced value flags the card outside-content, even read three messages earlier", async () => {
  const d = emptyDraft(true, "v1");
  openDraft(d, header());
  const r = newRow(d, "add");
  setValue(d, r, "organization", "Debate Club", { label: "Resume.pdf", outside: true });
  d.touched.rows.clear();
  const s = setup({ messages: ["add the activities from her resume", "ok", "thanks", "captain, grade 11, school year, 5 hrs a week, 30 weeks"], draft: d });
  assert.equal(s.ctx.turn.tainted, false, "this turn read nothing outside");
  await draftWrite(s.ctx, s.turn, "application.add_activity", { draft_row: "r1", position: "captain", grade_levels: "11", timing: "school year", hours_per_week: 5, weeks_per_year: 30 });
  await fileIfReady(s.ctx, s.turn, false);
  assert.equal((cards(s.tables)[0]!.payload as Row).reason, "outside-content");
});

test("a typed or meeting-note value doesn't flag the card", async () => {
  const s = setup({ messages: ["add Robotics Club, member, grade 10, school year, 4 hrs a week, 30 weeks"], notes: [{ meeting_date: "2026-10-12", title: "Check-in", summary: "Robotics Club member" }] });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Robotics Club", position: "member", grade_levels: "10", timing: "school year", hours_per_week: 4, weeks_per_year: 30 });
  await fileIfReady(s.ctx, s.turn, false);
  assert.equal((cards(s.tables)[0]!.payload as Row).reason, null);
});

test("a description: an exact copy is saved and shown whole; an edited one is refused with the fixed sentence", async () => {
  const typed = "Taught 20 middle schoolers to code in Scratch every Saturday.";
  const s = setup({ messages: [`${DETAILS}. description: ${typed}`] });
  const ok = await draftWrite(s.ctx, s.turn, "application.add_activity", {
    organization: "Code Club", position: "Cofounder", grade_levels: 11, timing: "summer", hours_per_week: 6, weeks_per_year: 2, description: typed,
  });
  assert.match(ok.content, /Kept in draft row r1: .*description/);
  await fileIfReady(s.ctx, s.turn, false);
  assert.ok(((cards(s.tables)[0]!.payload as Row).details as string[])[0]!.includes(`"${typed}"`));

  const t = setup({ messages: [DETAILS] });
  const bad = await draftWrite(t.ctx, t.turn, "application.add_activity", { organization: "Code Club", description: "Taught middle schoolers to code." });
  assert.match(bad.content, /description must be copied exactly from the counselor's message or the student's resume; AxIS can't write or edit it\./);
  assert.equal(t.draft.rows[0]!.fields.description, undefined);
});

test("a description longer than 1000 characters is refused before it reaches a card", async () => {
  const long = "w".repeat(1001);
  const s = setup({ messages: [`Code Club. ${long}`] });
  const out = await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Code Club", description: long });
  assert.match(out.content, /description: .*1000 characters/);
  assert.equal(s.draft.rows[0]!.fields.description, undefined);
});

test("status lines use the fixed copy", () => {
  assert.equal(LINES.reminder("Avery Lee"), "You still have an activity draft for Avery Lee. Continue or cancel?");
  assert.equal(LINES.expired, "Your activity draft expired. Want to start again?");
  assert.equal(LINES.switchQuestion("Avery Lee", "Jordan Park"), "Your activity draft for Avery Lee isn't finished. Drop it and start one for Jordan Park?");
  assert.equal(LINES.cancelled("Avery Lee"), "Okay, I dropped the activity draft for Avery Lee.");
  assert.equal(LINES.saveFailed, "I couldn't keep this draft; send the details again.");
  assert.equal(LINES.overLimit, "Over the Common App's 150-character limit.");
});

test("a saved row reads as saved once", () => {
  const d = codeClub((dd, r) => setStatus(dd, r, "saved", { activity_id: ACT }));
  d.notes.push({ kind: "saved", key: "r1" });
  assert.deepEqual(statusLines(d), ["Saved: Code Club on Avery Lee's Activities sheet."]);
});

test("the draft block lists descriptions by length and source, never their text", () => {
  const secret = "Founded a club that teaches kids Python on weekends.";
  const d = codeClub((dd, r) => setValue(dd, r, "description", secret, { label: "resume", outside: true }));
  const block = draftBlock(d);
  assert.ok(!block.includes(secret));
  assert.match(block, new RegExp(`description: ${secret.length} characters, from resume`));
  assert.match(block, /Activity draft for Avery Lee/);
  assert.match(block, new RegExp(`student_id ${S1}`), "the model can add to the draft from another student's panel (final #4)");
  assert.match(block, /draft_row/);
  assert.match(block, /Don't say whether anything was saved, tried or needs Confirm/);
});

test("a correction to a card filed with blanks replaces the card (finding A)", async () => {
  const s = setup({ messages: ["Add Code Club for Avery, cofounder, add it"], fileNow: true });
  await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Code Club", position: "cofounder" });
  await fileIfReady(s.ctx, s.turn, true);
  assert.equal(cards(s.tables).length, 1, "filed with blanks");
  s.draft.touched.rows.clear();
  // Next message: the hours.
  s.tables.ai_messages!.push({ id: "m2", conversation_id: CONV, role: "user", content: "6 hours a week", created_at: "2026-11-08T11:30:00Z" });
  const next: DraftTurn = { ...s.turn, messageId: "m2", fileNow: false, askedBefore: false };
  const out = await draftWrite(s.ctx, next, "application.add_activity", { draft_row: "r1", hours_per_week: 6 });
  assert.doesNotMatch(out.content, /Ask the counselor once/, "a row already on its card is never asked about again");
  await fileIfReady(s.ctx, next, false);
  const pending = cards(s.tables).filter((c) => c.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal((inputOf(pending[0]!).rows as Row[])[0]!.hours_per_week, 6, "the new card carries the hours");
  assert.equal(cards(s.tables)[0]!.status, "dismissed");
});

test("filing a card clears the ask; a new row is asked about before it is filed (finding B)", async () => {
  const s = setup({ messages: [DETAILS], askedBefore: true });
  s.draft.header = null;
  await draftWrite(s.ctx, s.turn, "application.add_activity", { organization: "Code Club", position: "Cofounder", grade_levels: 11, timing: "summer", hours_per_week: 6, weeks_per_year: 2 });
  s.draft.header!.asked = { at: NOW.toISOString(), fields: ["hours_per_week"], after_msg: "m1" };
  await fileIfReady(s.ctx, s.turn, false);
  assert.equal(s.draft.header?.asked, undefined, "the ask is spent once its card is filed");
  s.draft.touched.rows.clear();
  s.tables.ai_messages!.push({ id: "m2", conversation_id: CONV, role: "user", content: "also add Debate Club, captain", created_at: "2026-11-08T11:30:00Z" });
  const next: DraftTurn = { ...s.turn, messageId: "m2", fileNow: false, askedBefore: false };
  await draftWrite(s.ctx, next, "application.add_activity", { organization: "Debate Club", position: "captain" });
  await fileIfReady(s.ctx, next, false);
  assert.equal(cards(s.tables).filter((c) => c.status === "pending").length, 1, "Code Club's card stays; Debate Club waits to be asked about");
  assert.equal(s.draft.rows.find((r) => r.fields.organization === "Debate Club")?.status, "collecting");
});

test("a change to a saved activity is named by that activity (finding F)", async () => {
  const s = setup({ messages: ["make Code Club 8 hours a week"], sheet: [{ id: ACT, organization: "Code Club", position: "Cofounder" }] });
  await draftWrite(s.ctx, s.turn, "application.update_activity", { activity_id: ACT, hours_per_week: 8 });
  await fileIfReady(s.ctx, s.turn, false);
  assert.deepEqual(statusLines(s.draft), ["Waiting for your Confirm: change Code Club on Avery Lee's Activities sheet."]);
});
