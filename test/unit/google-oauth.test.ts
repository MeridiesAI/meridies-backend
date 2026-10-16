import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountMismatch, disallowedGoogleScopes, googleAuthorizeParams, googleScopesFor, GOOGLE_SCOPE,
} from "../../src/lib/oauth.js";

test("Connect asks for exactly openid, email and drive.file; Calendar adds exactly calendar.events", () => {
  assert.deepEqual(googleScopesFor(null), ["openid", "email", GOOGLE_SCOPE.driveFile]);
  assert.deepEqual(googleScopesFor("calendar"), ["openid", "email", GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.calendarEvents]);
  for (const s of [...googleScopesFor(null), ...googleScopesFor("calendar")]) {
    assert.ok(!/drive\.readonly|gmail/.test(s), s);
  }
});

test("a client string can never become a scope", () => {
  // The add-on is a closed union; anything else is refused before this point by zod (Task 4 route).
  assert.throws(() => googleScopesFor("gmail" as never));
});

test("the authorize parameters carry incremental consent and the login hint", () => {
  const p = googleAuthorizeParams({ add: "calendar", loginHint: "counselor@example.com" });
  assert.equal(p.scope, `openid email ${GOOGLE_SCOPE.driveFile} ${GOOGLE_SCOPE.calendarEvents}`);
  assert.equal(p.include_granted_scopes, "true");
  assert.equal(p.access_type, "offline");
  assert.equal(p.prompt, "consent");
  assert.equal(p.login_hint, "counselor@example.com");
  assert.equal("login_hint" in googleAuthorizeParams({ add: null, loginHint: null }), false);
});

test("anything Google returns outside the allowlist is flagged", () => {
  assert.deepEqual(disallowedGoogleScopes(["openid", "https://www.googleapis.com/auth/userinfo.email", GOOGLE_SCOPE.driveFile]), []);
  assert.deepEqual(disallowedGoogleScopes(["openid", GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.calendarEvents, "email"]), []);
  assert.deepEqual(
    disallowedGoogleScopes(["openid", GOOGLE_SCOPE.driveFile, "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/gmail.send"]),
    ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/gmail.send"]
  );
});

test("a different Google account than the connected one is a mismatch; a first connection is not", () => {
  assert.equal(accountMismatch(null, "111"), false);
  assert.equal(accountMismatch("111", "111"), false);
  assert.equal(accountMismatch("111", "222"), true);
  assert.equal(accountMismatch("111", null), true);
});
