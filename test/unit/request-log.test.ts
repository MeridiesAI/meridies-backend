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
