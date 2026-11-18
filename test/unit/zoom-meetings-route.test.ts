// /meetings with mode "zoom": the Zoom meeting is created before the row is saved (and rolled back when the save
// fails), a pasted link needs no connection, and a move, a cancel and a delete follow the Zoom meeting. The routes
// run on Fastify with a fake request database; Zoom and the token store are answered by a fetch stub.
process.env.ZOOM_CLIENT_ID = "zoom-client-id-0000";
process.env.ZOOM_CLIENT_SECRET = "zoom-client-secret-0000";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";
process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const { HttpError } = await import("../../src/lib/errors.js");
const { encryptToken } = await import("../../src/lib/tokenCrypto.js");
const { default: meetingRoutes } = await import("../../src/routes/meetings.js");

type Row = Record<string, unknown>;
const OWNER = "00000000-0000-4000-8000-000000000001";
const STUDENT = "00000000-0000-4000-8000-000000000002";
const MID = "00000000-0000-4000-8000-0000000000aa";
const ZOOM_URL = "https://us05web.zoom.us/j/81234567890?pwd=abc";

// ---- fetch stub ------------------------------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
let calls: Call[] = [];
let connected = true;
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const tokenRow = () => ({
  owner_id: OWNER,
  provider: "zoom",
  account_id: "zoom-user-1",
  account_email: "counselor@school.org",
  access_token_enc: encryptToken("AT-live"),
  refresh_token_enc: encryptToken("RT-1"),
  scopes: ["meeting:write:meeting", "meeting:update:meeting", "meeting:delete:meeting"],
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});

beforeEach(() => {
  calls = [];
  connected = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers, body: typeof init?.body === "string" ? init.body : null });
    if (url.includes("/rest/v1/integration_tokens") && method === "GET") {
      const object = (headers["accept"] ?? "").includes("pgrst.object");
      return connected ? (object ? json(tokenRow()) : json([tokenRow()])) : object ? json({}, 406) : json([]);
    }
    if (url === "https://api.zoom.us/v2/users/me/meetings") return json({ id: 81234567890, join_url: ZOOM_URL }, 201);
    if (url.startsWith("https://api.zoom.us/v2/meetings/")) return new Response(null, { status: 204 });
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const zoomCalls = () => calls.filter((c) => c.url.includes("zoom.us"));
const nonZoomProviderCalls = () => calls.filter((c) => /graph\.microsoft|googleapis/.test(c.url));

// ---- fake request database -------------------------------------------------------------------------

type State = { existing: Row | null; insertError: boolean; inserted: Row[]; updated: Row[]; deleted: number };

function fakeDb(state: State) {
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    const has = (name: string) => ops.find(([n]) => n === name);
    const done = (): { data: unknown; error: unknown } => {
      if (table === "profiles") return { data: { id: STUDENT, counselor_id: OWNER }, error: null };
      if (table === "meeting_attendees") return { data: [], error: null };
      if (table !== "meetings") throw new Error(`unexpected table ${table}`);
      const insert = has("insert");
      if (insert) {
        if (state.insertError) return { data: null, error: { code: "23514", message: "refused" } };
        const row = { id: MID, status: "scheduled", created_at: "2026-11-18T00:00:00Z", ...(insert[1][0] as Row) };
        state.inserted.push(row);
        return { data: row, error: null };
      }
      const update = has("update");
      if (update) {
        state.updated.push(update[1][0] as Row);
        return { data: { ...state.existing, ...(update[1][0] as Row) }, error: null };
      }
      if (has("delete")) {
        state.deleted += 1;
        return { data: null, error: null };
      }
      // The invite-columns probe: older than 20261023090001, so no invite columns are named.
      if (String(ops[0]?.[1][0] ?? "").includes("send_invites")) return { data: null, error: { code: "42703", message: "no column" } };
      return { data: state.existing, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve().then(done).then(ok, bad);
        return (...args: unknown[]) => (ops.push([String(prop), args]), p);
      },
    });
    return p;
  };
  return { from } as unknown as FastifyRequest["db"];
}

