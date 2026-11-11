// What a student's parents receive (lib/familyVisibility.ts): the switches, the weekly report filtered at send
// time, the dispatch re-check, and the escalation sweep. Every switch on must leave everything exactly as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_FAMILY_VISIBILITY,
  FAMILY_LABELS,
  applyToWeeklyReport,
  filterDigestSummary,
  labelList,
  loadFamilyVisibility,
  revealsHidden,
  sectionCategory,
  visibilityFromRow,
  type FamilyVisibility,
} from "../../src/lib/familyVisibility.js";
import { buildWeeklyDigest, lastCompletedWeek, type DigestInput } from "../../src/lib/weeklyDigestContent.js";
import { emailBodyOf, reportMessages, smsTextOf } from "../../src/lib/familyReportSend.js";
import { TASKS_OFF_REASON, runEscalationSweep } from "../../src/lib/accountability.js";
import { fakeDb } from "./axis-fakes.js";

type Row = Record<string, unknown>;
const on: FamilyVisibility = { ...DEFAULT_FAMILY_VISIBILITY };
const off = (...c: (keyof FamilyVisibility)[]): FamilyVisibility => ({ ...on, ...Object.fromEntries(c.map((k) => [k, false])) });

const week = lastCompletedWeek(new Date("2026-11-11T15:00:00Z"), "America/New_York"); // Nov 2 - Nov 8
const input: DigestInput = {
  fullName: "Maya Chen",
  week,
  completed: [{ title: "Upload transcript" }, { title: "Draft (v2): activities" }],
  open: [
    { title: "Brag sheet", due_date: "2026-11-01" },
    { title: "Ask for a recommendation", due_date: "2026-11-12" },
  ],
  deadlines: [{ name: "Boston University", date: "2026-11-15" }],
  essays: [{ label: "Personal statement", words: 412, delta: 85 }],
};
const digest = buildWeeklyDigest(input)!;
const report = { title: digest.title, summary: digest.summary, body: digest.body, highlights: digest.highlights };

// ---- The switches ------------------------------------------------------------------------------------------------

test("no row, or a row without the columns, is everything on: what was sent before the switches", () => {
  assert.deepEqual(visibilityFromRow(null), on);
  assert.deepEqual(visibilityFromRow({ copy_parents: true }), on);
  assert.deepEqual(visibilityFromRow({ parents_get_tasks: true, parents_get_colleges: true, parents_get_essays: true }), on);
});

test("only an explicit true is on: false, or any value nobody expected, reads as off", () => {
  assert.deepEqual(visibilityFromRow({ parents_get_essays: false }), off("essays"));
  assert.deepEqual(visibilityFromRow({ parents_get_tasks: null, parents_get_colleges: "yes" }), off("tasks", "colleges"));
});

test("loadFamilyVisibility: a row's switches, available", async () => {
  const db = fakeDb({ student_alert_prefs: [{ student_id: "s1", parents_get_essays: false, updated_at: "2026-11-10T00:00:00Z" }] });
  const s = await loadFamilyVisibility(db as unknown as SupabaseClient, "s1");
  assert.deepEqual(s, { available: true, visibility: off("essays"), updatedAt: "2026-11-10T00:00:00Z" });
});

test("loadFamilyVisibility: no row is the default, available", async () => {
  const s = await loadFamilyVisibility(fakeDb({ student_alert_prefs: [] }) as unknown as SupabaseClient, "s1");
  assert.deepEqual(s, { available: true, visibility: on, updatedAt: null });
});

test("loadFamilyVisibility: before the migration (columns missing) it is not switched on yet, everything on", async () => {
  const db = fakeDb({ student_alert_prefs: [{ student_id: "s1" }], "missing:columns": [{ table: "student_alert_prefs", column: "parents_get_tasks" }] });
  const s = await loadFamilyVisibility(db as unknown as SupabaseClient, "s1");
  assert.deepEqual(s, { available: false, visibility: on, updatedAt: null });
});

/** A database whose student_alert_prefs reads fail with `code`; every other table is the fake. */
function failingPrefs(tables: Record<string, Row[]>, code = "57014") {
  const db = fakeDb(tables);
  return {
    ...db,
    from(table: string) {
      if (table !== "student_alert_prefs") return db.from(table);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "maybeSingle", "single", "limit", "order"]) chain[m] = () => chain;
      chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { code, message: "statement timeout" } }).then(ok, bad);
      return chain;
    },
  };
}

test("loadFamilyVisibility fails closed: an errored read throws, it never reads as the default", async () => {
  await assert.rejects(loadFamilyVisibility(failingPrefs({}) as unknown as SupabaseClient, "s1"));
});

test("labelList names the kinds for a reason", () => {
  assert.equal(labelList(["essays"]), "Essay progress");
  assert.equal(labelList(["tasks", "essays"]), "Tasks and overdue work and Essay progress");
  assert.equal(labelList(["tasks", "colleges", "essays"]), "Tasks and overdue work, College deadlines and Essay progress");
});

