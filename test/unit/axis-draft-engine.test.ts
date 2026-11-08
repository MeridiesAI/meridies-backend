// The engine runs the activity draft (AxIS activity drafts, plan Task 8): whole turns through runAxisTurn with a
// scripted model, a fake database, and the draft saved through an injected server client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { add, cardsOf, conv, CONV, draftOf, ETHAN, lastUser, opened, rowsOf, say, SOPHIA, world, type Row } from "./axis-draft-world.js";

test("a detail-only reply mid-draft skips the direct answer and runs as the Clerk with the draft block", async () => {
  const w = world();
  await opened(w);
  assert.equal((draftOf(w)?.asked as Row)?.after_msg, "m1", "AxIS asked once, after m1");
  const t = await say(w, "Grade 11 Summer / 6hr week, 2 week/yr", [add({ draft_row: "r1", grade_levels: 11, timing: "summer", hours_per_week: "6hr week", weeks_per_year: "2 week/yr" }), { text: "Thanks." }]);
  assert.equal(t.res.path, "agent");
  assert.deepEqual((t.events.find(([e]) => e === "route")?.[1] as Row)?.mode, "action");
  assert.match(lastUser(t.calls), /Activity draft for Ethan Park/);
  assert.equal(cardsOf(w).length, 1);
  assert.match(t.text, /Waiting for your Confirm: add Code Club to Ethan Park's Activities sheet\.$/);
});

test("an unrelated question mid-draft is answered as usual, then the reminder; the draft is unchanged", async () => {
  const w = world();
  await opened(w);
  const before = JSON.stringify(rowsOf(w));
  const t = await say(w, "What's his GPA?");
  assert.equal(t.res.path, "direct");
  assert.match(t.text, /3\.912/);
  assert.match(t.text, /You still have an activity draft for Ethan Park\. Continue or cancel\?$/);
  assert.equal(JSON.stringify(rowsOf(w)), before);
});

test("an essay request mid-draft stays on the essay route and leaves the draft and card alone", async () => {
  const w = world();
  await opened(w);
  const before = JSON.stringify(rowsOf(w));
  const t = await say(w, "write a description for it");
  assert.equal(t.res.path, "essay");
  assert.equal(JSON.stringify(rowsOf(w)), before);
  assert.match(t.text, /You still have an activity draft for Ethan Park\. Continue or cancel\?$/);
});

test("cancel drops the draft and its pending card with no model call", async () => {
  const w = world();
  await opened(w);
  await say(w, "that's all", [{ text: "Filing it." }]);
  assert.equal(cardsOf(w)[0]?.status, "pending");
  const t = await say(w, "never mind", [{ text: "should not be called" }]);
  assert.equal(t.calls.length, 0);
  assert.equal(t.text, "Okay, I dropped the activity draft for Ethan Park.");
  assert.equal(cardsOf(w)[0]?.status, "dismissed");
  assert.equal(draftOf(w), undefined);
  assert.deepEqual(rowsOf(w), []);
});

test("continue shows what's missing with no model call", async () => {
  const w = world();
  await opened(w);
  const t = await say(w, "continue", [{ text: "should not be called" }]);
  assert.equal(t.calls.length, 0);
  assert.equal(t.text, `Still need for Code Club row: grades, timing, hours, weeks.\nSend what's missing, or say "add it" to file it with blanks.`);
});

test("after 30 minutes the reply starts with the expiry line; yes on the next message restores the fields", async () => {
  const w = world();
  await opened(w);
  (draftOf(w) as Row).updated_at = new Date(Date.now() - 31 * 60_000).toISOString();
  const late = await say(w, "What's his GPA?");
  assert.match(late.text, /^Your activity draft expired\. Want to start again\?/);
  assert.ok(draftOf(w)?.expired_at, "the fields are kept for one turn");
  const yes = await say(w, "yes", [{ text: "Back to Code Club." }]);
  assert.equal(draftOf(w)?.expired_at, undefined);
  assert.equal((rowsOf(w)[0]!.fields as Row).organization, "Code Club");
  assert.equal(rowsOf(w)[0]!.status, "collecting");
  assert.match(lastUser(yes.calls), /Activity draft for Ethan Park/);
});

test("after 30 minutes with only a card left: no line, the card still confirmable", async () => {
  const w = world();
  await opened(w);
  await say(w, "that's all");
  (draftOf(w) as Row).updated_at = new Date(Date.now() - 31 * 60_000).toISOString();
  const t = await say(w, "What's his GPA?");
  assert.doesNotMatch(t.text, /expired/);
  assert.equal(draftOf(w), undefined);
  assert.equal(cardsOf(w)[0]?.status, "pending");
});

test("the panel switched to another student: the add is refused, the switch question asked, nothing filed", async () => {
  const w = world();
  await opened(w);
  const t = await say(w, "add Debate Club, captain, grade 12, school year, 5 hrs a week, 30 weeks", [add({ organization: "Debate Club", position: "captain" }), { text: "Done." }], SOPHIA);
  assert.match(t.text, /Your activity draft for Ethan Park isn't finished\. Drop it and start one for Sophia Martinez\?$/);
  assert.equal(cardsOf(w).length, 0);
  assert.equal(rowsOf(w).length, 1);
  assert.equal((draftOf(w)?.switch_to as Row)?.student_id, SOPHIA);
});

test("yes to the switch drops the old draft and opens one for the new student", async () => {
  const w = world();
  await opened(w);
  await say(w, "that's all");
  await say(w, "add Debate Club for Sophia, captain, grade 12, school year, 5 hrs a week, 30 weeks", [add({ student_id: SOPHIA, organization: "Debate Club" }), { text: "Asking first." }]);
  const t = await say(w, "yes", [add({ student_id: SOPHIA, organization: "Debate Club", position: "captain", grade_levels: "12", timing: "school year", hours_per_week: 5, weeks_per_year: 30 }), { text: "Started." }], ETHAN);
  assert.match(lastUser(t.calls), /start one for Sophia Martinez/);
  assert.equal(cardsOf(w)[0]?.status, "dismissed", "Ethan's card is dropped");
  assert.equal(draftOf(w)?.student_id, SOPHIA);
  const sophiaCard = cardsOf(w).find((c) => c.status === "pending");
  assert.equal(((sophiaCard?.payload as Row)?.input as Row)?.student_id, SOPHIA);
});

test("the draft is saved before the turn returns, and a failed save says so", async () => {
  const broken = { from: () => { throw new Error("db down"); } };
  const w = world({ draftDb: broken });
  const t = await say(w, "Add Code Club for Ethan, cofounder", [add({ organization: "Code Club", position: "cofounder" }), { text: "Noted." }]);
  assert.match(t.text, /I couldn't keep this draft; send the details again\.$/);
});

test("a turn that saved the draft is marked stateSaved; a turn with no draft isn't", async () => {
  const w = world();
  const plain = await say(w, "What's his GPA?");
  assert.equal(plain.res.stateSaved, false);
  await opened(w);
  assert.equal(draftOf(w)?.student_id, ETHAN, "the turn itself saved the header");
  const next = await say(w, "What's his GPA?");
  assert.equal(next.res.stateSaved, true);
  assert.ok(((conv(w).state as Row).students as Row[]).some((s) => s.id === ETHAN), "the dialogue state is kept beside the draft");
});

test("status lines follow the model's text and come from code", async () => {
  const w = world();
  const t = await say(w, "Add Code Club for Ethan, cofounder, grade 11, summer, 6hr week, 2 week/yr", [
    add({ organization: "Code Club", position: "cofounder", grade_levels: "11", timing: "summer", hours_per_week: 6, weeks_per_year: 2 }),
    { text: "All saved!" },
  ]);
  assert.equal(t.text, "All saved!\n\nWaiting for your Confirm: add Code Club to Ethan Park's Activities sheet.");
  assert.equal(t.res.text, t.text, "the saved answer is what the counselor saw");
});

test("a college matched by a fragment isn't fetched while drafting", async () => {
  const w = world();
  await opened(w);
  const t = await say(w, "it ran at the Santa Clara library", [{ text: "Noted." }]);
  assert.doesNotMatch(lastUser(t.calls), /Santa Clara University/);
});

test("every path logs one axis turn line with no text, values, names or student ids", async () => {
  const w = world();
  await opened(w);
  await say(w, "What's his GPA?");
  await say(w, "continue");
  const lines = w.logs.filter((l) => (l as { axis?: unknown }).axis) as { axis: Row }[];
  assert.equal(lines.length, 3);
  for (const { axis } of lines) {
    assert.ok(axis.path && axis.intent && axis.draft && axis.conversationId === CONV, JSON.stringify(axis));
    assert.ok(Array.isArray(axis.outcomes));
    const raw = JSON.stringify(axis);
    for (const leak of ["Code Club", "cofounder", "Ethan", ETHAN, "GPA", "3.912"]) assert.ok(!raw.includes(leak), `${leak} in ${raw}`);
  }
  assert.deepEqual(lines.map((l) => l.axis.draft), ["opened", "unrelated", "continued"]);
});

test("an unrelated question that reaches the model never files a card (finding C)", async () => {
  const w = world();
  await say(w, "Add Code Club for Ethan, cofounder, grade 11, summer, 6 hrs a week, 2 weeks a year", [
    add({ organization: "Code Club", position: "cofounder", grade_levels: "11", timing: "summer", hours_per_week: 6, weeks_per_year: 2 }), { text: "Okay." },
  ]);
  await say(w, "also Debate Club, captain", [add({ organization: "Debate Club", position: "captain" }), { text: "Grades and hours?" }]);
  const before = cardsOf(w).length;
  const card = cardsOf(w).find((c) => c.status === "pending")!;
  const rows = (((card.payload as Row).input as Row).rows as Row[]).filter((r) => r.key === "r1");
  Object.assign(card, { status: "confirmed", result: { ok: true, rows: rows.map((r) => ({ key: r.key, ok: true, id: "a2000000-0000-4000-8000-000000000001" })) } });
  const t = await say(w, "which colleges should he look at for engineering?", [{ text: "A few ideas." }]);
  assert.equal(t.res.path === "agent" || t.res.path === "specialists", true);
  assert.equal(cardsOf(w).length, before, "no card filed in an unrelated answer");
});

test("an unrelated college question mid-draft still gets the catalog's evidence", async () => {
  const w = world();
  await opened(w);
  const t = await say(w, "is Santa Clara University a good fit for him?", [{ text: "Maybe." }]);
  assert.match(lastUser(t.calls), /Santa Clara University/);
});

test("a cancel turn still says what was saved since the last answer", async () => {
  const w = world();
  await say(w, "Add Code Club for Ethan, cofounder, grade 11, summer, 6 hrs a week, 2 weeks a year", [
    add({ organization: "Code Club", position: "cofounder", grade_levels: "11", timing: "summer", hours_per_week: 6, weeks_per_year: 2 }), { text: "Okay." },
  ]);
  await say(w, "also Debate Club, captain", [add({ organization: "Debate Club", position: "captain" }), { text: "Grades and hours?" }]);
  const card = cardsOf(w).find((c) => c.status === "pending")!;
  Object.assign(card, { status: "confirmed", result: { ok: true, rows: [{ key: "r1", ok: true, id: "a2000000-0000-4000-8000-000000000002" }] } });
  const t = await say(w, "never mind");
  assert.match(t.text, /^Okay, I dropped the activity draft for Ethan Park\./);
  assert.match(t.text, /Saved: Code Club on Ethan Park's Activities sheet\./);
});

test("a turn that never saw the draft returns the version it read, for the route's guarded write", async () => {
  const w = world();
  const t = await say(w, "What's his GPA?");
  assert.equal(t.res.stateSaved, false);
  assert.equal(typeof t.res.stateVersion, "string");
});
