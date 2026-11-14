import assert from "node:assert/strict";
import { test } from "node:test";
import { draftPayload, draftProblem, payloadProblem, sendAtFor, toDraftDTO } from "../../src/lib/invoiceDrafts.js";

const NOW = Date.parse("2026-11-13T15:00:00Z");
const ctx = { tz: "America/New_York", now: NOW, today: "2026-11-13" };
const base = { label: "Installment 2 of 3", amountCents: 150_000, dueOn: "2026-12-01" };

test("a draft's payload is an invoice body plus a schedule, strictly", () => {
  const p = draftPayload.parse({ ...base, methods: ["card", "zelle"], note: "hi", schedule: { mode: "before_due", daysBefore: 7 }, reminders: [-3, 0, 3] });
  assert.equal(p.schedule?.mode, "before_due");
  assert.throws(() => draftPayload.parse({ ...base, schedule: { mode: "whenever" } }));
  assert.throws(() => draftPayload.parse({ ...base, send: false }));
  assert.throws(() => draftPayload.parse({ ...base, schedule: { mode: "date" } }));
});

test("a plain draft can be saved half-finished but never with a broken body", () => {
  assert.equal(draftProblem(draftPayload.parse(base), "draft", ctx), null);
  assert.equal(draftProblem(draftPayload.parse({ ...base, lines: [{ description: "x", amountCents: 1 }] }), "draft", ctx)?.code, "lines_sum_mismatch");
  assert.equal(draftProblem(draftPayload.parse({ ...base, dueOn: "2026-11-01" }), "draft", ctx)?.code, "due_passed");
  assert.equal(draftProblem(draftPayload.parse({ ...base, channel: "text", agreement: { agreementId: "11111111-2222-3333-4444-555555555555" } }), "draft", ctx)?.code, "text_no_agreement");
});

test("a scheduled draft needs a send time that is still ahead", () => {
  const ok = draftPayload.parse({ ...base, schedule: { mode: "before_due", daysBefore: 7 } });
  assert.equal(draftProblem(ok, "scheduled", ctx), null);
  assert.equal(sendAtFor(ok, "scheduled", ctx), "2026-11-24T14:00:00.000Z");
  const past = draftPayload.parse({ ...base, dueOn: "2026-11-15", schedule: { mode: "before_due", daysBefore: 7 } });
  assert.equal(draftProblem(past, "scheduled", ctx)?.code, "send_time_passed");
});

test("scheduled with no schedule (or send now) is due on the next cron run", () => {
  const p = draftPayload.parse(base);
  assert.equal(draftProblem(p, "scheduled", ctx), null);
  assert.ok(Date.parse(sendAtFor(p, "scheduled", ctx)!) < NOW);
  assert.equal(sendAtFor(p, "draft", ctx), null);
});

test("the draft DTO", () => {
  const d = toDraftDTO({ id: "i", contact_id: "c", payload: base, state: "scheduled", send_at: "2026-11-24T14:00:00Z", repeat_yearly: true, sent_invoice_id: null, sent_at: null, attempts: 1, last_error: null, created_at: "a", updated_at: "b" });
  assert.deepEqual([d.state, d.repeatYearly, d.attempts, d.sendAt], ["scheduled", true, 1, "2026-11-24T14:00:00Z"]);
});

test("the body rules alone (what the cron re-checks at send time) need no clock", () => {
  assert.equal(payloadProblem(draftPayload.parse(base)), null);
  assert.equal(payloadProblem(draftPayload.parse({ ...base, lines: [{ description: "x", amountCents: 1 }] }))?.code, "lines_sum_mismatch");
  assert.equal(payloadProblem(draftPayload.parse({ ...base, reminders: [31] }))?.code, "bad_reminders");
  assert.equal(payloadProblem(draftPayload.parse({ ...base, channel: "text", agreement: { contractId: "11111111-2222-3333-4444-555555555555" } }))?.code, "text_no_agreement");
});