// ---- The weekly report ---------------------------------------------------------------------------------------------

test("every switch on: the weekly report is returned untouched (nothing changes on deploy)", () => {
  const r = applyToWeeklyReport(report, on);
  assert.equal(r.report, report);
  assert.deepEqual(r.leftOut, []);
  assert.equal(r.nothingLeft, false);
  assert.equal(filterDigestSummary(report.summary, on), report.summary);
});

test("each section of the digest is told apart by its first words", () => {
  const kinds = digest.body.split("\n\n").map(sectionCategory);
  assert.deepEqual(kinds, [null, "tasks", "tasks", "colleges", "essays"]);
});

test("essays off: the essays section, its count in the text and its highlight are left out; the rest is byte for byte", () => {
  const r = applyToWeeklyReport(report, off("essays"));
  assert.ok(!/Essays \(word counts only\)/.test(r.report.body!));
  assert.ok(!/412 words/.test(r.report.body!));
  assert.ok(!/essays/i.test(r.report.summary!), r.report.summary!);
  assert.ok(!r.report.highlights!.some((h) => /words/.test(h)), JSON.stringify(r.report.highlights));
  assert.equal(r.report.body, digest.body.split("\n\n").slice(0, 4).join("\n\n"));
  assert.equal(r.report.summary, "Maya's week (Nov 2 to Nov 8): 2 tasks finished, 1 overdue, 1 due in the next two weeks, 1 college deadline coming up.");
  assert.deepEqual(r.leftOut, ["essays"]);
  assert.equal(r.nothingLeft, false);
});

test("tasks off: both task sections and their counts go; deadlines and essays stay", () => {
  const r = applyToWeeklyReport(report, off("tasks"));
  assert.ok(!/Finished this week|Coming up or overdue|Upload transcript|Brag sheet/.test(r.report.body!));
  assert.ok(/Boston University/.test(r.report.body!) && /Personal statement: 412 words/.test(r.report.body!));
  assert.equal(r.report.summary, "Maya's week (Nov 2 to Nov 8): 1 college deadline coming up, essays +85 words.");
  assert.deepEqual(r.leftOut, ["tasks"]);
});

test("college deadlines off: the schools on the list are named nowhere", () => {
  const r = applyToWeeklyReport(report, off("colleges"));
  assert.ok(!JSON.stringify(r.report).includes("Boston University"));
  assert.deepEqual(r.leftOut, ["colleges"]);
});

test("a kind switched off that this week had nothing of is not 'left out'", () => {
  const quiet = buildWeeklyDigest({ ...input, essays: [] })!;
  const r = applyToWeeklyReport({ title: quiet.title, summary: quiet.summary, body: quiet.body, highlights: quiet.highlights }, off("essays"));
  assert.deepEqual(r.leftOut, []);
  assert.equal(r.report.body, quiet.body);
});

test("everything off: nothing is left to send", () => {
  const r = applyToWeeklyReport(report, off("tasks", "colleges", "essays"));
  assert.equal(r.nothingLeft, true);
  assert.deepEqual(r.leftOut, ["tasks", "colleges", "essays"]);
  assert.equal(r.report.body, digest.body.split("\n\n")[0]);
});

test("a summary that isn't the digest's shape (edited, or cut short) is dropped, never kept as is", () => {
  assert.equal(filterDigestSummary("Maya did great this week, essays +85 words", off("essays")), null);
  // Cut at the text limit: the last count can't be told apart, so it goes too.
  assert.equal(filterDigestSummary("Maya's week (Nov 2 to Nov 8): 2 tasks finished, essays +8…", off("essays")), null);
  const cut = "Maya's week (Nov 2 to Nov 8): 2 tasks finished, 1 overdue, essays +8.";
  assert.equal(filterDigestSummary(cut, off("colleges")), "Maya's week (Nov 2 to Nov 8): 2 tasks finished, 1 overdue.");
});

test("with the summary dropped, the text falls back to the filtered body, never the hidden section", () => {
  const r = applyToWeeklyReport({ ...report, summary: "Edited by hand: essays +85 words" }, off("essays"));
  assert.equal(r.report.summary, null);
  const text = smsTextOf(r.report);
  assert.ok(text.startsWith("Here is Maya's week") && !/words/.test(text), text);
});

test("the preview a counselor reads and the rows approve-send writes carry the filtered text", () => {
  const filtered = applyToWeeklyReport(report, off("essays")).report;
  const msgs = reportMessages(
    filtered,
    [{ guardianId: "g1", name: "Rosa Chen", relationship: "Mother", email: "rosa@test.local", phone: "+15555550100", channels: ["email", "sms"] }],
    { counselorName: "Dana Park", studentName: "Maya Chen" }
  );
  assert.equal(msgs.length, 2);
  for (const m of msgs) assert.ok(!/Personal statement|essays \+85/.test(m.text), m.text);
  assert.ok(msgs[0]!.text.includes("Upload transcript"));
  assert.ok(!/Essays/.test(emailBodyOf(filtered)));
});

