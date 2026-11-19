// POST /meetings/series: one request books a whole repeating series. Every occurrence keeps the same local wall
// clock, shares one series_id and is inserted in ONE insert; provider events come first, one at a time, and any
// failure after one exists deletes every event and row already made (all or nothing). One invite round for the
// whole series, only after everything is saved. Fastify + a fake request database; Zoom, the token store and the
// rate limiter are answered by a fetch stub, so nothing real is called or emailed.
process.env.ZOOM_CLIENT_ID = "zoom-client-id-0000";
process.env.ZOOM_CLIENT_SECRET = "zoom-client-secret-0000";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";
process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

const { HttpError } = await import("../../src/lib/errors.js");
const { encryptToken } = await import("../../src/lib/tokenCrypto.js");
const { resetSeriesReady } = await import("../../src/lib/seriesSchema.js");
const { resetInvitesReady } = await import("../../src/lib/meetingInvites.js");
const { default: meetingRoutes } = await import("../../src/routes/meetings.js");

type Row = Record<string, unknown>;
const OWNER = "00000000-0000-4000-8000-000000000001";
const STUDENT = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";

// ---- fetch stub: Zoom, the token store, the rate limiter, delivery records ----------------------------

type Call = { url: string; method: string; body: string | null };
let calls: Call[] = [];
let zoomFailOn = 0; // the nth Zoom create answers 500 (0: never)
let zoomCreates = 0;
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
  zoomFailOn = 0;
  zoomCreates = 0;
  resetSeriesReady();
  resetInvitesReady();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    if (url.includes("/rest/v1/integration_tokens") && method === "GET") {
      return (headers["accept"] ?? "").includes("pgrst.object") ? json(tokenRow()) : json([tokenRow()]);
    }
    if (url.includes("/rest/v1/rpc/consume_rate_limit")) return json(true);
    if (url.includes("/rest/v1/")) return json([], 201);
    if (url === "https://api.zoom.us/v2/users/me/meetings") {
      zoomCreates += 1;
      if (zoomCreates === zoomFailOn) return json({ message: "Zoom is down" }, 500);
      return json({ id: 81200000000 + zoomCreates, join_url: `https://us05web.zoom.us/j/${81200000000 + zoomCreates}` }, 201);
    }
    if (url.startsWith("https://api.zoom.us/v2/meetings/")) return new Response(null, { status: 204 });
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const zoomDeletes = () => calls.filter((c) => c.method === "DELETE" && c.url.startsWith("https://api.zoom.us/v2/meetings/"));
const inviteCharges = () =>
  calls.filter((c) => c.url.includes("rpc/consume_rate_limit") && String(JSON.parse(c.body ?? "{}").p_key).startsWith("meeting-invites:"));
const deliveryWrites = () => calls.filter((c) => c.url.includes("/rest/v1/message_deliveries"));

// ---- fake request database ---------------------------------------------------------------------------

type State = {
  seriesColumn: boolean;
  inviteColumns: boolean;
  insertError: boolean;
  attendeeError: boolean;
  rows: Row[]; // what the meetings table holds now
  inserts: number;
  seriesDeletes: string[];
  upserts: Row[][];
};

function fakeDb(state: State) {
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    const has = (name: string) => ops.find(([n]) => n === name);
    const done = (): { data: unknown; error: unknown } => {
      if (table === "profiles") {
        const profile = (id: string) => ({ id, full_name: id === OWNER ? "Coach" : "Ana", email: id === OWNER ? "coach@school.org" : "ana@example.org", archived_at: null, counselor_id: OWNER });
        const inOp = has("in");
        if (inOp) return { data: (inOp[1][1] as string[]).map(profile), error: null };
        return { data: profile(String(has("eq")?.[1][1] ?? STUDENT)), error: null };
      }
      if (table === "meeting_attendees") {
        const upsert = has("upsert");
        if (upsert) {
          if (state.attendeeError) return { data: null, error: { code: "XX000", message: "attendees refused" } };
          state.upserts.push(upsert[1][0] as Row[]);
        }
        return { data: [], error: null };
      }
      if (table === "student_collaborators" || table === "student_alert_prefs" || table === "guardians") return { data: [], error: null };
      if (table !== "meetings") throw new Error(`unexpected table ${table}`);
      const insert = has("insert");
      if (insert) {
        state.inserts += 1;
        if (state.insertError) return { data: null, error: { code: "23514", message: "refused" } };
        const rows = (insert[1][0] as Row[]).map((r, i) => ({
          id: `00000000-0000-4000-8000-${String(100 + state.rows.length + i).padStart(12, "0")}`,
          status: "scheduled",
          ics_sequence: 0,
          created_at: "2026-10-01T00:00:00Z",
          ...r,
        }));
        state.rows.push(...rows);
        return { data: rows, error: null };
      }
      if (has("delete")) {
        const eq = has("eq")!;
        assert.equal(eq[1][0], "series_id");
        state.seriesDeletes.push(String(eq[1][1]));
        state.rows = state.rows.filter((r) => r.series_id !== eq[1][1]);
        return { data: null, error: null };
      }
      const cols = String(ops[0]?.[1][0] ?? "");
      if (cols.includes("series_id")) return state.seriesColumn ? { data: [], error: null } : { data: null, error: { code: "42703", message: "no column" } };
      if (cols.includes("send_invites")) return state.inviteColumns ? { data: [], error: null } : { data: null, error: { code: "42703", message: "no column" } };
      throw new Error(`unexpected meetings read ${cols}`);
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
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", details: err.issues });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    return reply.code(500).send({ error: String(err) });
  });
  app.register(meetingRoutes, { prefix: "/meetings" });
  await app.ready();
  return app;
}

