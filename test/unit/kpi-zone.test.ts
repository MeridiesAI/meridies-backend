import assert from "node:assert/strict";
import { test } from "node:test";
import { zonedMonthStart } from "../../src/lib/kpi/report.js";
import { unsubscribeBaseUrl } from "../../src/lib/kpi/monthly.js";

test("a month starts at local midnight in the consultant's time zone", () => {
  assert.equal(zonedMonthStart("2026-10", "America/Los_Angeles").toISOString(), "2026-10-01T07:00:00.000Z");
  // DST ends 2026-11-01 at 2am, so midnight on the 1st is still PDT.
  assert.equal(zonedMonthStart("2026-11", "America/Los_Angeles").toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(zonedMonthStart("2026-12", "America/Los_Angeles").toISOString(), "2026-12-01T08:00:00.000Z");
  assert.equal(zonedMonthStart("2026-10", "Asia/Kolkata").toISOString(), "2026-09-30T18:30:00.000Z");
});

test("an unknown or missing zone is UTC", () => {
  assert.equal(zonedMonthStart("2026-10", "Not/AZone").toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(zonedMonthStart("2026-10", null).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("unsubscribe links need the API's public address and fail loudly without it", () => {
  assert.equal(unsubscribeBaseUrl("https://api.example/"), "https://api.example");
  assert.throws(() => unsubscribeBaseUrl(undefined), /PUBLIC_API_URL/);
});

test("the footer uses the postal address when set, else the contact email (never blocks sending)", async () => {
  const { emailFooter } = await import("../../src/lib/kpi/monthly.js");
  assert.equal(emailFooter(" 1 Test Way, Testville, NY 10001 ", "team@meridiesai.com"), "Meridies · 1 Test Way, Testville, NY 10001");
  assert.equal(emailFooter(undefined, "team@meridiesai.com"), "Meridies · Questions? team@meridiesai.com");
});
