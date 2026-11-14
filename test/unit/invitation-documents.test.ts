import assert from "node:assert/strict";
import test from "node:test";
import { invitationDocumentBody, stagedPathOk, toInvitationDocument } from "../../src/lib/invitationDocuments.js";

const C = "6b898b7d-0abf-447d-bc9d-2b47bd9c5731";
const I = "9acde249-47c8-4553-b194-37cbab069252";

test("a staged path is the counselor's own id, the invitation's id, then one file name", () => {
  assert.equal(stagedPathOk(`${C}/${I}/1-transcript.pdf`, C, I), true);
  assert.equal(stagedPathOk(`${C}/${I}/`, C, I), false, "no file name");
  assert.equal(stagedPathOk(`${C}/${I}/sub/1-a.pdf`, C, I), false, "no deeper folders");
  assert.equal(stagedPathOk(`${I}/${I}/1-a.pdf`, C, I), false, "someone else's id");
  assert.equal(stagedPathOk(`${C}/${C}/1-a.pdf`, C, I), false, "another invitation");
  assert.equal(stagedPathOk(`unfiled/1-a.pdf`, C, I), false);
});

test("the body takes a known kind, defaults to other, and refuses anything else", () => {
  const ok = invitationDocumentBody.parse({ storagePath: "x/y/z.pdf", filename: "z.pdf" });
  assert.equal(ok.kind, "other");
  assert.equal(invitationDocumentBody.safeParse({ storagePath: "x", filename: "z.pdf", kind: "diary" }).success, false);
  assert.equal(invitationDocumentBody.safeParse({ storagePath: "x", filename: "z.pdf", studentId: C }).success, false, "strict");
});

test("the DTO never carries the counselor id or the bucket", () => {
  const dto = toInvitationDocument({
    id: "d", invitation_id: I, counselor_id: C, bucket: "student-documents", storage_path: "p", filename: "f.pdf",
    title: null, mime_type: null, size_bytes: "12", kind: "resume", created_at: "2026-11-14T00:00:00Z",
  });
  assert.deepEqual(Object.keys(dto).sort(), ["createdAt", "filename", "id", "invitationId", "kind", "mimeType", "sizeBytes", "storagePath", "title"]);
  assert.equal(dto.sizeBytes, 12);
});