const fresh = (over: Partial<State> = {}): State => ({
  seriesColumn: true,
  inviteColumns: true,
  insertError: false,
  attendeeError: false,
  rows: [],
  inserts: 0,
  seriesDeletes: [],
  upserts: [],
  ...over,
});
// Tuesday Oct 20 2026, 9:00 for 45 minutes in New York; daylight saving ends Sunday Nov 1.
const body = {
  studentId: STUDENT,
  title: "Weekly check-in",
  mode: "in-person",
  date: "2026-10-20",
  startMinutes: 540,
  durationMins: 45,
  timeZone: "America/New_York",
  repeat: { preset: "weekly", count: 4 },
};
const post = (app: Awaited<ReturnType<typeof build>>, payload: unknown) => app.inject({ method: "POST", url: "/meetings/series", payload: payload as object });

// ---- tests --------------------------------------------------------------------------------------------

test("weekly x4 in person: 4 rows in one insert, one series_id, 9:00 New York kept across the DST change", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await post(app, body);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(state.inserts, 1, "one insert");
  assert.equal(state.rows.length, 4);
  const ids = new Set(state.rows.map((r) => r.series_id));
  assert.equal(ids.size, 1);
  assert.match(String([...ids][0]), /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    state.rows.map((r) => [r.starts_at, r.ends_at]),
    [
      ["2026-10-20T13:00:00.000Z", "2026-10-20T13:45:00.000Z"],
      ["2026-10-27T13:00:00.000Z", "2026-10-27T13:45:00.000Z"],
      ["2026-11-03T14:00:00.000Z", "2026-11-03T14:45:00.000Z"],
      ["2026-11-10T14:00:00.000Z", "2026-11-10T14:45:00.000Z"],
    ]
  );
  for (const r of state.rows) {
    assert.equal(r.student_id, STUDENT);
    assert.equal(r.counselor_id, OWNER);
    assert.equal(r.mode, "in-person");
    assert.equal(r.calendar_event_id, null);
  }
  assert.equal(zoomCreates, 0);
  await app.close();
});

test("the response is { seriesId, meetings, invites }", async () => {
  const app = await build(fresh());
  const res = await post(app, { ...body, attendeeIds: [OTHER] });
  assert.equal(res.statusCode, 201, res.body);
  const out = res.json();
  assert.deepEqual(Object.keys(out).sort(), ["invites", "meetings", "seriesId"]);
  assert.equal(out.meetings.length, 4);
  assert.deepEqual(out.invites, { status: "none" });
  assert.equal(out.meetings[0].startsAt, "2026-10-20T13:00:00.000Z");
  assert.ok(Array.isArray(out.meetings[0].attendeeIds));
  await app.close();
});

test("invitees are written in one upsert covering every row", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await post(app, { ...body, attendeeIds: [OTHER, STUDENT] });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(state.upserts.length, 1);
  assert.equal(state.upserts[0]!.length, 4);
  assert.ok(state.upserts[0]!.every((a) => a.student_id === OTHER));
  await app.close();
});