// ---- The dispatch re-check -----------------------------------------------------------------------------------------

test("revealsHidden: a message written before a switch went off still carries the kind (email body and text)", () => {
  assert.deepEqual(revealsHidden(emailBodyOf(report), off("essays")), ["essays"]);
  assert.deepEqual(revealsHidden(smsTextOf(report), off("essays")), ["essays"]);
  assert.deepEqual(revealsHidden(smsTextOf(report), off("tasks", "colleges")), ["tasks", "colleges"]);
});

test("revealsHidden: a message written after the switch went off passes, and so does anything with every switch on", () => {
  const filtered = applyToWeeklyReport(report, off("essays")).report;
  assert.deepEqual(revealsHidden(emailBodyOf(filtered), off("essays")), []);
  assert.deepEqual(revealsHidden(smsTextOf(filtered), off("essays")), []);
  assert.deepEqual(revealsHidden(emailBodyOf(report), on), []);
});

test("revealsHidden: a task title with '): ' in an email body is not read as a count", () => {
  const body = "Here is Maya's week.\n\nFinished this week (1):\n- Draft (v2): essays +85 words";
  assert.deepEqual(revealsHidden(body, off("essays")), []);
});

// ---- The escalation sweep ------------------------------------------------------------------------------------------

const STUDENT = "33333333-3333-4333-8333-333333333333";
const COUNSELOR = "11111111-1111-4111-8111-111111111111";
const GUARDIAN = "55555555-5555-4555-8555-555555555555";

function sweepTables(prefs: Row): Record<string, Row[]> {
  return {
    accountability_settings: [],
    red_flags: [
      {
        id: "flag-1",
        student_id: STUDENT,
        status: "open",
        escalate_at: "2026-01-01T00:00:00Z",
        title: "Personal statement stalled",
        message: "No progress in 9 days",
        action_items: [],
        deliverable_id: null,
      },
    ],
    parent_alerts: [],
    student_messages: [],
    student_alert_prefs: [{ student_id: STUDENT, copy_parents: true, copy_student: false, ...prefs }],
    guardians: [{ id: GUARDIAN, student_id: STUDENT, alerts_enabled: true, is_primary: true }],
  };
}

test("the sweep's reason names the kind as the card does", () => {
  assert.ok(TASKS_OFF_REASON.startsWith(FAMILY_LABELS.tasks));
});

test("sweep, every switch on: the parents get the alert, as before", async () => {
  const t = sweepTables({});
  const r = await runEscalationSweep({ db: fakeDb(t) as unknown as SupabaseClient }, COUNSELOR, { studentIds: [STUDENT] });
  assert.equal(r.escalated, 1);
  assert.equal(t.parent_alerts!.length, 1);
  assert.equal(t.parent_alerts![0]!.guardian_id, GUARDIAN);
});

test("sweep, before the migration: the parents get the alert, as before", async () => {
  const t = { ...sweepTables({}), "missing:columns": [{ table: "student_alert_prefs", column: "parents_get_tasks" }] };
  const r = await runEscalationSweep({ db: fakeDb(t) as unknown as SupabaseClient }, COUNSELOR, { studentIds: [STUDENT] });
  assert.equal(r.escalated, 1);
  assert.equal(t.parent_alerts![0]!.guardian_id, GUARDIAN);
});

test("sweep, tasks off: no alert to the parents, the flag stays open, and the reason says why", async () => {
  const t = sweepTables({ parents_get_tasks: false });
  const r = await runEscalationSweep({ db: fakeDb(t) as unknown as SupabaseClient }, COUNSELOR, { studentIds: [STUDENT] });
  assert.equal(r.escalated, 0);
  assert.deepEqual(r.skipped, [{ id: "flag-1", reason: TASKS_OFF_REASON }]);
  assert.equal(t.parent_alerts!.length, 0);
  assert.equal(t.red_flags![0]!.status, "open");
});

test("sweep, tasks off with the student copied: the student's copy goes, the parents are left off it", async () => {
  const t = sweepTables({ parents_get_tasks: false, copy_student: true });
  const r = await runEscalationSweep({ db: fakeDb(t) as unknown as SupabaseClient }, COUNSELOR, { studentIds: [STUDENT] });
  assert.equal(r.escalated, 1);
  assert.equal(t.parent_alerts![0]!.guardian_id, null);
  assert.equal(t.parent_alerts![0]!.copy_student, true);
});

test("sweep, essays or college deadlines off: an alert about stalled work still reaches the parents", async () => {
  const t = sweepTables({ parents_get_essays: false, parents_get_colleges: false });
  const r = await runEscalationSweep({ db: fakeDb(t) as unknown as SupabaseClient }, COUNSELOR, { studentIds: [STUDENT] });
  assert.equal(r.escalated, 1);
  assert.equal(t.parent_alerts![0]!.guardian_id, GUARDIAN);
});
