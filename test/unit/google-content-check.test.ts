// Drive imports: an uploaded file's bytes must match its name and type (the
// same magic-byte check as OneDrive); a Docs/Sheets/Slides export is Google's
// own rendering and isn't checked. Drive and PostgREST answer from a fetch stub.
process.env.GOOGLE_CLIENT_ID = "google-client-id-0000";
process.env.GOOGLE_CLIENT_SECRET = "google-client-secret-0000";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";
process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { zipSync, strToU8 } from "fflate";

const { encryptToken } = await import("../../src/lib/tokenCrypto.js");
const suite = await import("../../src/lib/suiteApi.js");

const OWNER = "00000000-0000-4000-8000-000000000002";
const row = {
  owner_id: OWNER,
  provider: "google",
  account_id: "google-sub-1",
  account_email: "counselor@school.org",
  access_token_enc: encryptToken("AT-live"),
  refresh_token_enc: encryptToken("RT-1"),
  scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email", suite.GOOGLE_FILE_SCOPE],
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
};

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

let driveBody: Uint8Array = new Uint8Array();
let driveUrls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  driveUrls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/rest/v1/")) {
      const object = new Headers(init?.headers).get("accept")?.includes("pgrst.object");
      if (url.includes("/rest/v1/integration_tokens") && (init?.method ?? "GET") === "GET") return object ? json(row) : json([row]);
      return object ? json({}) : json([]);
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/")) {
      driveUrls.push(url);
      return new Response(driveBody);
    }
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const log = () => ({ info() {}, warn() {}, error() {} }) as never;
const file = (name: string, mimeType: string) => ({
  id: "F1", driveId: null, name, mimeType, kind: "other" as const, modifiedAt: null, sizeBytes: 100,
  webUrl: null, lastModifiedBy: null, lastModifiedByOwner: null, importable: true,
});
const ooxml = (main: string) =>
  zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types><Override PartName="/x" ContentType="${main}"/></Types>`),
    "x.xml": strToU8("<x/>"),
  });
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("a Drive PDF, DOCX or XLSX upload whose bytes match is imported under the canonical type", async () => {
  driveBody = strToU8("%PDF-1.7\n...");
  const pdf = await suite.downloadRemoteFile(OWNER, "google", file("transcript.pdf", "application/pdf"), log());
  assert.equal(pdf.mimeType, "application/pdf");
  assert.match(driveUrls[0], /\?alt=media/);

  driveBody = ooxml(`${DOCX_MIME}.main+xml`);
  const docx = await suite.downloadRemoteFile(OWNER, "google", file("essay.docx", "application/octet-stream"), log());
  assert.equal(docx.mimeType, DOCX_MIME, "stored under the type found in the bytes");

  driveBody = ooxml(`${XLSX_MIME}.main+xml`);
  const xlsx = await suite.downloadRemoteFile(OWNER, "google", file("list.xlsx", XLSX_MIME), log());
  assert.equal(xlsx.mimeType, XLSX_MIME);
});

test("a Drive upload whose bytes don't match its name or type is refused", async () => {
  driveBody = strToU8("<html><script>x</script>");
  await assert.rejects(
    suite.downloadRemoteFile(OWNER, "google", file("report.pdf", "application/pdf"), log()),
    /don't match its type.*Google Drive/
  );
  driveBody = ooxml(`${XLSX_MIME}.main+xml`);
  await assert.rejects(suite.downloadRemoteFile(OWNER, "google", file("essay.docx", DOCX_MIME), log()), /don't match/);
  driveBody = ooxml("application/vnd.ms-word.document.macroEnabled.main+xml");
  await assert.rejects(suite.downloadRemoteFile(OWNER, "google", file("essay.docx", DOCX_MIME), log()), /don't match/);
  driveBody = strToU8("%PDF-1.7\n...");
  await assert.rejects(suite.downloadRemoteFile(OWNER, "google", file("notes.txt", "text/plain"), log()), /don't match/);
});

test("Google-native files are exported, not checked", async () => {
  // Whatever the export answers is Google's own rendering; the check doesn't run.
  driveBody = strToU8("not really a pdf");
  const doc = await suite.downloadRemoteFile(OWNER, "google", file("Essay draft", "application/vnd.google-apps.document"), log());
  assert.match(driveUrls[0], /\/export\?mimeType=application%2Fpdf/);
  assert.equal(doc.mimeType, "application/pdf");
  assert.equal(doc.filename, "Essay draft.pdf");
});
