// OneDrive picker (Microsoft connector PR B, spec docs/superpowers/specs/2026-11-01-onedrive-picker-design.md).
// Microsoft's token endpoint, Graph and PostgREST are answered by a fetch stub; nothing reaches the network.
process.env.MICROSOFT_CLIENT_ID = "ms-client-id-0000";
process.env.MICROSOFT_CLIENT_SECRET = "ms-client-secret-0000";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";
process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const { HttpError } = await import("../../src/lib/errors.js");
const { serializeErr } = await import("../../src/lib/requestLog.js");
const { decryptToken, encryptToken } = await import("../../src/lib/tokenCrypto.js");
const oauth = await import("../../src/lib/oauth.js");
const suite = await import("../../src/lib/suiteApi.js");

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Handler = (c: Call) => Response | Promise<Response> | undefined;
let calls: Call[] = [];
let handlers: Handler[] = [];
const realFetch = globalThis.fetch;

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

const OWNER = "00000000-0000-4000-8000-000000000002";
const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const WORK = { kind: "work" as const, tenantId: TENANT, resource: "https://contoso-my.sharepoint.com" };

const tokenRow = (over: Record<string, unknown> = {}) => ({
  owner_id: OWNER,
  provider: "microsoft",
  account_id: "graph-me-2",
  account_email: "counselor@school.org",
  access_token_enc: encryptToken("AT-graph"),
  refresh_token_enc: encryptToken("RT-1"),
  scopes: ["openid", "email", "offline_access", "User.Read", "Files.Read"],
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});

/**
 * PostgREST over one integration_tokens row. A PATCH applies only when its
 * refresh_token_enc filter (if any) still matches, like the real
 * compare-and-swap; every write is recorded.
 */
function tokenStore(initial: Record<string, unknown>) {
  const state = { row: { ...initial }, patches: [] as { filter: string | null; body: Record<string, unknown>; applied: boolean }[] };
  const handler: Handler = (c) => {
    if (!c.url.includes("/rest/v1/")) return undefined;
    const object = (c.headers["accept"] ?? "").includes("pgrst.object");
    if (c.url.includes("/rest/v1/integration_tokens")) {
      if (c.method === "GET") return object ? json(state.row) : json([state.row]);
      if (c.method === "PATCH") {
        const filter = new URL(c.url).searchParams.get("refresh_token_enc");
        const body = JSON.parse(c.body ?? "{}") as Record<string, unknown>;
        const applied = filter === null || filter === `eq.${state.row.refresh_token_enc}`;
        state.patches.push({ filter, body, applied });
        if (applied) state.row = { ...state.row, ...body };
        return json(applied ? [{ owner_id: OWNER }] : []);
      }
    }
    return object ? json({}) : json([]);
  };
  return { state, handler };
}

/** Microsoft's token endpoint: rotates the refresh token on every use and refuses one already spent. */
function tokenEndpoint(opts: { refuse?: Record<string, unknown> } = {}) {
  const spent: string[] = [];
  let n = 1;
  const handler: Handler = (c) => {
    if (!c.url.startsWith("https://login.microsoftonline.com/")) return undefined;
    const form = new URLSearchParams(c.body ?? "");
    const rt = form.get("refresh_token") ?? "";
    if (opts.refuse) return json(opts.refuse, 400);
    if (spent.includes(rt)) return json({ error: "invalid_grant", error_codes: [70000] }, 400);
    spent.push(rt);
    n += 1;
    const pickerCall = !(form.get("scope") ?? "").includes("Files.Read");
    return json({
      access_token: pickerCall ? `PICKER-${n}` : `AT-${n}`,
      refresh_token: `RT-${n}`,
      expires_in: 3600,
      scope: form.get("scope"),
    });
  };
  return { spent, handler };
}

const log = () => {
  const lines: string[] = [];
  return { lines, warn: (obj: object, msg: string) => void lines.push(JSON.stringify(obj) + " " + msg) };
};

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

// ---- Which token, from where ------------------------------------------------------

