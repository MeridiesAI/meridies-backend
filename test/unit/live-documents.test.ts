import assert from "node:assert/strict";
import { test } from "node:test";
import { holdsNoActivity, liveStatusOf, type LiveFileCheck } from "../../src/lib/liveDocuments.js";

const check = (errorCode: string | null): LiveFileCheck => ({
  documentId: crypto.randomUUID(), name: "Essay draft", provider: "google",
  modifiedAt: null, editedBy: null, counts: false, error: errorCode ? "x" : null, errorCode,
});

test("a disconnected or broken grant holds a no-activity verdict; other failures don't", () => {
  assert.equal(holdsNoActivity([check("google_disconnected")]), true);
  assert.equal(holdsNoActivity([check(null), check("google_reconnect")]), true);
  assert.equal(holdsNoActivity([check("not_found")]), false);
  assert.equal(holdsNoActivity([check("unavailable"), check(null)]), false);
  assert.equal(holdsNoActivity([]), false);
});

test("liveStatus names the worst state and counts the files it affects", () => {
  assert.deepEqual(liveStatusOf([check(null)]), { status: "ok", files: 0 });
  assert.deepEqual(liveStatusOf([check("google_disconnected"), check("google_disconnected"), check(null)]), { status: "disconnected", files: 2 });
  assert.deepEqual(liveStatusOf([check("google_reconnect")]), { status: "reconnect", files: 1 });
  assert.deepEqual(liveStatusOf([check("google_reconnect"), check("google_disconnected")]), { status: "disconnected", files: 2 });
});

test("a grant without Drive (drive_not_granted) holds no-activity and reads as reconnect", () => {
  assert.equal(holdsNoActivity([check("drive_not_granted")]), true);
  assert.equal(holdsNoActivity([check(null), check("drive_not_granted")]), true);
  assert.deepEqual(liveStatusOf([check("drive_not_granted")]), { status: "reconnect", files: 1 });
  assert.deepEqual(liveStatusOf([check("drive_not_granted"), check("google_disconnected")]), { status: "disconnected", files: 2 });
});
