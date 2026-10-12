import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryReason, latestByInvitation, toInviteDelivery } from "../../src/lib/inviteDelivery.js";

test("a row only sent is reported as sent, never delivered", () => {
  const d = toInviteDelivery({ status: "sent", channel: "email", sent_at: "2026-10-08T10:00:00Z", created_at: "2026-10-08T10:00:00Z" });
  assert.equal(d?.status, "sent");
  assert.equal(d?.deliveredAt, null);
  assert.equal(d?.reason, null);
});

test("delivered carries its time; queued stays queued", () => {
  assert.equal(toInviteDelivery({ status: "delivered", delivered_at: "2026-10-08T10:01:00Z", created_at: "x" })?.deliveredAt, "2026-10-08T10:01:00Z");
  assert.equal(toInviteDelivery({ status: "queued", created_at: "2026-10-08T10:00:00Z" })?.status, "queued");
  assert.equal(toInviteDelivery({ status: "made-up", created_at: "x" }), null);
});

test("failure reasons are shown, configuration errors are not", () => {
  assert.equal(deliveryReason("failed", "RESEND_API_KEY unset"), "Email isn't set up on the server yet");
  assert.equal(deliveryReason("bounced", "marked as spam by the recipient"), "marked as spam by the recipient");
  assert.equal(deliveryReason("bounced", null), "The address bounced");
  assert.equal(deliveryReason("sent", "anything"), null);
  assert.equal(deliveryReason("failed", "x".repeat(300))?.length, 200);
});

test("the newest attempt wins per invitation", () => {
  const m = latestByInvitation([
    { invitation_id: "a", status: "bounced", error: "bounced", created_at: "2" },
    { invitation_id: "a", status: "sent", created_at: "1" },
    { invitation_id: "b", status: "delivered", created_at: "1" },
    { invitation_id: null, status: "sent", created_at: "3" },
  ]);
  assert.equal(m.get("a")?.status, "bounced");
  assert.equal(m.get("b")?.status, "delivered");
  assert.equal(m.size, 2);
});
