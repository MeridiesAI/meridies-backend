import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { STARTER_SECTIONS, type ContractSection } from "../../src/lib/contractDraft.js";
import {
  SIGNATURE_MAX_BYTES,
  contractDraftBody,
  contractDraftError,
  contractDraftsUnavailable,
  decodeSignaturePng,
  signatureBody,
  sniffPng,
  toContractDraftDTO,
  toSignatureDTO,
} from "../../src/lib/contractDraftApi.js";

// A real 1x1 PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const png = Buffer.from(PNG_B64, "base64");
// The same signature and IHDR with another size (the checksum is not checked, only the shape).
const sized = (width: number, height: number) => {
  const b = Buffer.from(png);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

// The real PNG made `total` bytes long by a valid tEXt chunk between its IHDR and its image data, so the IEND stays last.
const padded = (total: number) => {
  const data = Buffer.alloc(total - png.length - 12);
  const type = Buffer.from("tEXt");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, 33), head, type, data, crc, png.subarray(33)]);
};

test("sniffPng reads a real PNG's size", () => {
  assert.deepEqual(sniffPng(png), { width: 1, height: 1 });
  assert.deepEqual(sniffPng(sized(1200, 400)), { width: 1200, height: 400 });
});

test("sniffPng refuses everything else", () => {
  const text = (s: string) => new TextEncoder().encode(s);
  assert.equal(sniffPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(sniffPng(text("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>")), null);
  assert.equal(sniffPng(text("<html><script>alert(1)</script></html>")), null);
  assert.equal(sniffPng(png.subarray(0, 8)), null);
  assert.equal(sniffPng(png.subarray(0, 20)), null);
  assert.equal(sniffPng(png.subarray(0, 32)), null);
  // Cut off after the header, or with anything after it where the end should be: not a whole PNG.
  assert.equal(sniffPng(png.subarray(0, 40)), null);
  assert.equal(sniffPng(png.subarray(0, 33)), null);
  assert.equal(sniffPng(png.subarray(0, png.length - 1)), null);
  assert.equal(sniffPng(Buffer.concat([png.subarray(0, 33), Buffer.from("<script>alert(1)</script>")])), null);
  assert.equal(sniffPng(Buffer.concat([png, Buffer.from([0])])), null);
  assert.equal(sniffPng(new Uint8Array()), null);
  // The first chunk must be a 13-byte IHDR.
  const notIhdr = Buffer.from(png);
  notIhdr.write("IDAT", 12, "ascii");
  assert.equal(sniffPng(notIhdr), null);
  const wrongLength = Buffer.from(png);
  wrongLength.writeUInt32BE(14, 8);
  assert.equal(sniffPng(wrongLength), null);
});

test("sniffPng holds the size to 1200 x 400", () => {
  assert.equal(sniffPng(sized(1201, 100)), null);
  assert.equal(sniffPng(sized(100, 401)), null);
  assert.equal(sniffPng(sized(0, 100)), null);
  assert.equal(sniffPng(sized(100, 0)), null);
});

const draft = (over: Partial<{ title: string; sections: ContractSection[] }> = {}) => ({ title: "Engagement letter", sections: STARTER_SECTIONS, ...over });
const clause = (i: number, over: Partial<{ id: string; heading: string; body: string }> = {}): ContractSection => ({ id: `c${i}`, kind: "clause", heading: `Clause ${i}`, body: `Body ${i}`, ...over });
const base = STARTER_SECTIONS.slice(0, 3);
const rejects = (input: unknown) => assert.equal(contractDraftBody.safeParse(input).success, false);

test("a draft is a title and sections; the starter text is one", () => {
  const parsed = contractDraftBody.parse(draft());
  assert.equal(parsed.title, "Engagement letter");
  assert.deepEqual(parsed.sections, STARTER_SECTIONS);
  assert.ok(contractDraftBody.safeParse(draft({ sections: [...base, ...Array.from({ length: 37 }, (_, i) => clause(i))] })).success);
});

test("a draft keeps to the outline: text, list, text, then clauses only", () => {
  rejects(draft({ sections: [...base, ...Array.from({ length: 38 }, (_, i) => clause(i))] })); // 41 sections
  rejects(draft({ sections: [] }));
  rejects(draft({ sections: base.slice(0, 2) }));
  rejects(draft({ sections: [STARTER_SECTIONS[1]!, STARTER_SECTIONS[0]!, STARTER_SECTIONS[2]!] }));
  rejects(draft({ sections: [...base, { id: "more", kind: "text", heading: "More", body: "x" }] }));
  rejects(draft({ sections: [...base, { id: "more", kind: "list", heading: "More", items: ["x"] }] }));
  // A clause can't stand where the fee text goes.
  rejects(draft({ sections: [base[0]!, base[1]!, { id: "fees", kind: "clause", heading: "Fees", body: "x" }] }));
});

test("a draft is strict: no unknown keys, title 1-160, unique ids of 1-64 characters", () => {
  rejects({ ...draft(), extra: 1 });
  rejects(draft({ sections: [{ ...base[0]!, extra: 1 } as ContractSection, base[1]!, base[2]!] }));
  rejects(draft({ title: "" }));
  rejects(draft({ title: "   " }));
  rejects(draft({ title: "a".repeat(161) }));
  assert.ok(contractDraftBody.safeParse(draft({ title: "a".repeat(160) })).success);
  rejects(draft({ sections: [...base, clause(1, { id: "services" })] }));
  rejects(draft({ sections: [...base, clause(1, { id: "" })] }));
  rejects(draft({ sections: [...base, clause(1, { id: "x".repeat(65) })] }));
  assert.ok(contractDraftBody.safeParse(draft({ sections: [...base, clause(1, { id: "x".repeat(64) })] })).success);
  rejects({ title: "t" });
  rejects({ sections: STARTER_SECTIONS });
  rejects(null);
});

test("headings and bodies are never empty; a list needs real items", () => {
  rejects(draft({ sections: [{ ...base[0]!, heading: " " } as ContractSection, base[1]!, base[2]!] }));
  rejects(draft({ sections: [{ ...base[0]!, body: "  \n " } as ContractSection, base[1]!, base[2]!] }));
  rejects(draft({ sections: [...base, clause(1, { heading: "" })] }));
  rejects(draft({ sections: [...base, clause(1, { body: " " })] }));
  const list = (items: string[]): ContractSection[] => [base[0]!, { id: "prerequisites", kind: "list", heading: "Prerequisites", items }, base[2]!];
  rejects(draft({ sections: list([]) }));
  rejects(draft({ sections: list(["ok", "  "]) }));
  rejects(draft({ sections: list(["x".repeat(501)]) }));
  rejects(draft({ sections: list(Array.from({ length: 41 }, (_, i) => `item ${i}`)) }));
  assert.ok(contractDraftBody.safeParse(draft({ sections: list(Array.from({ length: 40 }, (_, i) => `item ${i}`)) })).success);
  assert.ok(contractDraftBody.safeParse(draft({ sections: list(["x".repeat(500)]) })).success);
});

test("title, headings and list items are saved trimmed", () => {
  const parsed = contractDraftBody.parse(
    draft({ title: "  Letter  ", sections: [{ ...base[0]!, heading: " Services " } as ContractSection, { id: "p", kind: "list", heading: " P ", items: ["  a  ", "b"] }, base[2]!] })
  );
  assert.equal(parsed.title, "Letter");
  assert.equal(parsed.sections[0]!.heading, "Services");
  assert.deepEqual(parsed.sections[1], { id: "p", kind: "list", heading: "P", items: ["a", "b"] });
});

test("no field holds a control character; only a body keeps its line breaks and tabs", () => {
  const withTitle = (title: string) => draft({ title });
  const withHeading = (h: string) => draft({ sections: [{ ...base[0]!, heading: h } as ContractSection, base[1]!, base[2]!] });
  const withItem = (item: string) => draft({ sections: [base[0]!, { id: "p", kind: "list", heading: "P", items: ["ok", item] }, base[2]!] });
  const withBody = (b: string) => draft({ sections: [...base, clause(1, { body: b })] });
  const textBody = (b: string) => draft({ sections: [{ ...base[0]!, body: b } as ContractSection, base[1]!, base[2]!] });
  // Single-line fields: no C0 (tab and newline too), no DEL.
  for (const c of ["\n", "\r", "\t", "\u0000", "\u001f", "\u007f"]) {
    rejects(withTitle(`Letter${c}two`));
    rejects(withHeading(`Head${c}ing`));
    rejects(withItem(`item${c}x`));
  }
  rejects(withTitle("Letter\u0000"));
  // Bodies: line breaks and tabs are text; NUL and the other controls are not.
  for (const c of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u000e", "\u001f", "\u007f"]) {
    rejects(withBody(`Pay by ${c}Friday`));
    rejects(textBody(`Pay by ${c}Friday`));
  }
  const ok = "First line\nSecond line\r\n\tindented";
  assert.ok(contractDraftBody.safeParse(withBody(ok)).success);
  assert.ok(contractDraftBody.safeParse(textBody(ok)).success);
  assert.equal(contractDraftBody.parse(withBody(ok)).sections[3]!.kind === "clause" && (contractDraftBody.parse(withBody(ok)).sections[3] as { body: string }).body, ok);
  // Each says so in words.
  const message = (input: unknown) => JSON.stringify(contractDraftBody.safeParse(input).error?.issues.map((i) => i.message));
  assert.match(message(withTitle("a\u0000b")), /title can't contain control characters/i);
  assert.match(message(withHeading("a\u0000b")), /heading can't contain control characters/i);
  assert.match(message(withItem("a\tb")), /item can't contain control characters/i);
  assert.match(message(withBody("a\u0000b")), /body can't contain control characters/i);
});

test("the whole draft is at most 50,000 characters", () => {
  const room = 50_000 - "T".length - base.reduce((n, s) => n + s.heading.length + (s.kind === "list" ? s.items.join("").length : s.body.length), 0) - "H".length;
  const big = (n: number) => draft({ title: "T", sections: [...base, clause(1, { heading: "H", body: "x".repeat(n) })] });
  assert.ok(contractDraftBody.safeParse(big(room)).success);
  rejects(big(room + 1));
  // Items and headings count too.
  rejects(draft({ title: "T", sections: [{ ...base[0]!, heading: "h".repeat(50_000) } as ContractSection, base[1]!, base[2]!] }));
});

test("a typed signature is a name; a drawn one is a name and a PNG", () => {
  assert.deepEqual(signatureBody.parse({ kind: "typed", signerName: "  Casey Counselor " }), { kind: "typed", signerName: "Casey Counselor" });
  assert.deepEqual(signatureBody.parse({ kind: "drawn", signerName: "Casey", imagePngBase64: PNG_B64 }), { kind: "drawn", signerName: "Casey", imagePngBase64: PNG_B64 });
  const no = (input: unknown) => assert.equal(signatureBody.safeParse(input).success, false);
  no({ kind: "drawn", signerName: "Casey" });
  no({ kind: "typed", signerName: "Casey", imagePngBase64: PNG_B64 });
  no({ kind: "drawn", signerName: "Casey", imagePngBase64: "" });
  no({ kind: "drawn", signerName: "Casey", imagePngBase64: PNG_B64, imageSha256: "0".repeat(64) });
  no({ kind: "typed", signerName: "Casey", extra: 1 });
  no({ kind: "scribble", signerName: "Casey" });
  no({ kind: "typed" });
  no({ kind: "typed", signerName: "" });
  no({ kind: "typed", signerName: "   " });
  no({ kind: "typed", signerName: "a".repeat(121) });
  no({ kind: "typed", signerName: "Case\ny" });
  no({ kind: "typed", signerName: "Case\u0000y" });
  no({ kind: "typed", signerName: "Case\u007fy" });
  no({ kind: "typed", signerName: 7 });
  assert.ok(signatureBody.safeParse({ kind: "typed", signerName: "a".repeat(120) }).success);
  // 61,440 bytes is 81,920 base64 characters; one more byte of text is too much.
  no({ kind: "drawn", signerName: "Casey", imagePngBase64: "A".repeat(81_924) });
});

test("a drawn image is decoded strictly, and only a PNG of the right size and weight passes", () => {
  assert.ok(decodeSignaturePng(PNG_B64)?.equals(png));
  assert.equal(decodeSignaturePng("not base64!"), null);
  assert.equal(decodeSignaturePng(PNG_B64.slice(0, -1)), null);
  assert.equal(decodeSignaturePng(`data:image/png;base64,${PNG_B64}`), null);
  assert.equal(decodeSignaturePng(` ${PNG_B64}`), null);
  assert.equal(decodeSignaturePng(""), null);
  assert.equal(decodeSignaturePng(Buffer.from("<html></html>").toString("base64")), null);
  assert.equal(decodeSignaturePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]).toString("base64")), null);
  assert.equal(decodeSignaturePng(sized(1201, 10).toString("base64")), null);
  assert.equal(decodeSignaturePng(png.subarray(0, 40).toString("base64")), null);
  const heavy = padded(SIGNATURE_MAX_BYTES + 1);
  assert.equal(heavy.length, SIGNATURE_MAX_BYTES + 1);
  assert.deepEqual(sniffPng(heavy), { width: 1, height: 1 });
  assert.equal(decodeSignaturePng(heavy.toString("base64")), null);
  const exact = padded(SIGNATURE_MAX_BYTES);
  assert.equal(exact.length, SIGNATURE_MAX_BYTES);
  assert.ok(decodeSignaturePng(exact.toString("base64")));
});

test("a draft row becomes its DTO", () => {
  const row = { id: "d1", title: "Letter", sections: STARTER_SECTIONS, archived_at: null, created_at: "2026-11-18T10:00:00Z", updated_at: "2026-11-18T11:00:00Z", practice_id: "p", counselor_id: "c" };
  assert.deepEqual(toContractDraftDTO(row), { id: "d1", title: "Letter", sections: STARTER_SECTIONS, archivedAt: null, createdAt: "2026-11-18T10:00:00Z", updatedAt: "2026-11-18T11:00:00Z" });
  assert.equal(toContractDraftDTO({ ...row, archived_at: "2026-11-19T00:00:00Z" }).archivedAt, "2026-11-19T00:00:00Z");
});

test("a signature row becomes its DTO; PostgREST's bytea hex is read back to a data URL", () => {
  const at = "2026-11-18T10:00:00Z";
  assert.deepEqual(toSignatureDTO({ signer_name: "Casey", kind: "typed", image_png: null, image_sha256: null, updated_at: at }), { signerName: "Casey", kind: "typed", imageDataUrl: null, updatedAt: at });
  const drawn = toSignatureDTO({ signer_name: "Casey", kind: "drawn", image_png: `\\x${png.toString("hex")}`, image_sha256: "a".repeat(64), updated_at: at });
  assert.equal(drawn.imageDataUrl, `data:image/png;base64,${PNG_B64}`);
  assert.equal(drawn.kind, "drawn");
  // Never an image on a typed signature, and never garbage as one.
  assert.equal(toSignatureDTO({ signer_name: "Casey", kind: "typed", image_png: `\\x${png.toString("hex")}`, updated_at: at }).imageDataUrl, null);
  assert.equal(toSignatureDTO({ signer_name: "Casey", kind: "drawn", image_png: null, updated_at: at }).imageDataUrl, null);
});

test("a database without the migration answers 503 contract_drafts_unavailable, other faults do not", () => {
  const off = contractDraftsUnavailable();
  assert.equal(off.statusCode, 503);
  assert.equal(off.code, "contract_drafts_unavailable");
  for (const code of ["42P01", "PGRST205", "PGRST204", "42703"]) {
    const e = contractDraftError({ code, message: "x" });
    assert.equal(e.statusCode, 503);
    assert.equal(e.code, "contract_drafts_unavailable");
  }
  assert.equal(contractDraftError({ code: "23505", message: "dup" }).statusCode, 409);
  assert.equal(contractDraftError({ code: "42501", message: "denied" }).statusCode, 403);
  assert.equal(contractDraftError({ code: "XX000", message: "boom" }).statusCode, 500);
});
