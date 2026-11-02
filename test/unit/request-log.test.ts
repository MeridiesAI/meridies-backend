import assert from "node:assert/strict";
import { test } from "node:test";
import { loggedUrl } from "../../src/lib/requestLog.js";

test("query values are dropped, keys are kept", () => {
  assert.equal(loggedUrl("/integrations/google/complete?code=abc&state=xyz"), "/integrations/google/complete?code=…&state=…");
  assert.equal(loggedUrl("/health"), "/health");
});

test("the account review token never reaches the logs", () => {
  const token = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXU";
  assert.equal(loggedUrl(`/access-review/${token}`), "/access-review/…");
  assert.equal(loggedUrl(`//access-review/${token}/?x=1`), "/access-review/…?x=…");
  assert.ok(!loggedUrl(`/access-review/${token}`).includes(token));
});

test("an unsubscribe token never reaches the logs", () => {
  const token = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXU";
  assert.equal(loggedUrl(`/kpi/unsubscribe/${token}`), "/kpi/unsubscribe/…");
  assert.equal(loggedUrl(`/pipeline/unsubscribe/${token}`), "/pipeline/unsubscribe/…");
  assert.equal(loggedUrl(`//pipeline/unsubscribe/${token}/?x=1`), "/pipeline/unsubscribe/…?x=…");
  assert.ok(!loggedUrl(`/kpi/unsubscribe/${token}`).includes(token));
  // Other paths are left alone.
  assert.equal(loggedUrl("/pipeline/contacts"), "/pipeline/contacts");
});

test("redactText strips emails, tokens, keys, phones and query values", async () => {
  const { redactText } = await import("../../src/lib/requestLog.js");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const out = redactText(
    `user ada.lovelace+test@example.co.uk sent Bearer ${jwt} with key sk-ant-api03-abcDEF_123 ` +
      `to +14155550123 at https://docs.example.com/d/abc?token=s3cr3t&x=1#frag and ${jwt}`
  );
  for (const leak of ["ada.lovelace", "example.co.uk", jwt, "sk-ant-api03", "4155550123", "s3cr3t"]) {
    assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  }
  assert.match(out, /\[email\]/);
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /https:\/\/docs\.example\.com\/d\/abc\?…#frag/);
  assert.equal(redactText("plain message"), "plain message");
  const long = redactText("x".repeat(5000));
  assert.ok(long.length < 2100 && long.includes("more characters"));
});

test("serializeErr keeps type, message, codes and stack, and drops values", async () => {
  const { serializeErr } = await import("../../src/lib/requestLog.js");
  const pg = { code: "23505", message: "duplicate key value", details: "Key (email)=(kid@school.org) already exists", hint: null };
  const s = serializeErr(pg);
  assert.equal(s.code, "23505");
  assert.equal(s.message, "duplicate key value");
  assert.ok(!JSON.stringify(s).includes("kid@school.org"));

  const sdk = Object.assign(new Error("400 bad request for parent@family.com"), {
    status: 400,
    headers: { authorization: "Bearer abc" },
    request: { body: "the student's whole essay" },
    cause: new Error("inner token=eyJabcdefgh.eyJabcdefgh.sig"),
  });
  const t = serializeErr(sdk);
  const json = JSON.stringify(t);
  assert.equal(t.type, "Error");
  assert.equal(t.status, 400);
  for (const leak of ["parent@family.com", "authorization", "whole essay", "eyJabcdefgh"]) {
    assert.ok(!json.includes(leak), `${leak} leaked: ${json}`);
  }
  assert.equal(serializeErr("text with a@b.io").message, "text with [email]");

  const a: Record<string, unknown> = { message: "a" };
  const b: Record<string, unknown> = { message: "b", cause: a };
  a.cause = b;
  assert.doesNotThrow(() => serializeErr(a));
});

test("logHost keeps the host only", async () => {
  const { logHost } = await import("../../src/lib/requestLog.js");
  assert.equal(logHost("https://docs.google.com/document/d/secret?usp=sharing"), "docs.google.com");
  assert.equal(logHost("not a url"), null);
});
