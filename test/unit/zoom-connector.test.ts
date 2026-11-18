// Zoom connection and Zoom meetings. Zoom, its token endpoint and PostgREST are answered by an ordered fetch stub;
// nothing reaches the network. Zoom's call shapes are those of developers.zoom.us (create 201 with id + join_url,
// update and delete 204, delete of a missing meeting 404 code 3001, Basic client auth at the token endpoint).
process.env.ZOOM_CLIENT_ID = "zoom-client-id-0000";
process.env.ZOOM_CLIENT_SECRET = "zoom-client-secret-0000";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";
process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const { HttpError } = await import("../../src/lib/errors.js");
const { encryptToken } = await import("../../src/lib/tokenCrypto.js");
const oauth = await import("../../src/lib/oauth.js");
const suite = await import("../../src/lib/suiteApi.js");
const { default: integrationRoutes } = await import("../../src/routes/integrations.js");

// ---- fetch stub ---------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Handler = (c: Call) => Response | Promise<Response> | undefined;
let calls: Call[] = [];
let handlers: Handler[] = [];
const realFetch = globalThis.fetch;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });

const OWNER = "00000000-0000-4000-8000-000000000001";
const BASIC = `Basic ${Buffer.from("zoom-client-id-0000:zoom-client-secret-0000").toString("base64")}`;
const GRANTED = "meeting:write:meeting meeting:update:meeting meeting:delete:meeting user:read:user";
const tokenRow = (over: Record<string, unknown> = {}) => ({
  owner_id: OWNER,
  provider: "zoom",
  account_id: "zoom-user-1",
  account_email: "counselor@school.org",
  access_token_enc: encryptToken("AT-live"),
  refresh_token_enc: encryptToken("RT-1"),
  scopes: GRANTED.split(" "),
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

const zoomCalls = (method: string, pathPart: string) => calls.filter((c) => c.method === method && c.url.includes(pathPart));

// ---- 1. Connect: consent URL, state, PKCE -----------------------------------------

test("Zoom is its own connect provider; the suites stay Google and Microsoft", () => {
  assert.deepEqual([...oauth.SUITE_PROVIDERS], ["google", "microsoft"]);
  assert.deepEqual([...oauth.CONNECT_PROVIDERS], ["google", "microsoft", "zoom"]);
  assert.equal(oauth.providerLabel("zoom"), "Zoom");
  assert.equal(oauth.unavailableReason("zoom"), null);
  assert.equal(oauth.redirectUri("zoom"), "http://localhost:3000/dashboard/counselor/data-hub/callback/zoom");
});

test("the Zoom consent URL carries state and an S256 PKCE challenge, and asks for no scope", async () => {
  handlers.push(postgrest(() => null));
  const url = new URL(await oauth.beginAuthorization(OWNER, "zoom", { add: null }));
  assert.equal(url.origin + url.pathname, "https://zoom.us/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "zoom-client-id-0000");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3000/dashboard/counselor/data-hub/callback/zoom");
  assert.ok((url.searchParams.get("state") ?? "").length >= 40);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok((url.searchParams.get("code_challenge") ?? "").length >= 43);
  assert.equal(url.searchParams.has("scope"), false, "Zoom uses the scopes configured on the Marketplace app");
  assert.equal(url.searchParams.has("login_hint"), false);
  assert.equal(url.searchParams.has("client_secret"), false, "the secret never goes in a URL");
  const stored = calls.find((c) => c.method === "POST" && c.url.includes("integration_oauth_states"));
  assert.ok(stored, "state is stored");
  assert.match(stored!.body!, /"provider":"zoom"/);
  assert.ok(!stored!.body!.includes(url.searchParams.get("state")!), "only the state's hash is stored");
  assert.match(stored!.body!, /"code_verifier_enc":"v1\./, "the PKCE verifier is stored encrypted");
});

test("Zoom has no add-ons: asking for one is a 400, and nothing is stored", async () => {
  handlers.push(postgrest(() => null));
  await assert.rejects(oauth.beginAuthorization(OWNER, "zoom", { add: "calendar" }), (e: unknown) => e instanceof HttpError && e.statusCode === 400);
  assert.equal(calls.length, 0);
});

// ---- 2. Code exchange: Basic auth, PKCE verifier, /users/me identity -----------------

const pendingState = () =>
  json([{ owner_id: OWNER, code_verifier_enc: encryptToken("the-verifier"), expires_at: new Date(Date.now() + 60_000).toISOString() }]);

test("the code exchange authenticates with Basic, sends the PKCE verifier, reads the account from /users/me, and stores it", async () => {
  handlers.push((c) => (c.url.includes("integration_oauth_states") && c.method === "DELETE" ? pendingState() : undefined));
  handlers.push((c) =>
    c.url === "https://zoom.us/oauth/token"
      ? json({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 3599, scope: GRANTED, token_type: "bearer" })
      : undefined
  );
  handlers.push((c) => (c.url === "https://api.zoom.us/v2/users/me" ? json({ id: "zoom-user-1", email: "counselor@school.org" }) : undefined));
  handlers.push(postgrest(() => null));

  const out = await oauth.completeAuthorization(OWNER, "zoom", "the-code", "the-state", log());
  assert.deepEqual(out.scopes, GRANTED.split(" "));

  const exchange = calls.find((c) => c.url === "https://zoom.us/oauth/token")!;
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.headers.authorization, BASIC);
  const form = new URLSearchParams(exchange.body!);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "the-code");
  assert.equal(form.get("code_verifier"), "the-verifier");
  assert.equal(form.get("redirect_uri"), "http://localhost:3000/dashboard/counselor/data-hub/callback/zoom");
  assert.equal(form.has("client_secret"), false, "the secret travels in the Basic header only");
  assert.equal(form.has("scope"), false);

  const me = calls.find((c) => c.url === "https://api.zoom.us/v2/users/me")!;
  assert.equal(me.headers.authorization, "Bearer AT-new");

  const saved = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/integration_tokens"))!;
  assert.match(saved.body!, /"provider":"zoom"/);
  assert.match(saved.body!, /"account_id":"zoom-user-1"/);
  assert.match(saved.body!, /"account_email":"counselor@school.org"/);
  assert.ok(!saved.body!.includes("AT-new") && !saved.body!.includes("RT-new"), "tokens are stored encrypted");
  const grant = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/integrations"))!;
  assert.match(grant.body!, /"provider":"zoom"/);
  assert.match(grant.body!, /meeting:write:meeting/);
  assert.ok(!grant.body!.includes("config"), "no Microsoft-style config");
});

test("a Zoom reconnect as a different account is refused with zoom_other_account and nothing is saved", async () => {
  handlers.push((c) => (c.url.includes("integration_oauth_states") && c.method === "DELETE" ? pendingState() : undefined));
  handlers.push((c) => (c.url === "https://zoom.us/oauth/token" ? json({ access_token: "AT-other", refresh_token: "RT-other", expires_in: 3599, scope: GRANTED }) : undefined));
  handlers.push((c) => (c.url === "https://api.zoom.us/v2/users/me" ? json({ id: "zoom-user-OTHER", email: "other@school.org" }) : undefined));
  handlers.push(postgrest(() => tokenRow()));
  await assert.rejects(
    oauth.completeAuthorization(OWNER, "zoom", "code", "state", log()),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "zoom_other_account"
  );
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/integration_tokens")), "no token upsert");
});

test("an unreadable Zoom identity is refused rather than stored", async () => {
  handlers.push((c) => (c.url.includes("integration_oauth_states") && c.method === "DELETE" ? pendingState() : undefined));
  handlers.push((c) => (c.url === "https://zoom.us/oauth/token" ? json({ access_token: "AT", refresh_token: "RT", expires_in: 3599, scope: GRANTED }) : undefined));
  handlers.push((c) => (c.url === "https://api.zoom.us/v2/users/me" ? json({ code: 124 }, 401) : undefined));
  handlers.push(postgrest(() => null));
  await assert.rejects(oauth.completeAuthorization(OWNER, "zoom", "code", "state", log()), (e: unknown) => e instanceof HttpError && e.statusCode === 502);
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/integration_tokens")));
});

test("a refused Zoom code exchange answers 502 in words, without Zoom's body", async () => {
  handlers.push((c) => (c.url.includes("integration_oauth_states") && c.method === "DELETE" ? pendingState() : undefined));
  handlers.push((c) => (c.url === "https://zoom.us/oauth/token" ? json({ reason: "Invalid authorization code", error: "invalid_grant" }, 400) : undefined));
  handlers.push(postgrest(() => null));
  const l = log();
  await assert.rejects(oauth.completeAuthorization(OWNER, "zoom", "code", "state", l), (e: unknown) => e instanceof HttpError && e.statusCode === 502 && !/Invalid authorization/.test(e.message));
  assert.ok(l.lines.some((x) => x.includes("invalid_grant")), "the error code is logged");
});

// ---- 3. Refresh: Basic auth, rotation compare-and-swap, invalid_grant -----------------

function fakeDb(opts: { updatedRows: number; latest: Record<string, unknown> }) {
  const seen: { filters: [string, unknown][]; update: Record<string, unknown> | null } = { filters: [], update: null };
  const db = {
    from: () => ({
      update: (u: Record<string, unknown>) => {
        seen.update = u;
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

const zoomConfig = () => ({
  label: "Zoom",
  authorizeUrl: "https://zoom.us/oauth/authorize",
  tokenUrl: "https://zoom.us/oauth/token",
  clientId: "zoom-client-id-0000",
  clientSecret: "zoom-client-secret-0000",
  scopes: [],
  extraAuthorizeParams: {},
});

test("a Zoom refresh uses Basic auth and no scope, and saves the rotated refresh token only over the one it spent", async () => {
  handlers.push((c) => (c.url === "https://zoom.us/oauth/token" ? json({ access_token: "AT-mine", refresh_token: "RT-2", expires_in: 3599, scope: GRANTED }) : undefined));
  const row = tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const won = fakeDb({ updatedRows: 1, latest: row });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const live = await oauth.__test.refreshGrant(won.db as any, zoomConfig(), OWNER, "zoom", row);
  assert.equal(live.accessToken, "AT-mine");

  const req = calls.find((c) => c.url === "https://zoom.us/oauth/token")!;
  assert.equal(req.headers.authorization, BASIC);
  const form = new URLSearchParams(req.body!);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "RT-1");
  assert.equal(form.has("scope"), false, "Microsoft's scope is never sent to Zoom");
  assert.equal(form.has("client_secret"), false);
  assert.deepEqual(won.seen.filters.find(([k]) => k === "refresh_token_enc"), ["refresh_token_enc", row.refresh_token_enc], "compare-and-swap on the spent token");
  assert.ok(won.seen.update && "refresh_token_enc" in won.seen.update, "the rotated token is kept");

  const winner = tokenRow({ access_token_enc: encryptToken("AT-winner"), refresh_token_enc: encryptToken("RT-winner") });
  const lost = fakeDb({ updatedRows: 0, latest: winner });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const used = await oauth.__test.refreshGrant(lost.db as any, zoomConfig(), OWNER, "zoom", row);
  assert.equal(used.accessToken, "AT-winner", "losing the race uses the stored token");
});

test("a dead Zoom refresh token marks the grant broken and answers zoom_reconnect", async () => {
  handlers.push((c) => (c.url === "https://zoom.us/oauth/token" ? json({ reason: "Invalid Token!", error: "invalid_grant" }, 400) : undefined));
  handlers.push(postgrest(() => null));
  const row = tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const { db } = fakeDb({ updatedRows: 1, latest: row });
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oauth.__test.refreshGrant(db as any, zoomConfig(), OWNER, "zoom", row),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "zoom_reconnect"
  );
  const marked = calls.find((c) => c.method === "PATCH" && c.url.includes("/rest/v1/integrations"));
  assert.ok(marked, "the visible grant is updated");
  assert.match(marked!.body!, /"status":"error"/);
});

test("with no Zoom connection the token calls answer zoom_disconnected", async () => {
  handlers.push(postgrest(() => null));
  await assert.rejects(
    oauth.accessTokenFor(OWNER, "zoom"),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "zoom_disconnected"
  );
});

// ---- 4. Zoom meetings -----------------------------------------------------------------

const input = { title: "Essay check-in", startsAt: "2026-12-01T15:00:00.000Z", endsAt: "2026-12-01T15:45:00.000Z", description: "Bring drafts" };

test("creating a Zoom meeting posts a scheduled meeting to the connected account and returns its id and join link", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) =>
    c.method === "POST" && c.url === "https://api.zoom.us/v2/users/me/meetings"
      ? json({ id: 81234567890, join_url: "https://us05web.zoom.us/j/81234567890?pwd=abc", start_url: "https://us05web.zoom.us/s/81234567890?zak=secret" }, 201)
      : undefined
  );
  const out = await suite.createConferenceEvent(OWNER, "zoom", input, log());
  assert.deepEqual(out, { eventId: "81234567890", joinUrl: "https://us05web.zoom.us/j/81234567890?pwd=abc" });
  const req = zoomCalls("POST", "/users/me/meetings")[0]!;
  assert.equal(req.headers.authorization, "Bearer AT-live");
  assert.deepEqual(JSON.parse(req.body!), {
    topic: "Essay check-in",
    type: 2,
    start_time: "2026-12-01T15:00:00Z",
    duration: 45,
    timezone: "UTC",
    agenda: "Bring drafts",
  });
  assert.ok(!JSON.stringify(out).includes("zak="), "the host's start link is never returned");
});

test("a Zoom meeting with no join link is deleted again and nothing is saved", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.method === "POST" && c.url.endsWith("/users/me/meetings") ? json({ id: 555, join_url: "http://insecure.example/j/555" }, 201) : undefined));
  handlers.push((c) => (c.method === "DELETE" && c.url.includes("/v2/meetings/555") ? noContent() : undefined));
  await assert.rejects(suite.createConferenceEvent(OWNER, "zoom", input, log()), (e: unknown) => e instanceof HttpError && e.statusCode === 503);
  assert.equal(zoomCalls("DELETE", "/v2/meetings/555").length, 1, "the meeting made without a link is rolled back");
});

