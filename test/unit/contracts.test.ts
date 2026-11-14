import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { attachmentName, contractObjectPath, contractUploadBody, ownContractPath, sha256OfBytes, sniffContract } from "../../src/lib/contracts.js";

const PRACTICE = "11111111-2222-3333-4444-555555555555";
const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
const docx = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<w:document/>") });

test("the bytes decide the type: PDF and DOCX, nothing else", () => {
  assert.equal(sniffContract(pdf), "application/pdf");
  assert.equal(sniffContract(docx), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(sniffContract(new TextEncoder().encode("<html><script>alert(1)</script>")), null);
  assert.equal(sniffContract(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  // A zip that isn't a Word file (an xlsx, a jar) is refused; so is a truncated zip.
  assert.equal(sniffContract(zipSync({ "xl/workbook.xml": strToU8("<x/>") })), null);
  assert.equal(sniffContract(docx.subarray(0, 20)), null);
  assert.equal(sniffContract(new Uint8Array()), null);
});

test("object paths are the practice's own folder, uuid-named, of a known type", () => {
  const path = contractObjectPath(PRACTICE, "application/pdf");
  assert.match(path, new RegExp(`^${PRACTICE}/[0-9a-f-]{36}\\.pdf$`));
  assert.equal(ownContractPath(path, PRACTICE), "application/pdf");
  assert.equal(ownContractPath(path, "99999999-2222-3333-4444-555555555555"), null);
  assert.equal(ownContractPath(`${PRACTICE}/../x.pdf`, PRACTICE), null);
  assert.equal(ownContractPath(`${PRACTICE}/evil.pdf`, PRACTICE), null);
  assert.equal(ownContractPath(`${PRACTICE}/${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}.exe`, PRACTICE), null);
  assert.equal(ownContractPath(null, PRACTICE), null);
});

test("an upload names a PDF or DOCX of at most 10 MB", () => {
  assert.ok(contractUploadBody.parse({ contentType: "application/pdf", sizeBytes: 1000 }));
  assert.throws(() => contractUploadBody.parse({ contentType: "image/png", sizeBytes: 1000 }));
  assert.throws(() => contractUploadBody.parse({ contentType: "application/pdf", sizeBytes: 11 * 1024 * 1024 }));
  assert.throws(() => contractUploadBody.parse({ contentType: "application/pdf", sizeBytes: 1000, extra: 1 }));
});

test("the hash is the file's SHA-256", () => {
  assert.equal(sha256OfBytes(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("an attachment keeps a safe name with its extension", () => {
  assert.equal(attachmentName("Engagement letter", "application/pdf"), "Engagement letter.pdf");
  assert.equal(attachmentName("terms.PDF", "application/pdf"), "terms.PDF");
  assert.equal(attachmentName('a/b\\c:"d"', "application/pdf"), "a b c d.pdf");
  assert.equal(attachmentName("", "application/pdf"), "Contract.pdf");
});
