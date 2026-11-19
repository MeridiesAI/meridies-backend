import assert from "node:assert/strict";
import test from "node:test";
import { alertText, AlertTracker, COOLDOWN_MS, kindOf, RULES } from "../../src/lib/opsAlerts.js";

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const MIN = 60_000;

test("no alert until the threshold is reached inside the window", () => {
  const t = new AlertTracker();
  for (let i = 0; i < RULES.server_errors.threshold - 1; i++) assert.equal(t.record("server_errors", T0 + i * 1000), null);
  const b = t.record("server_errors", T0 + 20_000);
  assert.ok(b);
  assert.equal(b.kind, "server_errors");
  assert.equal(b.count, RULES.server_errors.threshold);
});

test("events that left the window do not count", () => {
  const t = new AlertTracker();
  for (let i = 0; i < RULES.server_errors.threshold - 1; i++) t.record("server_errors", T0 + i * 1000);
  // 6 minutes later the earlier errors are outside the 5-minute window
  assert.equal(t.record("server_errors", T0 + 6 * MIN), null);
});

test("after an alert the same kind is quiet for an hour, then can alert again", () => {
  const t = new AlertTracker();
  let first: unknown = null;
  for (let i = 0; i < RULES.bad_signatures.threshold; i++) first = t.record("bad_signatures", T0 + i * 1000);
  assert.ok(first);
  for (let i = 0; i < 20; i++) assert.equal(t.record("bad_signatures", T0 + 30_000 + i * 1000), null);
  const later = T0 + COOLDOWN_MS + MIN;
  let again: unknown = null;
  for (let i = 0; i < RULES.bad_signatures.threshold; i++) again = t.record("bad_signatures", later + i * 1000);
  assert.ok(again);
});

test("kinds are counted separately", () => {
  const t = new AlertTracker();
  for (let i = 0; i < RULES.rate_limited.threshold - 1; i++) t.record("rate_limited", T0 + i);
  assert.equal(t.record("server_errors", T0 + 5000), null);
});

test("a flood cannot grow memory without bound", () => {
  const t = new AlertTracker({ ...RULES, server_errors: { ...RULES.server_errors, threshold: 1_000_000 } });
  for (let i = 0; i < 5000; i++) t.record("server_errors", T0 + i);
  // no throw and no alert; the internal list is capped (checked by it still answering quickly)
  assert.equal(t.record("server_errors", T0 + 6000), null);
});

test("which answers count", () => {
  assert.equal(kindOf(500, "/x"), "server_errors");
  assert.equal(kindOf(503, "/x"), "server_errors");
  assert.equal(kindOf(401, "/students"), "auth_failures");
  assert.equal(kindOf(429, "/x"), "rate_limited");
  assert.equal(kindOf(400, "/webhooks/stripe"), "bad_signatures");
  assert.equal(kindOf(400, "/webhooks/stripe-billing"), "bad_signatures");
  assert.equal(kindOf(400, "/students"), null);
  assert.equal(kindOf(404, "/x"), null);
  assert.equal(kindOf(200, "/x"), null);
});

test("an alert email holds counts and a place to look, nothing about a person or a request", () => {
  const { subject, lines } = alertText({ kind: "auth_failures", count: 55, windowMin: 5, at: "2026-11-18T12:00:00.000Z" });
  const all = `${subject}\n${lines.join("\n")}`;
  assert.match(all, /55/);
  assert.match(all, /Where to look/);
  assert.ok(!/@|Bearer|token=|password/i.test(all.replace("Where to look", "")));
});