test("a Zoom grant without the create scope is a reconnect, and Zoom is never called", async () => {
  handlers.push(postgrest(() => tokenRow({ scopes: ["user:read:user"] })));
  await assert.rejects(
    suite.createConferenceEvent(OWNER, "zoom", input, log()),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === "zoom_reconnect" && /Zoom/.test(e.message)
  );
  assert.ok(!calls.some((c) => c.url.includes("api.zoom.us")));
});

test("a 401 gets one forced refresh and a retry with the new token", async () => {
  let n = 0;
  // The refresh's compare-and-swap write reports one row changed (it won the race).
  handlers.push((c) => (c.method === "PATCH" && c.url.includes("/rest/v1/integration_tokens") ? json([{ owner_id: OWNER }]) : undefined));
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.url === "https://zoom.us/oauth/token" ? json({ access_token: "AT-fresh", refresh_token: "RT-2", expires_in: 3599, scope: GRANTED }) : undefined));
  handlers.push((c) => {
    if (!c.url.endsWith("/users/me/meetings")) return undefined;
    n += 1;
    return n === 1
      ? json({ code: 124, message: "Invalid access token." }, 401)
      : json({ id: 7, join_url: "https://us05web.zoom.us/j/7" }, 201);
  });
  const out = await suite.createConferenceEvent(OWNER, "zoom", input, log());
  assert.equal(out.eventId, "7");
  const sent = zoomCalls("POST", "/users/me/meetings").map((c) => c.headers.authorization);
  assert.deepEqual(sent, ["Bearer AT-live", "Bearer AT-fresh"]);
});

