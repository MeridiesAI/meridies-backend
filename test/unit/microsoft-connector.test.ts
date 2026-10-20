// Microsoft connector hardening (PR A): one test per checklist item.
// Graph, Microsoft's token endpoint and PostgREST are answered by a fetch stub;
// nothing reaches the network.
process.env.MICROSOFT_CLIENT_ID = "ms-client-id-0000";
process.env.MICROSOFT_CLIENT_SECRET = "ms-client-secret-0000";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";
process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { zipSync, strToU8 } from "fflate";

const { env } = await import("../../src/env.js");
const { HttpError } = await import("../../src/lib/errors.js");
const { serializeErr } = await import("../../src/lib/requestLog.js");
const { encryptToken } = await import("../../src/lib/tokenCrypto.js");
const oauth = await import("../../src/lib/oauth.js");
const suite = await import("../../src/lib/suiteApi.js");
const { detectContentType } = await import("../../src/lib/fileSniff.js");
const { checkLiveDocuments } = await import("../../src/lib/liveDocuments.js");

// ---- fetch stub ---------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Handler = (c: Call) => Response | Promise<Response> | undefined;
let calls: Call[] = [];
let handlers: Handler[] = [];
const realFetch = globalThis.fetch;

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

const OWNER = "00000000-0000-4000-8000-000000000001";
const tokenRow = (over: Record<string, unknown> = {}) => ({
  owner_id: OWNER,
  provider: "microsoft",
  account_id: "graph-me-1",
  account_email: "counselor@school.org",
  access_token_enc: encryptToken("AT-live"),
  refresh_token_enc: encryptToken("RT-1"),
  scopes: ["openid", "email", "offline_access", "User.Read", "Files.Read.All"],
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});

/** PostgREST: a GET of integration_tokens answers `row`; everything else is recorded and answered empty. */
function postgrest(row: () => Record<string, unknown> | null): Handler {
  return (c) => {
    if (!c.url.includes("/rest/v1/")) return undefined;
    const object = (c.headers["accept"] ?? "").includes("pgrst.object");
    if (c.url.includes("/rest/v1/integration_tokens") && c.method === "GET") {
      const r = row();
      return object ? (r ? json(r) : json({}, 406)) : json(r ? [r] : []);
    }
    return object ? json({}) : json([]);
  };
}