test("personal accounts ask the consumers endpoint for OneDrive.ReadOnly; work accounts their own directory for their OneDrive", () => {
  assert.deepEqual(oauth.pickerTokenRequest({ kind: "personal" }), {
    tokenUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    scope: "OneDrive.ReadOnly offline_access",
  });
  assert.deepEqual(oauth.pickerTokenRequest(WORK), {
    tokenUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    scope: "https://contoso-my.sharepoint.com/.default offline_access",
  });
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof HttpError ? e.code : "other";
    }
    return null;
  };
  assert.equal(code(() => oauth.pickerTokenRequest({ ...WORK, tenantId: "common" })), "microsoft_reconnect");
  assert.equal(code(() => oauth.pickerTokenRequest({ ...WORK, tenantId: `${TENANT}/../x` })), "microsoft_reconnect");
  for (const resource of [
    "https://contoso.sharepoint.com",
    "https://graph.microsoft.com",
    "https://contoso-my.sharepoint.com.evil.io",
    "http://contoso-my.sharepoint.com",
    "https://contoso-my.sharepoint.us",
    "https://contoso-my.sharepoint.com/personal/x",
  ]) {
    assert.equal(code(() => oauth.pickerTokenRequest({ ...WORK, resource })), "onedrive_unsupported", resource);
  }
});

test("the picker setup follows the drive Graph reports, and only a standard -my.sharepoint.com host gets a work picker", () => {
  const personal = suite.pickerSetup({ driveId: "abc123", driveType: "personal", webUrl: "https://onedrive.live.com/?cid=abc123" }, oauth.MSA_TENANT_ID);
  assert.equal(personal.accountType, "personal");
  assert.equal(personal.baseUrl, "https://onedrive.live.com/picker");
  assert.equal(personal.pickerOrigin, "https://onedrive.live.com");
  assert.deepEqual(personal.target, { kind: "personal" });

  const work = suite.pickerSetup(
    { driveId: "b!x", driveType: "business", webUrl: "https://Contoso-my.sharepoint.com/personal/c_contoso_org/Documents" },
    TENANT
  );
  assert.equal(work.accountType, "work");
  assert.equal(work.baseUrl, "https://contoso-my.sharepoint.com");
  assert.equal(work.pickerOrigin, "https://contoso-my.sharepoint.com");
  assert.deepEqual(work.target, { kind: "work", tenantId: TENANT, resource: "https://contoso-my.sharepoint.com" });

  const code = (drive: Parameters<typeof suite.pickerSetup>[0], tenant: string | null) => {
    try {
      suite.pickerSetup(drive, tenant);
    } catch (e) {
      return e instanceof HttpError ? e.code : "other";
    }
    return null;
  };
  assert.equal(code({ driveId: "x", driveType: "personal", webUrl: null }, TENANT), "onedrive_unsupported", "a personal drive under a work directory");
  assert.equal(code({ driveId: "x", driveType: "documentLibrary", webUrl: "https://contoso.sharepoint.com/sites/a" }, TENANT), "onedrive_unsupported");
  assert.equal(code({ driveId: "x", driveType: "business", webUrl: "https://contoso.sharepoint.us/personal/a" }, TENANT), "onedrive_unsupported");
  assert.equal(code({ driveId: "x", driveType: "business", webUrl: "not a url" }, TENANT), "onedrive_unsupported");
  assert.equal(code({ driveId: "x", driveType: "business", webUrl: null }, TENANT), "onedrive_unsupported");
  assert.equal(code({ driveId: "x", driveType: "business", webUrl: "https://contoso-my.sharepoint.com/p" }, null), "microsoft_reconnect");
  assert.equal(code({ driveId: "x", driveType: "business", webUrl: "https://contoso-my.sharepoint.com/p" }, oauth.MSA_TENANT_ID), "microsoft_reconnect");
});

