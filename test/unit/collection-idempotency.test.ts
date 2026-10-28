import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import { idempotencyKey, isMissingRequestId } from "../../src/lib/collection.js";

test("idempotencyKey: absent means no key", () => {
  assert.equal(idempotencyKey(undefined), null);
});

test("idempotencyKey: a uuid is kept, lowercased and trimmed", () => {
  assert.equal(
    idempotencyKey(" 3F2504E0-4F89-11D3-9A0C-0305E82C3301 "),
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
  );
  assert.equal(
    idempotencyKey(["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "other"]),
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
  );
});

test("idempotencyKey: anything else is a 400, not silently ignored", () => {
  for (const bad of ["", "abc", "3f2504e0-4f89-11d3-9a0c", "'; drop table activities; --"]) {
    assert.throws(
      () => idempotencyKey(bad),
      (e: unknown) => e instanceof HttpError && e.statusCode === 400,
      bad
    );
  }
});

test("isMissingRequestId: only the client_request_id column, by either error shape", () => {
  assert.equal(isMissingRequestId({ code: "42703", message: 'column "client_request_id" does not exist' }), true);
  assert.equal(
    isMissingRequestId({ code: "PGRST204", message: "Could not find the 'client_request_id' column of 'activities'" }),
    true
  );
  assert.equal(isMissingRequestId({ code: "42703", message: 'column "other" does not exist' }), false);
  assert.equal(isMissingRequestId({ code: "23505", message: "client_request_id duplicate" }), false);
  assert.equal(isMissingRequestId(null), false);
});
