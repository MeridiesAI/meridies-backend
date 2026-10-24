// fileSniff: the content check behind Drive and OneDrive imports. Legitimate
// files a counselor keeps must pass; disguised and hostile ones must not, and
// none may stall the event loop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";

const { detectContentType, sniff } = await import("../../src/lib/fileSniff.js");

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF = strToU8("%PDF-1.7\n...");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const ooxml = (types: string) => zipSync({ "[Content_Types].xml": strToU8(types), "x.xml": strToU8("<x/>") });
const types = (main: string, extra = "") =>
  `<?xml version="1.0"?><Types>${extra}<Override PartName="/x" ContentType="${main}.main+xml"/></Types>`;

test("a dot in a Drive name isn't an extension: the declared type decides", () => {
  for (const name of ["Rec letter - Mr. Jones", "Transcript 10.15.24", "Resume v1.2"]) {
    assert.deepEqual(detectContentType(PDF, name, "application/pdf"), { ok: true, mimeType: "application/pdf" }, name);
  }
  assert.equal(detectContentType(PNG, "Screenshot 2024-10-15 at 3.45.12 PM", "image/png").ok, true);
  assert.equal(detectContentType(ooxml(types(DOCX)), "Essay v2.final", DOCX).ok, true);
});

test("same kind under the wrong label is stored as what the bytes are", () => {
  assert.deepEqual(detectContentType(PNG, "photo.jpg", "image/jpeg"), { ok: true, mimeType: "image/png", extension: "png" });
  assert.deepEqual(detectContentType(JPEG, "IMG_1.HEIC", "image/heic"), { ok: true, mimeType: "image/jpeg" });
  assert.deepEqual(detectContentType(ooxml(types(XLSX)), "grades.xls", "application/vnd.ms-excel"), { ok: true, mimeType: XLSX, extension: "xlsx" });
  assert.deepEqual(detectContentType(JPEG, "IMG_0001", "application/octet-stream"), { ok: true, mimeType: "image/jpeg" });
});

test("SIS and Excel exports: HTML-as-.xls, UTF-16 text, SheetJS xlsx", () => {
  assert.equal(detectContentType(strToU8('<html xmlns:x="urn:schemas-microsoft-com:office:excel"><table>'), "grades.xls", "application/vnd.ms-excel").ok, true);
  assert.equal(detectContentType(new Uint8Array([0xff, 0xfe, 0x61, 0, 0x0a, 0]), "roster.csv", "text/csv").ok, true);
  const sheetjs = types(XLSX, '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>');
  assert.deepEqual(detectContentType(ooxml(sheetjs), "list.xlsx", XLSX), { ok: true, mimeType: XLSX });
});

test("disguised and macro files are still refused", () => {
  assert.equal(detectContentType(strToU8("<html><script>x</script>"), "report.pdf", "application/pdf").ok, false);
  assert.equal(detectContentType(PDF, "notes.txt", "text/plain").ok, false);
  assert.equal(detectContentType(ooxml(types(XLSX)), "essay.docx", DOCX).ok, false);
  assert.equal(detectContentType(ooxml(types("application/vnd.ms-word.document.macroEnabled")), "essay.docx", DOCX).ok, false);
  assert.equal(detectContentType(PDF, "Rec letter - Mr. Jones", "text/plain").ok, false);
});

test("a forged zip64 entry count returns at once", () => {
  // Local header, then an empty central directory, a zip64 end record claiming
  // 0xFFFFFFFF entries, its locator and the classic end record.
  const b = new Uint8Array(1024);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x04034b50, true);
  const z64 = 900;
  dv.setUint32(z64, 0x06064b50, true);
  dv.setUint32(z64 + 32, 0xffffffff, true);
  dv.setUint32(z64 + 40, 0xffffffff, true);
  dv.setUint32(z64 + 48, 100, true);
  const loc = z64 + 56;
  dv.setUint32(loc, 0x07064b50, true);
  dv.setUint32(loc + 8, z64, true);
  const eocd = loc + 20;
  dv.setUint32(eocd, 0x06054b50, true);
  dv.setUint16(eocd + 10, 0xffff, true);
  dv.setUint32(eocd + 16, 0xffffffff, true);
  const t = performance.now();
  assert.equal(sniff(b.subarray(0, eocd + 22)), "zip");
  assert.ok(performance.now() - t < 100);
});

