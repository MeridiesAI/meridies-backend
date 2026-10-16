import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import { requireScope, GOOGLE_SCOPE, type LiveToken } from "../../src/lib/oauth.js";
import { googleFileFailureCode, providerFailure, GOOGLE_FILE_SCOPE, GOOGLE_CALENDAR_SCOPE } from "../../src/lib/suiteApi.js";
import { docExportOutcome } from "../../src/lib/supplementDocs.js";

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

test("providerFailure sets not_found on a 404 and no code on other statuses", () => {
  const log = { warn: () => undefined };
  const e404 = providerFailure("google", new Response(null, { status: 404 }), log, "file");
  assert.equal(e404.statusCode, 404);
  assert.equal(e404.code, "not_found");
  assert.equal(providerFailure("google", new Response(null, { status: 403 }), log, "file").code, undefined);
});

test("docExportOutcome maps a Doc export answer", () => {
  const max = 2 * 1024 * 1024;
  assert.deepEqual(docExportOutcome({ status: 404, declaredBytes: 0, text: null }), { ok: false, reason: "not-picked" });
  assert.deepEqual(docExportOutcome({ status: 500, declaredBytes: 0, text: null }), { ok: false, reason: "failed" });
  assert.deepEqual(docExportOutcome({ status: 403, declaredBytes: 0, text: null }), { ok: false, reason: "failed" });
  assert.deepEqual(docExportOutcome({ status: 200, declaredBytes: max + 1, text: null }), { ok: false, reason: "failed" });
  assert.deepEqual(docExportOutcome({ status: 200, declaredBytes: 0, text: "x".repeat(max + 1) }), { ok: false, reason: "failed" });
  const ok = docExportOutcome({ status: 200, declaredBytes: 5, text: "Hello\r\nworld" });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.text.includes("\r"), false);
});
