import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { brandedEmail } from "../../src/lib/email.js";
import {
  TOKEN_SHAPE, hashReviewToken, newReviewToken, oneLine, reviewEmail, reviewPage, type Applicant,
} from "../../src/lib/accessReview.js";

const hostile: Applicant = {
  id: "00000000-0000-0000-0000-000000000001",
  fullName: `<script>alert("x")</script> O'Brien`,
  email: "ob@example.com",
  practice: `"><img src=x onerror=alert(1)>`,
  firmSize: "2-5",
  signedUpAt: "2026-10-10T12:00:00Z",
  revokedAt: null,
};

test("a token is 43 url-safe characters and only its sha256 is its hash", () => {
  const { token, hash } = newReviewToken();
  assert.match(token, TOKEN_SHAPE);
  assert.equal(hash, createHash("sha256").update(token).digest("hex"));
  assert.equal(hashReviewToken(token), hash);
  assert.notEqual(newReviewToken().token, token);
});

test("oneLine removes line breaks and control characters and caps the length", () => {
  assert.equal(oneLine("a\r\nBcc: x@y.z\tb"), "a Bcc: x@y.z b");
  assert.equal(oneLine("x".repeat(500), 120).length, 120);
});

test("the review email escapes the name and the practice", () => {
  const mail = reviewEmail(hostile, "https://api.example.com/access-review/abc");
  const html = brandedEmail(mail.content);
  assert.ok(!html.includes("<script>"), "raw script tag in the email");
  assert.ok(!html.includes("<img"), "raw img tag in the email");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("https://api.example.com/access-review/abc"));
});

test("the subject is one line and carries only the account email", () => {
  const mail = reviewEmail({ ...hostile, email: "a@b.c\r\nBcc: evil@x.y" }, "https://x/y");
  assert.ok(!/[\r\n]/.test(mail.subject));
  assert.ok(!mail.subject.includes("script"));
});

test("a previously revoked account says so", () => {
  const mail = reviewEmail({ ...hostile, revokedAt: "2026-10-01T00:00:00Z" }, "https://x/y");
  assert.ok(mail.content.paragraphs.some((p) => /revoked/i.test(p)));
});

test("the confirm page shows who is being approved, escaped, with a POST form", () => {
  const html = reviewPage({ kind: "confirm", applicant: hostile });
  assert.ok(!html.includes("<script>") && !html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;") && html.includes("O&#39;Brien"));
  assert.ok(html.includes("ob@example.com"));
  assert.match(html, /<form method="post" action="">/);
});

test("the invalid page offers nothing to press", () => {
  const html = reviewPage({ kind: "invalid" });
  assert.ok(!html.includes("<form"));
  assert.match(html, /no longer valid/i);
});
