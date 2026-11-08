// Spec 4.10's 18 conversations, replayed with a scripted model to test the plumbing (the real model runs them in
// evals/axis/cases-drafts.mjs). Each asserts the cards, the draft and the lines up to the card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, add, cardsOf, confirmCard, draftOf, ETHAN, opened, rowsOf, say, SOPHIA, world, type Row, type World } from "./axis-draft-world.js";

const full = { organization: "Code Club", position: "cofounder", grade_levels: "11", timing: "summer", hours_per_week: 6, weeks_per_year: 2 };
const ONE = "Add Code Club for Ethan, cofounder, grade 11, summer, 6 hrs a week, 2 weeks a year";
const rowOf = (w: World, n = 0) => ((cardsOf(w).find((c) => c.status === "pending")?.payload as Row)?.input as Row)?.rows as Row[] | undefined;
const pendingRow = (w: World, n = 0) => rowOf(w)?.[n];
const noRaw = (text: string) => assert.doesNotMatch(text, /Invalid input|Expected|ZodError|too_big|invalid_enum/);

test("drafts-01 everything in one message: one card, all fields, no questions", async () => {
  const w = world();
  const t = await say(w, ONE, [add(full), { text: "On it." }]);
  assert.equal(cardsOf(w).length, 1);
  assert.deepEqual([pendingRow(w)?.grade_levels, pendingRow(w)?.timing, pendingRow(w)?.hours_per_week, pendingRow(w)?.weeks_per_year], [["11"], ["break"], 6, 2]);
  assert.doesNotMatch(t.text, /\?/);
});

test("drafts-02 an add with no details, then the details with no verb: the card after the second message", async () => {
  const w = world();
  await say(w, "Add an activity for Ethan", [add({}), { text: "Which organization, role, grades, timing and hours?" }]);
  assert.ok(draftOf(w), "the empty call opened the draft");
  const t = await say(w, "Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr", [
    add({ draft_row: "r1", organization: "Code Club", position: "Cofounder/Teacher", grade_levels: 11, timing: "Summer", hours_per_week: "6hr week", weeks_per_year: "2 week/yr" }),
    { text: "Thanks." },
  ]);
  assert.equal(t.res.path, "agent");
  assert.equal(cardsOf(w).length, 1);
  assert.equal(pendingRow(w)?.position, "Cofounder/Teacher");
});

test("drafts-03 'sophomore' is grade 10", async () => {
  const w = world();
  await say(w, "Add Code Club for Ethan, cofounder, sophomore, summer, 6 hrs a week, 2 weeks a year", [add({ ...full, grade_levels: "sophomore" }), { text: "Okay." }]);
  assert.deepEqual(pendingRow(w)?.grade_levels, ["10"]);
  assert.equal((pendingRow(w)?.read_as as Row)?.grade_levels, "sophomore");
});

test("drafts-04 'grades 10–12' is 10, 11 and 12", async () => {
  const w = world();
  await say(w, "Add Code Club for Ethan, cofounder, grades 10–12, summer, 6 hrs a week, 2 weeks a year", [add({ ...full, grade_levels: "grades 10–12" }), { text: "Okay." }]);
  assert.deepEqual(pendingRow(w)?.grade_levels, ["10", "11", "12"]);
});

test("drafts-05 a description given in the message is saved exactly as typed", async () => {
  const w = world();
  const desc = "Taught 20 middle schoolers to code in Scratch every Saturday.";
  await say(w, `${ONE}. Description: ${desc}`, [add({ ...full, description: desc }), { text: "Okay." }]);
  assert.equal(pendingRow(w)?.description, desc);
});

test("drafts-06 'write a description for it' after the card: the essay route, nothing changed", async () => {
  const w = world();
  await say(w, ONE, [add(full), { text: "Okay." }]);
  const before = JSON.stringify(w.tables.axis_actions);
  const t = await say(w, "write a description for it");
  assert.equal(t.res.path, "essay");
  assert.equal(JSON.stringify(w.tables.axis_actions), before);
  assert.equal(pendingRow(w)?.description, undefined);
});

test("drafts-07 'actually 8 hours' before Confirm replaces the card", async () => {
  const w = world();
  await say(w, ONE, [add(full), { text: "Okay." }]);
  await say(w, "actually 8 hours", [add({ draft_row: "r1", hours_per_week: 8 }), { text: "Updated." }]);
  assert.deepEqual(cardsOf(w).map((c) => c.status), ["dismissed", "pending"]);
  assert.equal(pendingRow(w)?.hours_per_week, 8);
});

