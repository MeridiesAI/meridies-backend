import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKey } from "../../src/plugins/rateLimit.js";

const req = (authorization?: string) => ({ ip: "203.0.113.7", headers: { authorization } }) as never;

test("a signed-in caller is counted on their own, not with everyone at their address", async () => {
  assert.equal(await clientKey(req("Bearer good"), async () => "user-1"), "user:user-1");
  assert.equal(await clientKey(req("Bearer other"), async () => "user-2"), "user:user-2");
});

test("no token, or one that doesn't verify, is counted by address", async () => {
  assert.equal(await clientKey(req(), async () => null), "203.0.113.7");
  assert.equal(await clientKey(req("Bearer forged"), async () => null), "203.0.113.7");
});

test("a verifier that throws falls back to the address rather than failing the request", async () => {
  assert.equal(await clientKey(req("Bearer x"), async () => { throw new Error("jwks down"); }), "203.0.113.7");
});