test("a Zoom refusal on create maps to a safe error, never Zoom's body", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.url.endsWith("/users/me/meetings") ? json({ code: 300, message: "Invalid topic for user@school.org" }, 400) : undefined));
  const l = log();
  await assert.rejects(suite.createConferenceEvent(OWNER, "zoom", input, l), (e: unknown) => e instanceof HttpError && !/school\.org/.test(e.message));
});

test("moving a Zoom meeting sends the start and its length together; a title alone sends no time", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.method === "PATCH" && c.url.includes("/v2/meetings/81234567890") ? noContent() : undefined));
  await suite.updateCalendarEvent(OWNER, "zoom", "81234567890", { startsAt: "2026-12-02T16:00:00.000Z", endsAt: "2026-12-02T17:30:00.000Z" }, log());
  await suite.updateCalendarEvent(OWNER, "zoom", "81234567890", { title: "Renamed", description: null }, log());
  const [move, rename] = zoomCalls("PATCH", "/v2/meetings/81234567890");
  assert.deepEqual(JSON.parse(move!.body!), { start_time: "2026-12-02T16:00:00Z", timezone: "UTC", duration: 90 });
  assert.deepEqual(JSON.parse(rename!.body!), { topic: "Renamed", agenda: "" });
  // Zoom wants a start with a length: an end alone is a bug in the caller, never a silent half-move.
  await assert.rejects(suite.updateCalendarEvent(OWNER, "zoom", "81234567890", { endsAt: "2026-12-02T17:30:00.000Z" }, log()), /start time/);
  assert.equal(zoomCalls("PATCH", "/v2/meetings/").length, 2, "the half-move was never sent");
  // Nothing to change sends nothing.
  await suite.updateCalendarEvent(OWNER, "zoom", "81234567890", {}, log());
  assert.equal(zoomCalls("PATCH", "/v2/meetings/").length, 2);
});