test("drafts-08 a rename after saving is an update card on that row", async () => {
  const w = world();
  await say(w, ONE, [add(full), { text: "Okay." }]);
  const [id] = confirmCard(w);
  await say(w, "rename it to Coding Club", [act("application.update_activity", { activity_id: id, organization: "Coding Club" }), { text: "Okay." }]);
  const u = cardsOf(w, "application.update_activity");
  assert.equal(u.length, 1);
  assert.deepEqual((u[0]!.payload as Row).input, { student_id: ETHAN, activity_id: id, organization: "Coding Club" });
});

test("drafts-09 'never mind' mid-draft: no rows, the draft closed", async () => {
  const w = world();
  await opened(w);
  const t = await say(w, "never mind");
  assert.equal(t.calls.length, 0);
  assert.equal(draftOf(w), undefined);
  assert.equal(cardsOf(w).length, 0);
});

test("drafts-10 two activities in one go: one card, two rows", async () => {
  const w = world();
  await say(w, "Add Code Club for Ethan, cofounder, grade 11, summer, 6 hrs a week, 2 weeks a year, and Debate Club, captain, grade 12, school year, 3 hrs a week, 30 weeks", [
    { tools: [
      { id: "t1", name: "perform_action", input: { action: "application.add_activity", input: full } },
      { id: "t2", name: "perform_action", input: { action: "application.add_activity", input: { organization: "Debate Club", position: "captain", grade_levels: "12", timing: "school year", hours_per_week: 3, weeks_per_year: 30 } } },
    ] },
    { text: "Both." },
  ]);
  assert.equal(cardsOf(w).length, 1);
  assert.deepEqual(rowOf(w)?.map((r) => r.organization), ["Code Club", "Debate Club"]);
});

test("drafts-11 'It ran at City Library': the organization stays Code Club; no invented position", async () => {
  const w = world();
  await opened(w);
  await say(w, "It ran at City Library", [add({ draft_row: "r1", position: "Host, library workshop" }), { text: "Noted." }]);
  const r = rowsOf(w)[0]!;
  assert.equal((r.fields as Row).organization, "Code Club");
  assert.equal((r.fields as Row).position, "cofounder");
});

test("drafts-12 a GPA question mid-draft, then continue, then the hours complete the card", async () => {
  const w = world();
  await say(w, "Add Code Club for Ethan, cofounder, grade 11, summer, 2 weeks a year", [add({ organization: "Code Club", position: "cofounder", grade_levels: "11", timing: "summer", weeks_per_year: 2 }), { text: "How many hours a week?" }]);
  const gpa = await say(w, "what's his GPA?");
  assert.match(gpa.text, /You still have an activity draft for Ethan Park\. Continue or cancel\?$/);
  const cont = await say(w, "continue");
  assert.match(cont.text, /Still need for Code Club row: hours\./);
  await say(w, "6 hours a week", [add({ draft_row: "r1", hours_per_week: 6 }), { text: "Thanks." }]);
  assert.equal(pendingRow(w)?.hours_per_week, 6);
});

test("drafts-13 a reply after 30 minutes: the expiry line; yes restores the fields", async () => {
  const w = world();
  await opened(w);
  (draftOf(w) as Row).updated_at = new Date(Date.now() - 31 * 60_000).toISOString();
  const late = await say(w, "what's his GPA?");
  assert.match(late.text, /^Your activity draft expired\. Want to start again\?/);
  await say(w, "yes", [{ text: "Back to it." }]);
  assert.equal((rowsOf(w)[0]!.fields as Row).organization, "Code Club");
});

