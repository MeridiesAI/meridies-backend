// The evals' controllable clock (AxIS activity drafts, plan Task 9): the control route exists only in clock mode,
// and only the cron secret may move the clock.
process.env.CRON_SECRET = "eval-clock-test-secret-0123456789abcdef";
import assert from "node:assert/strict";
import { test } from "node:test";

test("the clock route exists only in clock mode and needs the cron secret", async () => {
  const { buildApp } = await import("../../src/app.js");
  const { axisNow } = await import("../../src/lib/axis/clock.js");
  delete process.env.AXIS_EVAL_CLOCK;
  const off = buildApp();
  const missing = await off.inject({ method: "POST", url: "/axis/eval/clock", payload: { minutes: 31 }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(missing.statusCode, 404, "not registered without the flag");
  await off.close();

  process.env.AXIS_EVAL_CLOCK = "on";
  try {
    const on = buildApp();
    const anon = await on.inject({ method: "POST", url: "/axis/eval/clock", payload: { minutes: 31 } });
    assert.equal(anon.statusCode, 401, "the cron secret is required");
    const before = axisNow().getTime();
    const ok = await on.inject({ method: "POST", url: "/axis/eval/clock", payload: { minutes: 31 }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(axisNow().getTime() - before >= 31 * 60_000 - 1000, "the clock moved 31 minutes");
    assert.equal(JSON.parse(ok.body).now.slice(0, 10).length, 10);
    const bad = await on.inject({ method: "POST", url: "/axis/eval/clock", payload: { minutes: 0 }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    assert.equal(bad.statusCode, 400);
    await on.close();
  } finally {
    delete process.env.AXIS_EVAL_CLOCK;
  }
});