test("a Zoom move Zoom refuses fails (a move is strict); a missing meeting is a 404", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.method === "PATCH" ? json({ code: 3001, message: "Meeting does not exist: 1." }, 404) : undefined));
  await assert.rejects(
    suite.updateCalendarEvent(OWNER, "zoom", "1", { startsAt: "2026-12-02T16:00:00Z", endsAt: "2026-12-02T17:00:00Z" }, log()),
    (e: unknown) => e instanceof HttpError && e.statusCode === 404
  );
});

test("deleting a Zoom meeting skips the host email, and a meeting already gone (404) is success", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.method === "DELETE" && c.url.includes("/v2/meetings/10") ? noContent() : undefined));
  handlers.push((c) => (c.method === "DELETE" && c.url.includes("/v2/meetings/11") ? json({ code: 3001, message: "Meeting does not exist: 11." }, 404) : undefined));
  handlers.push((c) => (c.method === "DELETE" && c.url.includes("/v2/meetings/12") ? json({ code: 1, message: "boom" }, 500) : undefined));
  await suite.deleteCalendarEvent(OWNER, "zoom", "10", log());
  await suite.deleteCalendarEvent(OWNER, "zoom", "11", log());
  assert.ok(zoomCalls("DELETE", "/v2/meetings/10")[0]!.url.endsWith("?schedule_for_reminder=false"));
  await assert.rejects(suite.deleteCalendarEvent(OWNER, "zoom", "12", log()), (e: unknown) => e instanceof HttpError && e.statusCode === 503);
});

