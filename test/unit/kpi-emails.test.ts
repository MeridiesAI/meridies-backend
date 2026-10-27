import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConsultantEmail, renderFirmEmail } from "../../src/lib/kpi/emails.js";
import { buildReport, type CompletionRow } from "../../src/lib/kpi/report.js";

const row = (o: Partial<CompletionRow>): CompletionRow => ({
  task_type: "college_list", student_id: "s1", month: "2026-10-01", manual_minutes: 240, manual_is_estimate: false,
  meridies_minutes: 30, measure_method: "active", saved_minutes: 210, hourly_rate: 150, rate_is_estimate: false, ...o,
});
const names = { s1: "Zelda Quartermaine", s2: "Ignatius Plumtree" };
const report = (o: Partial<CompletionRow> = {}) =>
  buildReport([row(o), row({ student_id: "s2", ...o })], [row(o)], 1, { aiRuns: {}, researchRuns: {} }, "2026-10", names);
const LINK = "https://app.example/dashboard/counselor/time-saved?month=2026-10";
const UNSUB = "https://api.example/kpi/unsubscribe/tok";

test("consultant email never names a student", () => {
  const e = renderConsultantEmail(report(), LINK, UNSUB);
  for (const part of [e.subject, e.html, e.text]) {
    assert.ok(!part.includes("Zelda") && !part.includes("Quartermaine") && !part.includes("Plumtree"), part);
  }
});

test("consultant email has the headline totals, the link and an unsubscribe link", () => {
  const e = renderConsultantEmail(report(), LINK, UNSUB);
  assert.match(e.subject, /October 2026/);
  assert.match(e.text, /7 hours saved/);
  assert.match(e.text, /2 students/);
  assert.ok(e.html.includes(LINK) && e.text.includes(LINK));
  assert.ok(e.html.includes(UNSUB) && e.text.includes(UNSUB));
  assert.equal(e.headers["List-Unsubscribe"], `<${UNSUB}>`);
  assert.equal(e.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("value and extra students are offered as either/or", () => {
  const e = renderConsultantEmail(report(), LINK, UNSUB);
  assert.match(e.text, /\$1,050 of your time, or room for/);
});

test("a default rate or figure keeps its estimated label", () => {
  const e = renderConsultantEmail(report({ rate_is_estimate: true, manual_is_estimate: true }), LINK, UNSUB);
  assert.match(e.text, /estimated/);
  assert.match(e.html, /estimated/);
});

test("firm email shows totals only", () => {
  const e = renderFirmEmail({ month: "2026-10", hoursSaved: 12.5, valueOfTime: 1875, completions: 9, students: 6 }, "Acme Counseling", LINK, UNSUB);
  assert.match(e.subject, /Acme Counseling/);
  assert.match(e.text, /12\.5 hours saved/);
  assert.match(e.text, /\$1,875/);
  assert.ok(e.text.includes(UNSUB));
});

test("html escapes the firm name", () => {
  const e = renderFirmEmail({ month: "2026-10", hoursSaved: 1, valueOfTime: null, completions: 1, students: 1 }, "<b>Evil</b>", LINK, UNSUB);
  assert.ok(!e.html.includes("<b>Evil</b>"));
});