test("a deflate bomb in [Content_Types].xml stops at the output cap", () => {
  // 64 MB of zeros declared as 1000 bytes; unzipSync used to inflate every byte.
  const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024));
  const name = strToU8("[Content_Types].xml");
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(bomb.length, 18); lh.writeUInt32LE(1000, 22); lh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(bomb.length, 20); cd.writeUInt32LE(1000, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + name.length + bomb.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(cdOff, 16);
  const bytes = Buffer.concat([lh, name, bomb, cd, name, end]);
  const t = performance.now();
  assert.equal(sniff(bytes), "zip");
  assert.ok(performance.now() - t < 200, `took ${performance.now() - t}ms`);
});

test("a macro main part typed by a Default, or a VBA project, is refused", () => {
  const byDefault = types(DOCX, '<Default Extension="xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>');
  assert.equal(detectContentType(ooxml(byDefault), "essay.docx", DOCX).ok, false);
  const vba = types(DOCX, '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>');
  assert.equal(detectContentType(ooxml(vba), "essay.docx", DOCX).ok, false);
});

test("an old/new Office swap gets the extension of the type it's stored under", () => {
  const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.deepEqual(detectContentType(OLE, "essay.docx", DOCX), { ok: true, mimeType: "application/msword", extension: "doc" });
  assert.deepEqual(detectContentType(OLE, "grades.xlsx", XLSX), { ok: true, mimeType: "application/vnd.ms-excel", extension: "xls" });
  assert.deepEqual(detectContentType(ooxml(types(XLSX)), "grades.xls", "application/vnd.ms-excel"), { ok: true, mimeType: XLSX, extension: "xlsx" });
  assert.deepEqual(detectContentType(PNG, "photo.jpg", "image/jpeg"), { ok: true, mimeType: "image/png", extension: "png" });
  // Nothing to correct: no extension, or one that already fits.
  assert.deepEqual(detectContentType(JPEG, "IMG_1.jpeg", "image/png"), { ok: true, mimeType: "image/jpeg" });
});

/** A one-entry stored zip holding [Content_Types].xml, built by hand. */
function storedZip(xml: string, o: { zip64?: boolean; comment?: Uint8Array } = {}) {
  const name = Buffer.from("[Content_Types].xml");
  const data = Buffer.from(xml);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
  // Streaming writers put 0xFFFFFFFF in the directory and the real sizes and offset in a zip64 extra field.
  const extra = Buffer.alloc(o.zip64 ? 28 : 0);
  if (o.zip64) {
    extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
    extra.writeUInt32LE(data.length, 4); extra.writeUInt32LE(data.length, 12); extra.writeUInt32LE(0, 20);
  }
  const big = (n: number) => (o.zip64 ? 0xffffffff : n);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt32LE(big(data.length), 20); cd.writeUInt32LE(big(data.length), 24);
  cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(extra.length, 30); cd.writeUInt32LE(big(0), 42);
  const cdOff = 30 + name.length + data.length;
  const comment = Buffer.from(o.comment ?? new Uint8Array());
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length + extra.length, 12); end.writeUInt32LE(cdOff, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([lh, name, data, cd, name, extra, end, comment]);
}

test("a zip64 directory entry (sizes in the extra field) is read", () => {
  assert.equal(sniff(storedZip(types(DOCX))), "docx");
  assert.equal(sniff(storedZip(types(DOCX), { zip64: true })), "docx");
  assert.equal(detectContentType(storedZip(types(DOCX), { zip64: true }), "essay.docx", DOCX).ok, true);
});

test("a second end record planted in the zip comment makes the zip unreadable", () => {
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  // The fake's own comment length is 0, so it also "runs to the end of the file".
  assert.equal(sniff(storedZip(types(DOCX), { comment: fake })), "zip");
  assert.equal(sniff(storedZip(types(DOCX), { comment: Buffer.from("made by a tool") })), "docx");
});

test("nameless legacy Office, and unknown extensions under a type we know", () => {
  const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.deepEqual(detectContentType(OLE, "Transcript 10.15.24", "application/octet-stream"), { ok: true, mimeType: null });
  const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  assert.deepEqual(detectContentType(HEIC, "IMG_1.heic", "image/jpeg"), { ok: true, mimeType: "application/octet-stream" });
  assert.deepEqual(detectContentType(zipSync({ "a.txt": strToU8("x") }), "Essay.pages", "application/pdf"), { ok: true, mimeType: "application/octet-stream" });
  // A known extension still has to match.
  assert.equal(detectContentType(HEIC, "IMG_1.jpg", "image/jpeg").ok, false);
  // An unknown extension doesn't excuse bytes that are one of ours under another label.
  assert.equal(detectContentType(PDF, "notes.odt", "text/plain").ok, false);
});