async function build(state: State) {
  const app = Fastify();
  app.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    request.auth = { userId: OWNER, token: "t" };
    request.profile = { id: OWNER, role: "counselor", timezone: "UTC" } as unknown as FastifyRequest["profile"];
    request.db = fakeDb(state);
  });
  app.setErrorHandler((err: Error, _request, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    return reply.code(500).send({ error: String(err) });
  });
  app.register(meetingRoutes, { prefix: "/meetings" });
  await app.ready();
  return app;
}

const fresh = (over: Partial<State> = {}): State => ({ existing: null, insertError: false, inserted: [], updated: [], deleted: 0, ...over });
const body = { studentId: STUDENT, title: "Essay check-in", mode: "zoom", startsAt: "2026-12-01T15:00:00Z", endsAt: "2026-12-01T15:45:00Z" };
const zoomRow = (over: Row = {}): Row => ({
  id: MID,
  student_id: STUDENT,
  counselor_id: OWNER,
  title: "Essay check-in",
  mode: "zoom",
  status: "scheduled",
  join_url: ZOOM_URL,
  calendar_provider: "zoom",
  calendar_event_id: "81234567890",
  starts_at: "2026-12-01T15:00:00Z",
  ends_at: "2026-12-01T15:45:00Z",
  agenda: null,
  ...over,
});

// ---- create -----------------------------------------------------------------------------------------

test("POST /meetings mode zoom + createConference creates the Zoom meeting, saves its link and answers calendarProvider zoom", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await app.inject({ method: "POST", url: "/meetings", payload: { ...body, createConference: true, agenda: "Bring drafts" } });
  assert.equal(res.statusCode, 201, res.body);
  const out = res.json();
  assert.equal(out.mode, "zoom");
  assert.equal(out.joinUrl, ZOOM_URL);
  assert.equal(out.calendarProvider, "zoom");
  assert.equal(out.htmlLink, null, "no Google event page for a Zoom meeting");
  assert.equal(state.inserted[0]!.calendar_event_id, "81234567890");
  assert.equal(state.inserted[0]!.calendar_provider, "zoom");
  const create = zoomCalls().find((c) => c.method === "POST")!;
  assert.deepEqual(JSON.parse(create.body!), { topic: "Essay check-in", type: 2, start_time: "2026-12-01T15:00:00Z", duration: 45, timezone: "UTC", agenda: "Bring drafts" });
  assert.equal(nonZoomProviderCalls().length, 0);
  await app.close();
});

test("a Zoom meeting whose row can't be saved is deleted from Zoom again", async () => {
  const state = fresh({ insertError: true });
  const app = await build(state);
  const res = await app.inject({ method: "POST", url: "/meetings", payload: { ...body, createConference: true } });
  assert.ok(res.statusCode >= 400);
  assert.ok(zoomCalls().some((c) => c.method === "DELETE" && c.url.startsWith("https://api.zoom.us/v2/meetings/81234567890")), "rolled back");
  await app.close();
});