test("the drive read needs Files.Read: an old Files.Read.All-only grant is asked to reconnect", async () => {
  const store = tokenStore(tokenRow({ scopes: ["openid", "Files.Read.All"] }));
  handlers.push(store.handler);
  await assert.rejects(suite.oneDriveInfo(OWNER, log()), (e: unknown) => e instanceof HttpError && e.code === "files_not_granted");
  assert.ok(!calls.some((c) => c.url.includes("graph.microsoft.com")), "Graph is never called");

  store.state.row = tokenRow();
  handlers.push((c) =>
    c.url.startsWith("https://graph.microsoft.com/v1.0/me/drive?") ? json({ id: "abc123", driveType: "personal", webUrl: "https://onedrive.live.com/?cid=abc123" }) : undefined
  );
  assert.deepEqual(await suite.oneDriveInfo(OWNER, log()), { driveId: "abc123", driveType: "personal", webUrl: "https://onedrive.live.com/?cid=abc123" });
});

// ---- The exchange --------------------------------------------------------------------

test("a picker token is exchanged from the stored grant; only the rotated refresh token is saved, compare-and-swap", async () => {
  const initial = tokenRow();
  const store = tokenStore(initial);
  const ms = tokenEndpoint();
  handlers.push(store.handler, ms.handler);
  const l = log();
  const got = await oauth.pickerTokenFor(OWNER, WORK, l);
  assert.equal(got.token, "PICKER-2");
  assert.ok(Date.parse(got.expiresAt) > Date.now() + 50 * 60_000, "about an hour");

  const exchange = calls.find((c) => c.url.startsWith("https://login.microsoftonline.com/"))!;
  assert.equal(exchange.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  const form = new URLSearchParams(exchange.body!);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "RT-1");
  assert.equal(form.get("scope"), "https://contoso-my.sharepoint.com/.default offline_access");

  assert.equal(store.state.patches.length, 1);
  const patch = store.state.patches[0];
  assert.deepEqual(Object.keys(patch.body), ["refresh_token_enc"], "the picker token and the Graph token are never written");
  assert.equal(patch.filter, `eq.${initial.refresh_token_enc}`, "saved only over the refresh token it spent");
  assert.equal(decryptToken(String(store.state.row.refresh_token_enc)), "RT-2");
  assert.equal(decryptToken(String(store.state.row.access_token_enc)), "AT-graph");

  const logged = [...l.lines, JSON.stringify(calls.filter((c) => c.url.includes("/rest/v1/")).map((c) => c.body))].join("\n");
  assert.ok(!logged.includes("PICKER-2"), "the picker token is never logged or stored");
});

test("a picker exchange and a Graph refresh at the same moment never spend the same refresh token", async () => {
  const store = tokenStore(tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() }));
  const ms = tokenEndpoint();
  handlers.push(store.handler, ms.handler);
  const [picker, graph] = await Promise.all([
    oauth.pickerTokenFor(OWNER, { kind: "personal" }, log()),
    oauth.accessTokenFor(OWNER, "microsoft"),
  ]);
  assert.match(picker.token, /^PICKER-/);
  assert.match(graph.accessToken, /^AT-/);
  assert.equal(new Set(ms.spent).size, ms.spent.length, `no refresh token spent twice: ${ms.spent.join(",")}`);
  assert.ok(store.state.patches.every((p) => p.applied), "every rotation was saved over the token it spent");

  // And the other way round.
  calls = [];
  store.state.row = tokenRow({ refresh_token_enc: store.state.row.refresh_token_enc, expires_at: new Date(Date.now() - 1000).toISOString() });
  ms.spent.length = 0;
  await Promise.all([oauth.accessTokenFor(OWNER, "microsoft"), oauth.pickerTokenFor(OWNER, { kind: "personal" }, log())]);
  assert.equal(new Set(ms.spent).size, ms.spent.length, `no refresh token spent twice: ${ms.spent.join(",")}`);
});

test("two picker opens at once share one exchange", async () => {
  const store = tokenStore(tokenRow());
  const ms = tokenEndpoint();
  handlers.push(store.handler, ms.handler);
  const [a, b] = await Promise.all([oauth.pickerTokenFor(OWNER, { kind: "personal" }, log()), oauth.pickerTokenFor(OWNER, { kind: "personal" }, log())]);
  assert.equal(a.token, b.token);
  assert.equal(ms.spent.length, 1);
});