beforeEach(() => {
  calls = [];
  handlers = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? init.body : null;
    const c = { url, method: (init?.method ?? "GET").toUpperCase(), headers, body };
    calls.push(c);
    for (const h of handlers) {
      const r = await h(c);
      if (r) return r;
    }
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
  suite.__sleep.fn = async () => undefined;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const log = () => {
  const lines: string[] = [];
  return { lines, warn: (obj: object, msg: string) => void lines.push(JSON.stringify(obj) + " " + msg) };
};

// ---- 1. Scopes: no Mail.Send; Calendar only when turned on ----------------------

test("Microsoft connect asks for files only; Calendar only with add=calendar; never Mail.Send", () => {
  const base = oauth.microsoftScopesFor({ calendar: false });
  assert.ok(base.includes("offline_access"), "offline_access is requested");
  assert.ok(base.includes("Files.Read.All"));
  assert.ok(!base.some((s) => /^mail\./i.test(s)), "no Mail.* scope");
  assert.ok(!base.includes("Calendars.ReadWrite"));
  assert.ok(oauth.microsoftScopesFor({ calendar: true }).includes("Calendars.ReadWrite"));

  const connect = oauth.microsoftAuthorizeParams({ add: null, loginHint: null });
  assert.equal(connect.prompt, "select_account");
  assert.ok(!connect.scope.includes("Calendars"));
  const cal = oauth.microsoftAuthorizeParams({ add: "calendar", loginHint: "counselor@school.org" });
  assert.ok(cal.scope.split(" ").includes("Calendars.ReadWrite"));
  assert.equal(cal.login_hint, "counselor@school.org");
});

// ---- 2. State + PKCE on the Microsoft consent URL ------------------------------

test("the Microsoft consent URL carries state and an S256 PKCE challenge", async () => {
  handlers.push(postgrest(() => null));
  const url = new URL(await oauth.beginAuthorization(OWNER, "microsoft", { add: null }));
  assert.equal(url.host, "login.microsoftonline.com");
  assert.ok((url.searchParams.get("state") ?? "").length >= 40);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok((url.searchParams.get("code_challenge") ?? "").length >= 43);
  assert.ok(url.searchParams.get("scope")!.split(" ").includes("offline_access"));
  const stored = calls.find((c) => c.method === "POST" && c.url.includes("integration_oauth_states"));
  assert.ok(stored, "state is stored");
  assert.ok(!stored!.body!.includes(url.searchParams.get("state")!), "only the state's hash is stored");
  assert.match(stored!.body!, /"code_verifier_enc":"v1\./, "the PKCE verifier is stored encrypted");
});

// ---- 3. Account match on reconnect ----------------------------------------------

test("a Microsoft reconnect as a different account is refused and nothing is saved", async () => {
  handlers.push((c) => {
    if (c.url.includes("integration_oauth_states") && c.method === "DELETE") {
      return json([{ owner_id: OWNER, code_verifier_enc: encryptToken("verifier"), expires_at: new Date(Date.now() + 60_000).toISOString() }]);
    }
    if (c.url.includes("/oauth2/v2.0/token")) {
      return json({ access_token: "AT-other", refresh_token: "RT-other", expires_in: 3600, scope: "openid email Files.Read.All" });
    }
    if (c.url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json({ id: "graph-me-OTHER", mail: "other@school.org" });
    return undefined;
  });
  handlers.push(postgrest(() => tokenRow()));
  await assert.rejects(
    oauth.completeAuthorization(OWNER, "microsoft", "code", "state", log()),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "microsoft_other_account"
  );
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/integration_tokens")), "no token upsert");
});

// ---- 4. Rotation: compare-and-swap; a lost race uses the stored token ---------------

function fakeDb(opts: { updatedRows: number; latest: Record<string, unknown> }) {
  const seen: { filters: [string, unknown][] } = { filters: [] };
  const db = {
    from: () => ({
      update: () => {
        const chain = {
          eq: (k: string, v: unknown) => (seen.filters.push([k, v]), chain),
          select: async () => ({ data: Array.from({ length: opts.updatedRows }, () => ({ owner_id: OWNER })), error: null }),
        };
        return chain;
      },
      select: () => {
        const chain = { eq: () => chain, maybeSingle: async () => ({ data: opts.latest, error: null }) };
        return chain;
      },
    }),
  };
  return { db, seen };
}

const msConfig = () => ({
  label: "Microsoft",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  clientId: "ms-client-id-0000",
  clientSecret: "ms-client-secret-0000",
  scopes: oauth.microsoftScopesFor({ calendar: false }),
  extraAuthorizeParams: {},
});

test("a rotated refresh token is saved only over the one it replaced; losing the race uses the stored token", async () => {
  handlers.push((c) => (c.url.includes("/oauth2/v2.0/token") ? json({ access_token: "AT-mine", refresh_token: "RT-2", expires_in: 3600 }) : undefined));
  const row = tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const winner = tokenRow({ access_token_enc: encryptToken("AT-winner"), refresh_token_enc: encryptToken("RT-winner") });

  const lost = fakeDb({ updatedRows: 0, latest: winner });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const live = await oauth.__test.refreshGrant(lost.db as any, msConfig(), OWNER, "microsoft", row);
  assert.deepEqual(lost.seen.filters.find(([k]) => k === "refresh_token_enc"), ["refresh_token_enc", row.refresh_token_enc]);
  assert.equal(live.accessToken, "AT-winner", "the stored (winning) token is used");

  const won = fakeDb({ updatedRows: 1, latest: winner });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mine = await oauth.__test.refreshGrant(won.db as any, msConfig(), OWNER, "microsoft", row);
  assert.equal(mine.accessToken, "AT-mine");
});

test("a refresh keeps Calendar on a grant that has it and never adds it to one that doesn't", async () => {
  handlers.push((c) => (c.url.includes("/oauth2/v2.0/token") ? json({ access_token: "AT", refresh_token: "RT-3", expires_in: 3600 }) : undefined));
  const { db } = fakeDb({ updatedRows: 1, latest: tokenRow() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await oauth.__test.refreshGrant(db as any, msConfig(), OWNER, "microsoft", tokenRow());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await oauth.__test.refreshGrant(db as any, msConfig(), OWNER, "microsoft", tokenRow({ scopes: ["Files.Read.All", "https://graph.microsoft.com/Calendars.ReadWrite"] }));
  const scopes = calls.filter((c) => c.url.includes("/token")).map((c) => new URLSearchParams(c.body!).get("scope")!);
  assert.ok(!scopes[0].includes("Calendars.ReadWrite"));
  assert.ok(scopes[1].includes("Calendars.ReadWrite"));
});

// ---- 5. invalid_grant marks the connection lost ------------------------------------

test("invalid_grant marks the Microsoft grant broken and answers microsoft_reconnect", async () => {
  handlers.push((c) => (c.url.includes("/oauth2/v2.0/token") ? json({ error: "invalid_grant" }, 400) : undefined));
  handlers.push(postgrest(() => null));
  const row = tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const { db } = fakeDb({ updatedRows: 1, latest: row });
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oauth.__test.refreshGrant(db as any, msConfig(), OWNER, "microsoft", row),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "microsoft_reconnect"
  );
  const marked = calls.find((c) => c.method === "PATCH" && c.url.includes("/rest/v1/integrations"));
  assert.ok(marked, "the visible grant is updated");
  assert.match(marked!.body!, /"status":"error"/);
});

// ---- 6. OData search escaping -----------------------------------------------------

/** Reads the OData string literal inside search(q='...') the way Graph does: decode, then '' -> '. */
function searchLiteral(url: string): string {
  const m = /search\(q='(.*)'\)\?/.exec(url);
  assert.ok(m, "a single quoted literal");
  const decoded = decodeURIComponent(m![1]);
  assert.ok(!/(^|[^'])'([^']|$)/.test(decoded.replace(/''/g, "")), "no lone quote ends the literal early");
  return decoded.replace(/''/g, "'");
}

test("OneDrive search escapes quotes and URL-encodes: o'brien and ') or ( stay search words", () => {
  for (const q of ["o'brien", "') or (", "a'b''c", "50% & more/#?"]) {
    const url = suite.graphSearchUrl(q);
    assert.equal(searchLiteral(url), q);
    const literal = /search\(q='(.*)'\)\?/.exec(url)![1];
    assert.ok(!/['()]/.test(literal), "quotes and parentheses are percent-encoded");
  }
});

// ---- 7. Nothing about a browse or search reaches the logs --------------------------

test("a failed browse and a search never log a file name or the search words", async () => {
  const secret = "Okafor_FAFSA_2027";
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => {
    if (c.url.includes("/me/drive/recent") || c.url.includes("/root/children")) return json({ error: { message: `cannot list ${secret}.pdf` } }, 500);
    return undefined;
  });
  const l = log();
  const browse = await suite.listRemoteFiles(OWNER, "microsoft", undefined, l).catch((e: unknown) => e);
  assert.ok(browse instanceof HttpError);

  // A search that fails at the network level (the URL holds the words).
  handlers.splice(1, 1);
  const search = await suite.listRemoteFiles(OWNER, "microsoft", secret, l).catch((e: unknown) => e);
  assert.ok(search instanceof HttpError);

  // A search that succeeds returns names to the caller only.
  handlers.push((c) =>
    c.url.includes("/root/search(") ? json({ value: [{ id: "A1", name: `${secret}.pdf`, size: 10, file: { mimeType: "application/pdf" } }] }) : undefined
  );
  const found = await suite.listRemoteFiles(OWNER, "microsoft", secret, l);
  assert.equal(found[0].name, `${secret}.pdf`);

  const logged = [...l.lines, JSON.stringify(serializeErr(browse)), JSON.stringify(serializeErr(search))].join("\n");
  assert.ok(!logged.includes(secret), logged);
});

// ---- 8. 429: Retry-After with backoff ----------------------------------------------

test("Retry-After is read as seconds or a date; without it the backoff doubles", () => {
  assert.equal(suite.retryAfterMs("3"), 3000);
  assert.equal(suite.retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(suite.retryAfterMs("soon"), null);
  assert.equal(suite.backoffMs(0, null), 1000);
  assert.equal(suite.backoffMs(1, null), 2000);
  assert.equal(suite.backoffMs(1, 3000), 3000);
});

test("the tracker waits out a 429 and retries; a long Retry-After holds the check as rate-limited", async () => {
  const waits: number[] = [];
  suite.__sleep.fn = async (ms: number) => void waits.push(ms);
  handlers.push(postgrest(() => tokenRow()));
  let n = 0;
  handlers.push((c) => {
    if (!c.url.includes("/drive/items/ITEM1")) return undefined;
    n += 1;
    return n === 1
      ? json({}, 429, { "retry-after": "2" })
      : json({ id: "ITEM1", name: "essay.docx", lastModifiedDateTime: "2026-10-19T10:00:00Z", file: { mimeType: "x" } });
  });
  const request = { log: log(), db: { from: () => ({ update: () => ({ eq: async () => ({}) }) }) } };
  const doc = { id: "D1", owner_id: OWNER, external_provider: "microsoft", external_file_id: "ITEM1", available_to_llm: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ok = await checkLiveDocuments(request as any, [doc]);
  assert.equal(ok.checks[0].error, null);
  assert.deepEqual(waits, [2000]);

  handlers.pop();
  handlers.push((c) => (c.url.includes("/drive/items/ITEM1") ? json({}, 429, { "retry-after": "120" }) : undefined));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const held = await checkLiveDocuments(request as any, [{ ...doc }]);
  assert.equal(held.checks[0].errorCode, "provider_rate_limited");
  assert.equal(held.latestEdit, null);
});

// ---- 9. Download: manual redirects, allowlisted hosts, no Authorization ------------

test("download hosts: exact or dot-boundary suffix, HTTPS only, no port or credentials", () => {
  for (const ok of [
    "https://contoso-my.sharepoint.com/personal/x/_layouts/15/download.aspx?a=1",
    "https://sharepoint.com/x",
    "https://public.dm.files.1drv.com/y",
    "https://abc.livefilestore.com/z",
  ]) assert.ok(suite.isMicrosoftDownloadUrl(ok), ok);
  for (const bad of [
    "https://evil-sharepoint.com/x",
    "https://sharepoint.com.evil.io/x",
    "http://contoso.sharepoint.com/x",
    "https://contoso.sharepoint.com:8443/x",
    "https://user:pw@contoso.sharepoint.com/x",
    "https://contoso.sharepoint.com./x",
    "https://127.0.0.1/x",
    "not a url",
  ]) assert.ok(!suite.isMicrosoftDownloadUrl(bad), bad);
});

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

test("a download follows at most two redirects, to allowed hosts only, never with Authorization", async () => {
  handlers.push((c) => (c.url === "https://a.sharepoint.com/1" ? redirect("https://b.sharepoint.com/2") : undefined));
  handlers.push((c) => (c.url === "https://b.sharepoint.com/2" ? new Response("%PDF-1.7 ok") : undefined));
  const res = await suite.followDownload(redirect("https://a.sharepoint.com/1"));
  assert.equal(await res.text(), "%PDF-1.7 ok");
  assert.ok(calls.every((c) => !("authorization" in c.headers)), "no Authorization after the first request");
  assert.ok(calls.every((c) => c.url.startsWith("https://")));

  calls = [];
  handlers.unshift((c) => (c.url === "https://b.sharepoint.com/2" ? redirect("https://c.sharepoint.com/3") : undefined));
  await assert.rejects(suite.followDownload(redirect("https://a.sharepoint.com/1")), /too many times/);
  assert.ok(!calls.some((c) => c.url.includes("c.sharepoint.com")), "the third hop is never fetched");

  calls = [];
  await assert.rejects(suite.followDownload(redirect("https://evil-sharepoint.com/x")), /doesn't fetch from/);
  await assert.rejects(suite.followDownload(redirect("http://a.sharepoint.com/x")), /doesn't fetch from/);
  assert.equal(calls.length, 0);
});

test("an import checks size from metadata before downloading and caps the stream", async () => {
  handlers.push(postgrest(() => tokenRow()));
  const big = { id: "I", driveId: null, name: "big.pdf", mimeType: "application/pdf", kind: "pdf" as const, modifiedAt: null, sizeBytes: suite.MAX_IMPORT_BYTES + 1, webUrl: null, lastModifiedBy: null, lastModifiedByOwner: null, importable: true };
  await assert.rejects(suite.downloadRemoteFile(OWNER, "microsoft", big, log()), /larger than 25 MB/);
  assert.ok(!calls.some((c) => c.url.includes("graph.microsoft.com")), "nothing fetched");

  // Metadata says small; the stream says otherwise.
  handlers.push((c) => (c.url.includes("/content") ? redirect("https://x.sharepoint.com/dl") : undefined));
  handlers.push((c) =>
    c.url === "https://x.sharepoint.com/dl"
      ? new Response(new ReadableStream({
          pull(ctl) {
            ctl.enqueue(new Uint8Array(4 * 1024 * 1024));
          },
        }))
      : undefined
  );
  await assert.rejects(suite.downloadRemoteFile(OWNER, "microsoft", { ...big, sizeBytes: 10 }, log()), /larger than 25 MB/);
  const graph = calls.find((c) => c.url.includes("/content"))!;
  assert.ok(graph.headers.authorization?.startsWith("Bearer "), "the Graph request is authorized");
  assert.ok(!calls.find((c) => c.url.includes("x.sharepoint.com"))!.headers.authorization, "the storage hop is not");
});

// ---- 10. Content check by magic bytes --------------------------------------------

const ooxml = (main: string) =>
  zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types><Override PartName="/x" ContentType="${main}"/></Types>`),
    "x.xml": strToU8("<x/>"),
  });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

test("imports must be what they claim: %PDF, DOCX/XLSX zips with the matching content type", () => {
  const pdf = strToU8("%PDF-1.7\n...");
  assert.deepEqual(detectContentType(pdf, "a.pdf", null), { ok: true, mimeType: "application/pdf" });
  assert.equal(detectContentType(ooxml(DOCX), "essay.docx", null).ok, true);
  assert.equal(detectContentType(ooxml(XLSX), "list.xlsx", null).ok, true);

  assert.equal(detectContentType(strToU8("<html>"), "a.pdf", "application/pdf").ok, false, "HTML named .pdf");
  assert.equal(detectContentType(ooxml(XLSX), "essay.docx", null).ok, false, "a workbook named .docx");
  assert.equal(detectContentType(ooxml(DOCX), "list.xlsx", null).ok, false);
  assert.equal(detectContentType(zipSync({ "a.txt": strToU8("x") }), "essay.docx", null).ok, false, "a plain zip named .docx");
  assert.equal(detectContentType(ooxml("application/vnd.ms-word.document.macroEnabled.main+xml"), "essay.docx", null).ok, false, "macros");
  assert.equal(detectContentType(pdf, "notes.txt", null).ok, false, "a PDF named .txt");
  assert.equal(detectContentType(pdf, "noext", "text/plain").ok, false, "a PDF declared text");
  assert.equal(detectContentType(new Uint8Array(0), "a.pdf", null).ok, false, "empty");
  assert.equal(detectContentType(strToU8("hello"), "notes.txt", null).ok, true);
  assert.equal(detectContentType(zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.text") }), "a.odt", null).ok, true, "unknown types pass");
});

test("a OneDrive import whose bytes don't match is refused", () => {
  assert.throws(() => suite.checkImportContent("microsoft", strToU8("<script>"), "report.pdf", "application/pdf"), /don't match its type/);
  assert.equal(suite.checkImportContent("microsoft", ooxml(DOCX), "essay.docx", "application/octet-stream"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

// ---- 11. Disconnect link and pick cap ----------------------------------------------

test("disconnect links personal accounts to account.live.com and others to My Apps", () => {
  assert.equal(oauth.microsoftConsentUrl("9188040d-6c67-4c5b-b112-36a304b66dad"), "https://account.live.com/consent/Manage");
  assert.equal(oauth.microsoftConsentUrl("9188040D-6C67-4C5B-B112-36A304B66DAD"), "https://account.live.com/consent/Manage");
  assert.equal(oauth.microsoftConsentUrl("72f988bf-86f1-41af-91ab-2d7cd011db47"), "https://myapps.microsoft.com");
  assert.equal(oauth.microsoftConsentUrl(null), "https://myapps.microsoft.com");
});

test("the Microsoft pick cap is configurable and defaults to 10", () => {
  assert.equal(env.MICROSOFT_PICKER_MAX_FILES, 10);
});

// ---- 12. Tokens are encrypted at rest -------------------------------------------

test("stored tokens are AES-GCM ciphertext, not the token", () => {
  const sealed = encryptToken("RT-plain");
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes("RT-plain"));
});
