// lib/driveExport.ts: the Google Sheet a counselor's roster summary is
// exported to, created in their own Drive under drive.file. Google is never
// called here: the client takes its token source and fetch as arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import type { LiveToken } from "../../src/lib/oauth.js";
import { driveFakeRefusal, googleSheetClient, sheetTitle } from "../../src/lib/driveExport.js";

const OWNER = "55555555-5555-4555-8555-555555555555";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const SECRET = "ya29.secret-access-token";
const CSV = "Name,Email\r\nAna Lopez,ana@example.com\r\n";

const live = (scopes = [DRIVE_FILE], accessToken = SECRET): LiveToken => ({ accessToken, accountId: "g1", accountEmail: "c@example.com", scopes });

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn: fn as typeof fetch, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function logSpy() {
  const lines: string[] = [];
  return { lines, log: { warn: (obj: object, msg: string) => lines.push(JSON.stringify(obj) + " " + msg) } };
}

async function rejectsWith(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.statusCode, status);
    assert.equal(err.code, code);
    return true;
  });
}

test("sheetTitle is 'Meridies export <date>'", () => {
  assert.equal(sheetTitle(new Date("2026-11-07T23:00:00Z")), "Meridies export 2026-11-07");
});

test("creates one Google Sheet from the CSV in a multipart upload, with the caller's token", async () => {
  const f = fakeFetch([json(200, { id: "sheet_ABC123", webViewLink: "https://docs.google.com/spreadsheets/d/sheet_ABC123/edit" })]);
  const client = googleSheetClient({ token: async () => live(), fetch: f.fn });
  const { log } = logSpy();
  const r = await client.createSheet(OWNER, { title: "Meridies export 2026-11-07", csv: CSV }, log);
  assert.deepEqual(r, { webViewLink: "https://docs.google.com/spreadsheets/d/sheet_ABC123/edit" });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0]!;
  assert.ok(url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"), url);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${SECRET}`);
  assert.match(headers["Content-Type"]!, /^multipart\/related; boundary=/);
  const body = String(init.body);
  assert.ok(body.includes('"mimeType":"application/vnd.google-apps.spreadsheet"'), body);
  assert.ok(body.includes('"name":"Meridies export 2026-11-07"'));
  assert.ok(body.includes("Content-Type: text/csv; charset=UTF-8"));
  assert.ok(body.includes(CSV));
});

test("a link that isn't Google's is replaced by the Sheet's own address", async () => {
  const f = fakeFetch([json(200, { id: "sheet_ABC123", webViewLink: "javascript:alert(1)" })]);
  const client = googleSheetClient({ token: async () => live(), fetch: f.fn });
  const r = await client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log);
  assert.equal(r.webViewLink, "https://docs.google.com/spreadsheets/d/sheet_ABC123/edit");
});

test("Google not connected is drive_not_granted (409)", async () => {
  const client = googleSheetClient({
    token: async () => { throw new HttpError(409, "Google isn't connected.", "google_disconnected"); },
    fetch: fakeFetch([]).fn,
  });
  await rejectsWith(client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log), 409, "drive_not_granted");
});

test("a Google connection that needs reconnecting is drive_not_granted too", async () => {
  const client = googleSheetClient({
    token: async () => { throw new HttpError(409, "Reconnect.", "google_reconnect"); },
    fetch: fakeFetch([]).fn,
  });
  await rejectsWith(client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log), 409, "drive_not_granted");
});

test("a connection without drive.file is drive_not_granted, and Google is not called", async () => {
  const f = fakeFetch([]);
  const client = googleSheetClient({ token: async () => live(["https://www.googleapis.com/auth/calendar.events"]), fetch: f.fn });
  await rejectsWith(client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log), 409, "drive_not_granted");
  assert.equal(f.calls.length, 0);
});

test("Google integration not set up on this server is a 503 drive_unavailable", async () => {
  const client = googleSheetClient({
    token: async () => { throw new HttpError(503, "Google isn't set up"); },
    fetch: fakeFetch([]).fn,
  });
  await rejectsWith(client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log), 503, "drive_unavailable");
});

test("a 401 refreshes the token once and retries", async () => {
  const forced: boolean[] = [];
  const f = fakeFetch([json(401, {}), json(200, { id: "sheet_ABC123" })]);
  const client = googleSheetClient({
    token: async (_o, force) => { forced.push(!!force); return live([DRIVE_FILE], force ? "ya29.fresh" : SECRET); },
    fetch: f.fn,
  });
  const r = await client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log);
  assert.equal(r.webViewLink, "https://docs.google.com/spreadsheets/d/sheet_ABC123/edit");
  assert.deepEqual(forced, [false, true]);
  assert.equal((f.calls[1]!.init.headers as Record<string, string>).Authorization, "Bearer ya29.fresh");
});

test("a second 401 is drive_not_granted", async () => {
  const client = googleSheetClient({ token: async () => live(), fetch: fakeFetch([json(401, {}), json(401, {})]).fn });
  await rejectsWith(client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log), 409, "drive_not_granted");
});

test("Google failing is a calm 502 drive_failed, logged without the CSV or the token", async () => {
  for (const answer of [json(500, { error: { message: `echo ${SECRET} ${CSV}` } }), json(403, { error: "rateLimitExceeded" }), new Error(`network down ${SECRET}`)]) {
    const spy = logSpy();
    const client = googleSheetClient({ token: async () => live(), fetch: fakeFetch([answer]).fn });
    await assert.rejects(client.createSheet(OWNER, { title: "t", csv: CSV }, spy.log), (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 502);
      assert.equal(err.code, "drive_failed");
      assert.ok(!err.message.includes(SECRET) && !err.message.includes("ana@example.com"), err.message);
      return true;
    });
    const logged = spy.lines.join("\n");
    assert.ok(!logged.includes(SECRET), logged);
    assert.ok(!logged.includes("ana@example.com"), logged);
  }
});

test("an answer without a usable id is drive_failed", async () => {
  const client = googleSheetClient({ token: async () => live(), fetch: fakeFetch([json(200, { id: "../../x" })]).fn });
  await rejectsWith(client.createSheet(OWNER, { title: "t", csv: CSV }, logSpy().log), 502, "drive_failed");
});

test("the fake is refused outside development and test", () => {
  assert.equal(driveFakeRefusal({ DRIVE_EXPORT_FAKE: undefined, NODE_ENV: "production" }), null);
  assert.match(driveFakeRefusal({ DRIVE_EXPORT_FAKE: "fixture", NODE_ENV: "production" }) ?? "", /refusing to start/);
  assert.match(driveFakeRefusal({ DRIVE_EXPORT_FAKE: "fixture", NODE_ENV: undefined }) ?? "", /refusing to start/);
  assert.equal(driveFakeRefusal({ DRIVE_EXPORT_FAKE: "fixture", NODE_ENV: "development" }), null);
  assert.equal(driveFakeRefusal({ DRIVE_EXPORT_FAKE: "fixture", NODE_ENV: "test" }), null);
});
