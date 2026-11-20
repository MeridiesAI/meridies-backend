import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanMark,
  cleanPng,
  createBody,
  fieldsBody,
  hashHubToken,
  isHubToken,
  isPdf,
  mintHubToken,
  ownHubPath,
  sendProblem,
  signBody,
  signProblem,
  signRequestEmail,
  toSignerDTO,
} from "../../src/lib/contractHub.js";
import { loggedUrl } from "../../src/lib/requestLog.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OBJ = "33333333-3333-4333-8333-333333333333";
// The smallest PNG: the 8-byte signature and an IHDR start are all cleanPng checks.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString("base64");

test("an upload path must be one the API named in the caller's own folder", () => {
  assert.equal(ownHubPath(`${ME}/${OBJ}.pdf`, ME), true);
  assert.equal(ownHubPath(`${OTHER}/${OBJ}.pdf`, ME), false);
  assert.equal(ownHubPath(`${ME}/../${OTHER}/${OBJ}.pdf`, ME), false);
  assert.equal(ownHubPath(`${ME}/${OBJ}.docx`, ME), false);
  assert.equal(ownHubPath(42, ME), false);
});

test("a PDF is known by its bytes", () => {
  assert.equal(isPdf(Buffer.from("%PDF-1.4\n...")), true);
  assert.equal(isPdf(Buffer.from("<html>")), false);
});

test("tokens: minted tokens pass the shape check and are stored as sha256 only", () => {
  const t = mintHubToken(0);
  assert.equal(isHubToken(t.token), true);
  assert.equal(t.hash, hashHubToken(t.token));
  assert.match(t.hash, /^[0-9a-f]{64}$/);
  assert.equal(t.expiresAt, new Date(30 * 86_400_000).toISOString());
  assert.equal(isHubToken("short"), false);
  assert.equal(isHubToken(`${t.token.slice(0, 42)}/`), false);
});

test("create: at most 4 signers, each with a name and a valid email", () => {
  const base = { title: "Agreement", fileName: "a.pdf", path: `${ME}/${OBJ}.pdf`, pageCount: 2 };
  assert.ok(createBody.safeParse({ ...base, signers: [{ name: "Ana", email: "ANA@Example.com " }] }).success);
  assert.equal(createBody.parse({ ...base, signers: [{ name: "Ana", email: "ANA@Example.com" }] }).signers[0]!.email, "ana@example.com");
  assert.equal(createBody.safeParse({ ...base, signers: [] }).success, false);
  assert.equal(createBody.safeParse({ ...base, signers: [{ name: "", email: "a@b.co" }] }).success, false);
  const five = Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, email: `s${i}@x.co` }));
  assert.equal(createBody.safeParse({ ...base, signers: five }).success, false);
});

test("fields must sit on their page", () => {
  const f = { signerId: ME, type: "signature", page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.05 };
  assert.ok(fieldsBody.safeParse({ fields: [f] }).success);
  assert.equal(fieldsBody.safeParse({ fields: [{ ...f, x: 0.8 }] }).success, false);
  assert.equal(fieldsBody.safeParse({ fields: [{ ...f, type: "stamp" }] }).success, false);
  assert.equal(fieldsBody.safeParse({ fields: [{ ...f, w: 0 }] }).success, false);
});

test("send needs a signature field for every signer", () => {
  const signers = [
    { id: "a", name: "Ana" },
    { id: "b", name: "Ben" },
  ];
  assert.equal(sendProblem([], []), "Add at least one signer.");
  assert.equal(sendProblem(signers, [{ signer_id: "a", type: "signature" }, { signer_id: "b", type: "date" }]), "Place a signature field for Ben.");
  assert.equal(sendProblem(signers, []), "Place a signature field for Ana and Ben.");
  assert.equal(sendProblem(signers, [{ signer_id: "a", type: "signature" }, { signer_id: "b", type: "signature" }]), null);
});

test("signing needs consent, the signature, the initials and every name and text field", () => {
  assert.equal(signBody.safeParse({ consent: false }).success, false);
  const mine = [
    { id: "s", type: "signature" },
    { id: "i", type: "initials" },
    { id: "n", type: "name" },
    { id: "d", type: "date" },
  ];
  const sig = { kind: "typed" as const, value: "Ana Ruiz" };
  assert.equal(signProblem(mine, { values: {} }), "Add your signature.");
  assert.equal(signProblem(mine, { signature: sig, values: {} }), "Add your initials.");
  assert.equal(signProblem(mine, { signature: sig, initials: sig, values: {} }), "Fill in the last field.");
  assert.equal(signProblem(mine, { signature: sig, initials: sig, values: { n: "Ana Ruiz" } }), null);
});

test("a drawn mark must be a real PNG under the cap; a typed one is trimmed and bounded", () => {
  assert.equal(cleanPng(`data:image/png;base64,${PNG}`), PNG);
  assert.equal(cleanPng(PNG), PNG);
  assert.equal(cleanPng(Buffer.from("GIF89a....").toString("base64")), null);
  assert.equal(cleanPng(Buffer.alloc(70_000, 0x89).toString("base64")), null);
  assert.equal(cleanPng("not base64!"), null);
  assert.deepEqual(cleanMark({ kind: "typed", value: "  Ana   Ruiz " }, "signature"), { kind: "typed", text: "Ana Ruiz", png: null });
  assert.throws(() => cleanMark({ kind: "typed", value: "ABCDEFGHIJKLM" }, "initials"));
  assert.throws(() => cleanMark({ kind: "drawn", value: "nope" }, "signature"));
});

test("a drawn signature reads back as a data URL from PostgREST's bytea hex", () => {
  const hex = `\\x${Buffer.from(PNG, "base64").toString("hex")}`;
  const d = toSignerDTO({ id: "a", name: "Ana", email: "a@x.co", status: "signed", signature_kind: "drawn", signature_png: hex });
  assert.deepEqual(d.signature, { kind: "drawn", value: `data:image/png;base64,${PNG}` });
  assert.equal(toSignerDTO({ id: "a", name: "Ana", email: "a@x.co", status: "waiting" }).signature, null);
});

test("the signing email's record never keeps the link", () => {
  const m = signRequestEmail({ signerName: "Ana", senderName: "Jo", title: "Agreement", url: "https://app/sign/SECRET", reminder: false });
  assert.match(m.text, /SECRET/);
  assert.doesNotMatch(m.recordText, /SECRET/);
});

test("a signing link's token never reaches a log line", () => {
  const token = mintHubToken().token;
  assert.equal(loggedUrl(`/contract-hub/sign/${token}`), "/contract-hub/sign/…");
  assert.equal(loggedUrl(`/contract-hub/sign/${token}/document`), "/contract-hub/sign/…/document");
  assert.equal(loggedUrl(`/contract-hub/sign/${token}/decline`), "/contract-hub/sign/…/decline");
});