test("createConference with no Zoom connected answers zoom_disconnected and saves nothing", async () => {
  connected = false;
  const state = fresh();
  const app = await build(state);
  const res = await app.inject({ method: "POST", url: "/meetings", payload: { ...body, createConference: true } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "zoom_disconnected");
  assert.equal(state.inserted.length, 0);
  await app.close();
});

test("a pasted link with mode zoom needs no Zoom connection and calls nothing", async () => {
  connected = false;
  const state = fresh();
  const app = await build(state);
  const res = await app.inject({ method: "POST", url: "/meetings", payload: { ...body, joinUrl: "https://zoom.us/j/99887766554" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().joinUrl, "https://zoom.us/j/99887766554");
  assert.equal(res.json().calendarProvider, null);
  assert.equal(calls.filter((c) => !c.url.includes("127.0.0.1")).length, 0, "no provider call");
  await app.close();
});

test("createConference is refused for modes that make no link, naming Zoom among them", async () => {
  const app = await build(fresh());
  const res = await app.inject({ method: "POST", url: "/meetings", payload: { ...body, mode: "phone", createConference: true } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /Zoom/);
  await app.close();
});

// ---- change -----------------------------------------------------------------------------------------

test("PATCH of a Zoom meeting's start carries the stored end, so Zoom gets a start and its length", async () => {
  const state = fresh({ existing: zoomRow() });
  const app = await build(state);
  const res = await app.inject({ method: "PATCH", url: `/meetings/${MID}`, payload: { startsAt: "2026-12-02T16:00:00Z" } });
  assert.equal(res.statusCode, 200, res.body);
  const patch = zoomCalls().find((c) => c.method === "PATCH")!;
  assert.ok(patch.url.startsWith("https://api.zoom.us/v2/meetings/81234567890"));
  assert.deepEqual(JSON.parse(patch.body!), { start_time: "2026-12-02T16:00:00Z", timezone: "UTC", duration: 45 });
  assert.ok(!("join_url" in state.updated[0]!), "a calendar-backed meeting's link belongs to the calendar");
  await app.close();
});

test("PATCH of a Zoom meeting's end carries the stored start", async () => {
  const state = fresh({ existing: zoomRow() });
  const app = await build(state);
  const res = await app.inject({ method: "PATCH", url: `/meetings/${MID}`, payload: { endsAt: "2026-12-01T16:30:00Z" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(JSON.parse(zoomCalls().find((c) => c.method === "PATCH")!.body!), { start_time: "2026-12-01T15:00:00Z", timezone: "UTC", duration: 90 });
  await app.close();
});

test("cancelling a Zoom meeting deletes it at Zoom and clears the pointer", async () => {
  const state = fresh({ existing: zoomRow() });
  const app = await build(state);
  const res = await app.inject({ method: "PATCH", url: `/meetings/${MID}`, payload: { status: "cancelled" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(zoomCalls().some((c) => c.method === "DELETE" && c.url.startsWith("https://api.zoom.us/v2/meetings/81234567890")));
  assert.equal(state.updated[0]!.calendar_provider, null);
  assert.equal(state.updated[0]!.calendar_event_id, null);
  await app.close();
});

test("changing a Zoom meeting to in person removes the Zoom meeting and its link", async () => {
  const state = fresh({ existing: zoomRow() });
  const app = await build(state);
  const res = await app.inject({ method: "PATCH", url: `/meetings/${MID}`, payload: { mode: "in-person" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(zoomCalls().some((c) => c.method === "DELETE"));
  assert.equal(state.updated[0]!.join_url, null);
  await app.close();
});

test("deleting a Zoom meeting deletes it at Zoom, even when Zoom is no longer connected", async () => {
  const state = fresh({ existing: zoomRow() });
  const app = await build(state);
  let res = await app.inject({ method: "DELETE", url: `/meetings/${MID}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(zoomCalls().some((c) => c.method === "DELETE"));
  assert.equal(state.deleted, 1);

  connected = false;
  calls = [];
  res = await app.inject({ method: "DELETE", url: `/meetings/${MID}` });
  assert.equal(res.statusCode, 200, "best effort: the meeting still goes");
  assert.equal(zoomCalls().length, 0);
  assert.equal(state.deleted, 2);
  await app.close();
});

test("someone else's Zoom meeting is never called with the caller's token: changed in Meridies only", async () => {
  const state = fresh({ existing: zoomRow({ counselor_id: "00000000-0000-4000-8000-0000000000ee" }) });
  const app = await build(state);
  const res = await app.inject({ method: "PATCH", url: `/meetings/${MID}`, payload: { startsAt: "2026-12-02T16:00:00Z" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(zoomCalls().length, 0);
  await app.close();
});
