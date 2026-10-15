import assert from "node:assert/strict";
import { test } from "node:test";
import { isDocumentsBucket, isSafeStoragePath, isSafeStoragePathShape } from "../../src/lib/storagePath.js";

const SID = "6f1c2b0e-5d3a-4c8e-9b7f-0a1b2c3d4e5f";

test("the paths the app writes are accepted", () => {
  for (const p of [`${SID}/1729000000000-transcript.pdf`, "unfiled/1729000000000-notes.txt", `${SID}/sub/x.docx`]) {
    assert.ok(isSafeStoragePath(p), p);
    assert.ok(isSafeStoragePathShape(p), p);
  }
});

test("a path that is a different row but the same object is refused", () => {
  for (const p of [
    `/${SID}/a.pdf`, // storage-js strips a leading slash
    `${SID}/a.pdf/`,
    `${SID}//a.pdf`,
    `${SID}/../imports/x/y.csv`, // the request URL resolves dot segments
    `${SID}/./a.pdf`,
    `${SID}/%2e%2e/imports/x.csv`,
    `${SID}/a%2Fb.pdf`,
    `${SID}\\a.pdf`,
    `${SID}/a.pdf?x=1`,
    `${SID}/a.pdf#frag`,
    ` ${SID}/a.pdf`,
    `${SID}/a\u0000.pdf`,
    `${SID}/a\n.pdf`,
  ]) {
    assert.equal(isSafeStoragePathShape(p), false, JSON.stringify(p));
    assert.equal(isSafeStoragePath(p), false, JSON.stringify(p));
  }
});

test("registration needs a first segment the bucket's insert policy accepts", () => {
  assert.equal(isSafeStoragePath("imports/x/y.csv"), false);
  assert.equal(isSafeStoragePath("x/gate.pdf"), false);
  assert.equal(isSafeStoragePath("single-segment.pdf"), false);
  assert.equal(isSafeStoragePath("a".repeat(501)), false);
  // the shape check alone (what a download asks) is looser on the first segment
  assert.equal(isSafeStoragePathShape("x/gate.pdf"), true);
  assert.equal(isSafeStoragePathShape(null), false);
});

test("only the documents bucket is a document's bucket", () => {
  assert.ok(isDocumentsBucket(undefined));
  assert.ok(isDocumentsBucket(null));
  assert.ok(isDocumentsBucket("student-documents"));
  for (const b of ["imports", "axis-attachments", "student-banners", "college-photos", "Student-Documents", ""]) {
    assert.equal(isDocumentsBucket(b), false, b);
  }
});