test("missing consent answers picker_consent_needed and leaves the grant alone", async () => {
  for (const refuse of [
    { error: "invalid_grant", suberror: "consent_required", error_codes: [65001] },
    { error: "invalid_grant", error_codes: [90094] },
    { error: "consent_required" },
  ]) {
    calls = [];
    handlers = [];
    const store = tokenStore(tokenRow());
    handlers.push(store.handler, tokenEndpoint({ refuse }).handler);
    await assert.rejects(
      oauth.pickerTokenFor(OWNER, WORK, log()),
      (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "picker_consent_needed" && /IT admin/.test(e.message)
    );
    assert.ok(!calls.some((c) => c.method === "PATCH" && c.url.includes("/rest/v1/integrations")), "the grant isn't marked broken");
  }
});

test("a directory without OneDrive answers onedrive_unsupported; Microsoft asking for a sign-in answers microsoft_reconnect", async () => {
  let store = tokenStore(tokenRow());
  handlers.push(store.handler, tokenEndpoint({ refuse: { error: "invalid_resource", error_codes: [500011] } }).handler);
  await assert.rejects(oauth.pickerTokenFor(OWNER, WORK, log()), (e: unknown) => e instanceof HttpError && e.code === "onedrive_unsupported");

  handlers = [];
  store = tokenStore(tokenRow());
  handlers.push(store.handler, tokenEndpoint({ refuse: { error: "interaction_required", error_codes: [50076] } }).handler);
  await assert.rejects(oauth.pickerTokenFor(OWNER, WORK, log()), (e: unknown) => e instanceof HttpError && e.code === "microsoft_reconnect");
  assert.ok(!calls.some((c) => c.method === "PATCH" && c.url.includes("/rest/v1/integrations")), "not marked broken for a sign-in prompt");
});

test("a refresh token rotated elsewhere is retried once; a dead grant is marked broken", async () => {
  // Another replica rotated RT-1 to RT-9 between our read and our exchange.
  const store = tokenStore(tokenRow());
  let first = true;
  handlers.push((c) => {
    if (!c.url.startsWith("https://login.microsoftonline.com/")) return undefined;
    const rt = new URLSearchParams(c.body ?? "").get("refresh_token");
    if (first) {
      first = false;
      store.state.row = { ...store.state.row, refresh_token_enc: encryptToken("RT-9") };
      return json({ error: "invalid_grant", error_codes: [70000] }, 400);
    }
    return rt === "RT-9" ? json({ access_token: "PICKER-OK", refresh_token: "RT-10", expires_in: 3600 }) : json({ error: "invalid_grant" }, 400);
  });
  handlers.push(store.handler);
  assert.equal((await oauth.pickerTokenFor(OWNER, { kind: "personal" }, log())).token, "PICKER-OK");

  calls = [];
  handlers = [];
  const dead = tokenStore(tokenRow());
  handlers.push(dead.handler, tokenEndpoint({ refuse: { error: "invalid_grant", error_codes: [70000] } }).handler);
  await assert.rejects(oauth.pickerTokenFor(OWNER, { kind: "personal" }, log()), (e: unknown) => e instanceof HttpError && e.code === "microsoft_reconnect");
  const marked = calls.find((c) => c.method === "PATCH" && c.url.includes("/rest/v1/integrations"));
  assert.match(marked?.body ?? "", /"status":"error"/);
});

test("a refused exchange logs codes only, never Microsoft's description or a token", async () => {
  const store = tokenStore(tokenRow());
  handlers.push(store.handler, tokenEndpoint({ refuse: { error: "invalid_grant", error_codes: [65001], error_description: "AADSTS65001 for counselor@school.org RT-1" } }).handler);
  const l = log();
  const err = await oauth.pickerTokenFor(OWNER, WORK, l).catch((e: unknown) => e);
  const logged = [...l.lines, JSON.stringify(serializeErr(err))].join("\n");
  assert.ok(logged.includes("65001"));
  assert.ok(!logged.includes("counselor@school.org") && !logged.includes("RT-1"), logged);
});

// ---- Import: own drive only ------------------------------------------------------------

test("a picked file is read from the counselor's own drive, never from a drive id the browser sent", async () => {
  handlers.push(tokenStore(tokenRow()).handler);
  handlers.push((c) =>
    c.url.startsWith("https://graph.microsoft.com/v1.0/me/drive/items/ITEM7?")
      ? json({ id: "ITEM7", name: "essay.docx", size: 10, file: { mimeType: "application/msword" }, parentReference: { driveId: "own-drive" } })
      : undefined
  );
  const file = await suite.getOwnOneDriveFile(OWNER, "ITEM7", log());
  assert.equal(file.driveId, "own-drive", "the stored drive id is the counselor's own");
  assert.ok(!calls.some((c) => c.url.includes("/drives/")), "no /drives/{id} URL is ever built");

  // The tracker reads through the same own-drive path.
  calls = [];
  await suite.getRemoteFile(OWNER, "microsoft", "ITEM7", "someone-elses-drive", log());
  assert.ok(calls.some((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/me/drive/items/ITEM7?")));
  assert.ok(!calls.some((c) => c.url.includes("someone-elses-drive")));
});

test("a file shared with the counselor answers 422 shared_not_supported with the way round, and its name isn't logged", async () => {
  for (const answer of [
    () => json({ error: { message: "itemNotFound Okafor_FAFSA.pdf" } }, 404),
    () => json({ error: { message: "accessDenied Okafor_FAFSA.pdf" } }, 403),
    () => json({ id: "S1", name: "Okafor_FAFSA.pdf", remoteItem: { id: "R1", name: "Okafor_FAFSA.pdf", file: { mimeType: "application/pdf" } } }),
  ]) {
    calls = [];
    handlers = [];
    handlers.push(tokenStore(tokenRow()).handler);
    handlers.push((c) => (c.url.includes("graph.microsoft.com/v1.0/me/drive/items/") ? answer() : undefined));
    const l = log();
    const err = await suite.getOwnOneDriveFile(OWNER, "S1", l).catch((e: unknown) => e);
    assert.ok(err instanceof HttpError && err.statusCode === 422 && err.code === "shared_not_supported", String(err));
    assert.match((err as Error).message, /Save a copy to your OneDrive/);
    assert.ok(!l.lines.join("\n").includes("Okafor"), l.lines.join("\n"));
  }
});

// ---- Personal accounts: OneDrive.ReadOnly needs its own consent (found live, 2026-11-01) -------------
// Microsoft answered a personal account's exchange with invalid_grant AADSTS70000 "one or more scopes
// requested are unauthorized ... grant the client application access to the requested scope": the
// Graph Files.Read consent doesn't cover OneDrive.ReadOnly. The grant itself was fine.

const SCOPE_REFUSED = { error: "invalid_grant", error_codes: [70000], error_description: "AADSTS70000: The request was denied because one or more scopes requested are unauthorized or expired." };

/** Microsoft refuses OneDrive.ReadOnly / .default exchanges but still refreshes Graph. */
function scopeRefusingEndpoint() {
  let n = 1;
  return (c: Call) => {
    if (!c.url.startsWith("https://login.microsoftonline.com/")) return undefined;
    const scope = new URLSearchParams(c.body ?? "").get("scope") ?? "";
    if (!scope.includes("Files.Read")) return json(SCOPE_REFUSED, 400);
    n += 1;
    return json({ access_token: `AT-${n}`, refresh_token: `RT-${n}`, expires_in: 3600, scope });
  };
}

test("a personal account whose OneDrive scope isn't consented gets onedrive_consent_needed, and the grant stays connected", async () => {
  const store = tokenStore(tokenRow());
  handlers.push(store.handler, scopeRefusingEndpoint());
  await assert.rejects(
    oauth.pickerTokenFor(OWNER, { kind: "personal" }, log()),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "onedrive_consent_needed"
  );
  assert.ok(!calls.some((c) => c.method === "PATCH" && c.url.includes("/rest/v1/integrations")), "the grant isn't marked broken");
  assert.ok(
    calls.some((c) => c.url.includes("/oauth2/v2.0/token") && (new URLSearchParams(c.body ?? "").get("scope") ?? "").includes("Files.Read")),
    "the grant was checked with a Graph refresh"
  );
});

test("the same refusal on a work account asks for the IT admin (picker_consent_needed)", async () => {
  handlers.push(tokenStore(tokenRow()).handler, scopeRefusingEndpoint());
  await assert.rejects(oauth.pickerTokenFor(OWNER, WORK, log()), (e: unknown) => e instanceof HttpError && e.code === "picker_consent_needed");
});

test("when the Graph refresh fails too, the grant really is gone: microsoft_reconnect", async () => {
  handlers.push(tokenStore(tokenRow()).handler, tokenEndpoint({ refuse: SCOPE_REFUSED }).handler);
  await assert.rejects(oauth.pickerTokenFor(OWNER, { kind: "personal" }, log()), (e: unknown) => e instanceof HttpError && e.code === "microsoft_reconnect");
});

test("the OneDrive consent asks a personal account for OneDrive.ReadOnly at Microsoft's consumers endpoint", async () => {
  const connect = oauth.microsoftAuthorizeParams({ add: null, loginHint: null });
  assert.ok(!connect.scope.split(" ").includes("OneDrive.ReadOnly"), "Connect never asks for it (a work account would refuse the scope)");
  const od = oauth.microsoftAuthorizeParams({ add: "onedrive", loginHint: "me@outlook.com" });
  assert.deepEqual(od.scope.split(" "), ["openid", "email", "offline_access", "User.Read", "Files.Read", "OneDrive.ReadOnly"]);
  assert.equal(od.login_hint, "me@outlook.com");

  // A personal grant: the consent URL is the consumers endpoint.
  handlers.push((c) =>
    c.url.includes("/rest/v1/integrations?") && c.method === "GET"
      ? json({ config: { microsoftAccount: "personal", tenantId: oauth.MSA_TENANT_ID } })
      : undefined
  );
  handlers.push(tokenStore(tokenRow({ account_email: "me@outlook.com" })).handler);
  const url = new URL(await oauth.beginAuthorization(OWNER, "microsoft", { add: "onedrive" }));
  assert.equal(`${url.origin}${url.pathname}`, "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
  assert.ok(url.searchParams.get("scope")!.split(" ").includes("OneDrive.ReadOnly"));
});

test("the OneDrive consent is refused for a work account and for Google", async () => {
  handlers.push((c) =>
    c.url.includes("/rest/v1/integrations?") && c.method === "GET" ? json({ config: { microsoftAccount: "work-or-school", tenantId: TENANT } }) : undefined
  );
  handlers.push(tokenStore(tokenRow()).handler);
  await assert.rejects(oauth.beginAuthorization(OWNER, "microsoft", { add: "onedrive" }), (e: unknown) => e instanceof HttpError && e.code === "onedrive_unsupported");
  await assert.rejects(oauth.beginAuthorization(OWNER, "google", { add: "onedrive" }), (e: unknown) => e instanceof HttpError && e.statusCode === 400);
});

test("a personal account's sign-in is completed at the consumers token endpoint", async () => {
  handlers.push((c) => {
    if (c.url.includes("integration_oauth_states") && c.method === "DELETE") {
      return json({ owner_id: OWNER, code_verifier_enc: encryptToken("verifier"), expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    if (c.url.includes("/rest/v1/integrations?") && c.method === "GET") return json({ config: { microsoftAccount: "personal", tenantId: oauth.MSA_TENANT_ID } });
    if (c.url.includes("/oauth2/v2.0/token")) {
      return json({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 3600, scope: "Files.Read User.Read", id_token: `x.${Buffer.from(JSON.stringify({ tid: oauth.MSA_TENANT_ID })).toString("base64url")}.y` });
    }
    if (c.url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json({ id: "graph-me-2", mail: "me@outlook.com" });
    return undefined;
  });
  handlers.push(tokenStore(tokenRow()).handler);
  await oauth.completeAuthorization(OWNER, "microsoft", "code", "state", log());
  const exchange = calls.find((c) => c.url.includes("/oauth2/v2.0/token"))!;
  assert.equal(exchange.url, "https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
});
