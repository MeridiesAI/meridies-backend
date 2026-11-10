import assert from "node:assert/strict";
import { test } from "node:test";
import { isGone, payloadFor, safeHref, summaryPayload } from "../../src/lib/push.js";

test("a payload carries a label by kind and never the row's own words", () => {
  const p = payloadFor({ kind: "red-flag", href: "/dashboard/counselor/students/1", title: "Maya's essay", body: "secret" } as never);
  assert.equal(p.title, "Meridies");
  assert.equal(p.href, "/dashboard/counselor/students/1");
  assert.ok(!JSON.stringify(p).includes("Maya"));
  assert.ok(!JSON.stringify(p).includes("secret"));
});

test("an unknown kind falls back to the generic line", () => {
  assert.equal(payloadFor({ kind: "nope" }).body, "You have a new notification.");
});

test("only an in-app path is ever followed", () => {
  assert.equal(safeHref("/dashboard"), "/dashboard");
  for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "dashboard", "", null, undefined, 5, "/a b"]) {
    assert.equal(safeHref(bad), "/", String(bad));
  }
  assert.equal(safeHref("/" + "a".repeat(400)), "/");
});

test("a run of several becomes one summary", () => {
  assert.equal(summaryPayload(5, "/x").body, "You have 5 new notifications.");
  assert.equal(summaryPayload(0, "/x").href, "/");
});

test("404 and 410 mean the device is gone; other statuses do not", () => {
  assert.equal(isGone(404), true);
  assert.equal(isGone(410), true);
  for (const s of [200, 400, 401, 429, 500, undefined]) assert.equal(isGone(s), false);
});