test("a Zoom meeting id is path-encoded", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.method === "DELETE" ? noContent() : undefined));
  await suite.deleteCalendarEvent(OWNER, "zoom", "../users/me", log());
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.startsWith("https://api.zoom.us/v2/meetings/..%2Fusers%2Fme")));
});

// ---- 5. Disconnect ----------------------------------------------------------------------

test("disconnecting Zoom revokes at Zoom with Basic auth, then forgets the tokens", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.url === "https://zoom.us/oauth/revoke" ? json({ status: "success" }) : undefined));
  const out = await oauth.revokeAndForget(OWNER, "zoom", log());
  assert.equal(out.revokedAtProvider, true);
  const req = calls.find((c) => c.url === "https://zoom.us/oauth/revoke")!;
  assert.equal(req.headers.authorization, BASIC);
  assert.equal(new URLSearchParams(req.body!).get("token"), "AT-live");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("/rest/v1/integration_tokens")), "the stored tokens are deleted");
});

test("a Zoom revoke that fails is logged, reported false, and the tokens are still deleted", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.url === "https://zoom.us/oauth/revoke" ? json({ reason: "nope" }, 400) : undefined));
  const out = await oauth.revokeAndForget(OWNER, "zoom", log());
  assert.equal(out.revokedAtProvider, false);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("/rest/v1/integration_tokens")));
});

