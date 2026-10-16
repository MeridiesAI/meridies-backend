import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import { requireScope, GOOGLE_SCOPE, type LiveToken } from "../../src/lib/oauth.js";
import { googleFileFailureCode, GOOGLE_FILE_SCOPE, GOOGLE_CALENDAR_SCOPE } from "../../src/lib/suiteApi.js";

const token = (scopes: string[]): LiveToken => ({ accessToken: "t", accountId: "1", accountEmail: "c@example.com", scopes });

test("Google file calls use drive.file, never drive.readonly", () => {
  assert.equal(GOOGLE_FILE_SCOPE, GOOGLE_SCOPE.driveFile);
  assert.equal(GOOGLE_CALENDAR_SCOPE, GOOGLE_SCOPE.calendarEvents);
});

test("a grant without calendar.events answers calendar_not_enabled; without drive.file, drive_not_granted", () => {
  assert.throws(
    () => requireScope(token(["openid", GOOGLE_SCOPE.driveFile]), "google", GOOGLE_CALENDAR_SCOPE, "writing to Calendar", "calendar_not_enabled"),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "calendar_not_enabled" && e.message === "Turn on Google Calendar to add Meet links."
  );
  assert.throws(
    () => requireScope(token(["openid"]), "google", GOOGLE_FILE_SCOPE, "reading the files you picked", "drive_not_granted"),
    (e: unknown) => e instanceof HttpError && e.code === "drive_not_granted"
  );
  assert.doesNotThrow(() => requireScope(token([GOOGLE_SCOPE.driveFile]), "google", GOOGLE_FILE_SCOPE, "x", "drive_not_granted"));
});

test("a Drive 404 carries not_found so callers can map it", () => {
  assert.equal(googleFileFailureCode(404), "not_found");
  assert.equal(googleFileFailureCode(403), null);
  assert.equal(googleFileFailureCode(500), null);
});