test("drafts-14 '200 hours a week': a plain couldn't-save line, no raw error", async () => {
  const w = world();
  const t = await say(w, "Add Code Club for Ethan, cofounder, 200 hours a week", [add({ organization: "Code Club", position: "cofounder", hours_per_week: 200 }), { text: "Hmm." }]);
  assert.match(t.text, /Couldn't save Code Club yet: hours per week: 200 is more than 168\./);
  noRaw(t.text);
});

test("drafts-15 the redacted transcript: Code Club saved once, correctly; no City Library row", async () => {
  const w = world();
  await say(w, "could you add that to his list?", [{ text: "Which list?" }]);
  await say(w, "his activites sheet", [add({}), { text: "What's the organization, role, grades, timing and hours?" }]);
  await say(w, "Code Club / Cofounder/Teacher / Grade 11 Summer / 6hr week, 2 week/yr", [
    add({ draft_row: "r1", organization: "Code Club", position: "Cofounder/Teacher", grade_levels: 11, timing: "summer", hours_per_week: "6hr week", weeks_per_year: "2 week/yr" }),
    { text: "Got it." },
  ]);
  const i = await say(w, "i gave it", [{ text: "Thanks." }]);
  noRaw(i.text);
  await say(w, "City Library, please add it now", [{ text: "It's on the card." }]);
  assert.equal(cardsOf(w).length, 1, "one card, never replaced");
  confirmCard(w);
  const rows = rowOf(w) ?? (((cardsOf(w)[0]!.payload as Row).input as Row).rows as Row[]);
  assert.deepEqual(rows.map((r) => r.organization), ["Code Club"]);
  assert.ok(!JSON.stringify(w.tables.axis_actions).includes("City Library"));
});

test("drafts-16 activities from the resume: one card, sourced values, exact descriptions, outside-content", async () => {
  const w = world();
  w.tables.documents!.push({
    id: "d1", student_id: ETHAN, title: "Resume.pdf", filename: "resume.pdf", kind: "resume", kind_confirmed: true, available_to_llm: true, ai_access: "default", ferpa_waived: false,
    parsed_data: { text: "Robotics Club — Captain, grades 10-12, school year, 8 hrs/week, 30 weeks\nBuilt and programmed a competition robot with a team of six.\nFood Bank — Volunteer, summer, 4 hrs/week, 10 weeks" },
  });
  w.tables.practice_settings!.push({ counselor_id: "counselor-1", auto_parse_documents: true });
  await say(w, "Add the activities from his resume", [
    act("application.add_activities", { rows: [
      { key: "r1", organization: "Robotics Club", position: "Captain", grade_levels: "grades 10-12", timing: "school year", hours_per_week: 8, weeks_per_year: 30, description: "Built and programmed a competition robot with a team of six." },
      { key: "r2", organization: "Food Bank", position: "Volunteer", grade_levels: "grades 10-12", timing: "summer", hours_per_week: 4, weeks_per_year: 10 },
    ] }),
    { text: "Here they are." },
  ]);
  const card = cardsOf(w)[0]!;
  assert.equal((card.payload as Row).reason, "outside-content");
  const rows = ((card.payload as Row).input as Row).rows as Row[];
  assert.equal((rows[0]!.sources as Row).organization, "Resume.pdf");
  assert.equal((rows[0]!.sources as Row).description, "resume");
  assert.equal(rows[0]!.description, "Built and programmed a competition robot with a team of six.");
});

test("drafts-17 'Is his SAT 1450 good for UCLA?' mid-draft: answered with the reminder; nothing captured", async () => {
  const w = world();
  await opened(w);
  const before = JSON.stringify(rowsOf(w));
  const t = await say(w, "Is his SAT 1450 good for UCLA?", [{ text: "It's within range." }]);
  assert.match(t.text, /You still have an activity draft for Ethan Park\. Continue or cancel\?$/);
  assert.equal(JSON.stringify(rowsOf(w)), before);
});

test("drafts-18 another student mid-draft: the switch question; yes drops the old one; the old student's sheet unchanged", async () => {
  const w = world();
  await opened(w);
  const ask = await say(w, "add Debate Club for Sophia, 5 hrs a week", [add({ student_id: SOPHIA, organization: "Debate Club", hours_per_week: 5 }), { text: "One moment." }]);
  assert.match(ask.text, /Drop it and start one for Sophia Martinez\?$/);
  assert.equal(cardsOf(w).length, 0);
  await say(w, "yes", [add({ student_id: SOPHIA, organization: "Debate Club", hours_per_week: 5 }), { text: "Started." }]);
  assert.equal(draftOf(w)?.student_id, SOPHIA);
  assert.equal((rowsOf(w)[0]!.fields as Row).organization, "Debate Club");
  assert.ok(cardsOf(w).every((c) => ((c.payload as Row).input as Row).student_id !== ETHAN || c.status !== "confirmed"));
});