// ---- 6. The same calls never reach the Microsoft path ------------------------------------------

test("no Zoom call goes to Graph or Google", async () => {
  handlers.push(postgrest(() => tokenRow()));
  handlers.push((c) => (c.url.includes("api.zoom.us") && c.method === "POST" ? json({ id: 1, join_url: "https://us05web.zoom.us/j/1" }, 201) : undefined));
  handlers.push((c) => (c.url.includes("api.zoom.us") ? noContent() : undefined));
  await suite.createConferenceEvent(OWNER, "zoom", input, log());
  await suite.updateCalendarEvent(OWNER, "zoom", "1", { title: "x" }, log());
  await suite.deleteCalendarEvent(OWNER, "zoom", "1", log());
  assert.ok(calls.filter((c) => !c.url.includes("/rest/v1/")).every((c) => c.url.startsWith("https://api.zoom.us/") || c.url.startsWith("https://zoom.us/")));
});

// ---- 7. GET /integrations/providers carries a Zoom entry in the suites' shape ----------------------

async function providers(rows: Record<string, unknown>[]) {
  handlers = [];
  handlers.push((c) => (c.url.includes("/rest/v1/integration_tokens") && c.method === "GET" ? json(rows) : undefined));
  const app = Fastify();
  app.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    request.auth = { userId: OWNER, token: "t" };
  });
  app.register(integrationRoutes, { prefix: "/integrations" });
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/integrations/providers" });
  await app.close();
  assert.equal(res.statusCode, 200);
  return res.json() as Array<Record<string, unknown>>;
}

test("/integrations/providers lists Zoom beside Google and Microsoft with the same fields", async () => {
  const list = await providers([tokenRow({ created_at: "2026-11-18T10:00:00Z" })]);
  assert.deepEqual(list.map((p) => p.provider), ["google", "microsoft", "zoom"]);
  const zoom = list.find((p) => p.provider === "zoom")!;
  assert.deepEqual(zoom, {
    provider: "zoom",
    available: true,
    unavailableReason: null,
    tokensHeld: true,
    accountEmail: "counselor@school.org",
    connectedAt: "2026-11-18T10:00:00Z",
    calendarEnabled: true, // for Zoom: the meeting-create scope was granted ("can create a Zoom link")
    driveGranted: false,
    pickerReady: false,
    maxFiles: 0,
  });
  const google = list.find((p) => p.provider === "google")!;
  assert.deepEqual(Object.keys(google).sort(), Object.keys(zoom).sort(), "the same keys for every provider");
});

test("Zoom's calendarEnabled needs the create scope; a Zoom row never lights up the Google or Microsoft entries", async () => {
  const list = await providers([tokenRow({ scopes: ["meeting:update:meeting", "meeting:delete:meeting", "user:read:user"] })]);
  assert.equal(list.find((p) => p.provider === "zoom")!.calendarEnabled, false);
  assert.equal(list.find((p) => p.provider === "google")!.tokensHeld, false);
  assert.equal(list.find((p) => p.provider === "microsoft")!.calendarEnabled, false);
  const none = await providers([]);
  const zoom = none.find((p) => p.provider === "zoom")!;
  assert.equal(zoom.tokensHeld, false);
  assert.equal(zoom.calendarEnabled, false);
  assert.equal(zoom.accountEmail, null);
});
