// lib/email.ts: attachments and Reply-To reach Resend, and a 429 is retried
// once after Retry-After when the caller asks for it. fetch is replaced; no
// network. The key is set before the module loads (env is read at import).
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.RESEND_API_KEY = "re_test_0000000000000000";
delete process.env.DEV_MAIL_URL;
const { sendEmail, retryAfterMs } = await import("../../src/lib/email.js");

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(statuses: number[]) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    const ok = status >= 200 && status < 300;
    return new Response(JSON.stringify(ok ? { id: `re_${calls.length}` } : { message: "Too many requests" }), {
      status,
      headers: { "retry-after": "1" },
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const base = { to: "avery@example.com", subject: "Invitation", html: "<p>x</p>", text: "x", template: "meeting-invite" };

test("attachments and Reply-To are sent in Resend's shape", async () => {
  const f = fakeFetch([200]);
  try {
    const r = await sendEmail({
      ...base,
      replyTo: "dana@practice.test",
      attachments: [{ filename: "invite.ics", content: Buffer.from("BEGIN:VCALENDAR").toString("base64"), contentType: "text/calendar; charset=utf-8; method=REQUEST" }],
    });
    assert.equal(r.sent, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.body.reply_to, "dana@practice.test");
    assert.deepEqual(f.calls[0]!.body.attachments, [
      { filename: "invite.ics", content: Buffer.from("BEGIN:VCALENDAR").toString("base64"), content_type: "text/calendar; charset=utf-8; method=REQUEST" },
    ]);
  } finally {
    f.restore();
  }
});

test("a plain email carries neither field", async () => {
  const f = fakeFetch([200]);
  try {
    await sendEmail(base);
    assert.equal("attachments" in f.calls[0]!.body, false);
    assert.equal("reply_to" in f.calls[0]!.body, false);
  } finally {
    f.restore();
  }
});

test("a 429 is retried once when asked, and not otherwise", async () => {
  const retried = fakeFetch([429, 200]);
  try {
    const r = await sendEmail({ ...base, retryOn429: true });
    assert.equal(retried.calls.length, 2);
    assert.equal(r.sent, true);
  } finally {
    retried.restore();
  }
  const twice = fakeFetch([429, 429]);
  try {
    const r = await sendEmail({ ...base, retryOn429: true });
    assert.equal(twice.calls.length, 2, "one retry, no more");
    assert.equal(r.sent, false);
  } finally {
    twice.restore();
  }
  const plain = fakeFetch([429, 200]);
  try {
    const r = await sendEmail(base);
    assert.equal(plain.calls.length, 1);
    assert.equal(r.sent, false);
  } finally {
    plain.restore();
  }
});

test("Retry-After is kept between one and ten seconds", () => {
  assert.equal(retryAfterMs(null), 1000);
  assert.equal(retryAfterMs("abc"), 1000);
  assert.equal(retryAfterMs("0"), 1000);
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs("120"), 10_000);
});