test("createConference with count 13 is a 400 in words, and nothing is made", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await post(app, { ...body, mode: "zoom", createConference: true, repeat: { preset: "weekly", count: 13 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "A series can have at most 12 meetings.");
  assert.equal(zoomCreates, 0);
  assert.equal(state.inserts, 0);
  await app.close();
});

test("createConference makes one Zoom meeting per occurrence and stores each on its own row", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await post(app, { ...body, mode: "zoom", createConference: true, repeat: { preset: "weekly", count: 3 } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(zoomCreates, 3);
  assert.deepEqual(state.rows.map((r) => r.calendar_event_id), ["81200000001", "81200000002", "81200000003"]);
  assert.ok(state.rows.every((r) => r.calendar_provider === "zoom"));
  assert.equal(state.rows[1]!.join_url, "https://us05web.zoom.us/j/81200000002");
  await app.close();
});

test("Zoom failing on the 3rd event: the 2 made are deleted, no row is left, the answer is Zoom's error, nobody is emailed", async () => {
  zoomFailOn = 3;
  const state = fresh();
  const app = await build(state);
  const res = await post(app, { ...body, mode: "zoom", createConference: true, sendInvites: true });
  assert.ok(res.statusCode >= 500 || res.statusCode === 409, res.body);
  assert.match(res.json().error, /Zoom/);
  assert.equal(zoomDeletes().length, 2);
  assert.deepEqual(zoomDeletes().map((c) => c.url.split("/").pop()?.split("?")[0]).sort(), ["81200000001", "81200000002"]);
  assert.equal(state.inserts, 0);
  assert.equal(state.rows.length, 0);
  assert.equal(inviteCharges().length, 0);
  assert.equal(deliveryWrites().length, 0);
  await app.close();
});

test("the insert failing deletes every Zoom meeting already made", async () => {
  const state = fresh({ insertError: true });
  const app = await build(state);
  const res = await post(app, { ...body, mode: "zoom", createConference: true });
  assert.ok(res.statusCode >= 400);
  assert.equal(zoomDeletes().length, 4);
  assert.equal(state.rows.length, 0);
  await app.close();
});

test("an attendee upsert error deletes every row and every provider event", async () => {
  const state = fresh({ attendeeError: true });
  const app = await build(state);
  const res = await post(app, { ...body, mode: "zoom", createConference: true, attendeeIds: [OTHER], sendInvites: true });
  assert.equal(res.statusCode, 500, res.body);
  assert.equal(state.inserts, 1);
  assert.equal(state.seriesDeletes.length, 1);
  assert.equal(state.rows.length, 0, "every row deleted");
  assert.equal(zoomDeletes().length, 4, "every Zoom meeting deleted");
  assert.equal(inviteCharges().length, 0, "nothing emailed");
  assert.equal(deliveryWrites().length, 0);
  await app.close();
});

test("without the series_id column: 503 series_unavailable, nothing made", async () => {
  const state = fresh({ seriesColumn: false });
  const app = await build(state);
  const res = await post(app, body);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "Repeating events aren't switched on yet.", code: "series_unavailable" });
  assert.equal(state.inserts, 0);
  await app.close();
});

test("an unknown time zone is a 400, not a 500", async () => {
  const app = await build(fresh());
  const res = await post(app, { ...body, timeZone: "Mars/Olympus_Mons" });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /time zone/);
  await app.close();
});

test("both count and until is a 400; neither is a 400", async () => {
  const app = await build(fresh());
  let res = await post(app, { ...body, repeat: { preset: "weekly", count: 4, until: "2026-12-01" } });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /Give a count or an end date/);
  res = await post(app, { ...body, repeat: { preset: "weekly" } });
  assert.equal(res.statusCode, 400, res.body);
  await app.close();
});

test("until past 366 days is a 400 in words", async () => {
  const app = await build(fresh());
  const res = await post(app, { ...body, repeat: { preset: "monthly", until: "2027-12-01" } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "A series can run for at most 366 days.");
  await app.close();
});

test("sendInvites with invites ready: ONE invite round for all 4 rows (one charge), summary says sending", async () => {
  const state = fresh();
  const app = await build(state);
  // Ahead of now: a round tells only about occurrences still to come.
  const res = await post(app, { ...body, date: "2030-03-05", sendInvites: true });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(state.rows.every((r) => r.send_invites === true));
  assert.equal(inviteCharges().length, 1);
  assert.equal(JSON.parse(inviteCharges()[0]!.body!).p_key, `meeting-invites:${OWNER}`);
  assert.equal(res.json().invites.status, "sending");
  await app.close();
});

test("sendInvites before the invite columns exist answers unavailable and charges nothing", async () => {
  const state = fresh({ inviteColumns: false });
  const app = await build(state);
  const res = await post(app, { ...body, sendInvites: true });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().invites.status, "unavailable");
  assert.ok(state.rows.every((r) => !("send_invites" in r)));
  assert.equal(inviteCharges().length, 0);
  await app.close();
});
