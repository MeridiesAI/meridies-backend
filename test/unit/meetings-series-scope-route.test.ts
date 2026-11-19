// PATCH /meetings/series/:seriesId and DELETE /meetings/series/:seriesId: a scoped change to a repeating series.
// Per row and not atomic: each affected row goes through applyMeetingPatch ("defer") or is deleted on its own, a row
// that fails is reported and left alone, and ONE series invite round covers the rows that changed. Fastify + an
// in-memory meetings table; Zoom, the token store and the rate limiter are answered by a fetch stub, so nothing real
// is called or emailed. Rows are far in the future (2040) so `starts_at > now` holds whenever this runs.
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
const routes = await import("../../src/routes/meetings.js");
const meetingRoutes = routes.default;
const seam = routes.__seriesInvites;
const realSeam = { ...seam };

type Row = Record<string, unknown>;
const OWNER = "00000000-0000-4000-8000-000000000001";
const STUDENT = "00000000-0000-4000-8000-000000000002";
const FOREIGN = "00000000-0000-4000-8000-000000000004";
const SERIES = "00000000-0000-4000-8000-00000000c0de";
const OTHER_SERIES = "00000000-0000-4000-8000-00000000beef";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---- fetch stub ----------------------------------------------------------------------------------------

type Call = { url: string; method: string; body: string | null };
let calls: Call[] = [];
let zoomRefuse = new Set<string>(); // Zoom event ids whose move answers 409
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

type PrepareInput = { kind: string; before: Array<Row>; after: Array<Row>; attendeeIds: string[]; notify: boolean };
let prepared: PrepareInput[] = [];
let started: unknown[] = [];

beforeEach(() => {
  calls = [];
  zoomRefuse = new Set();
  prepared = [];
  started = [];
  resetSeriesReady();
  resetInvitesReady();
  // The real round is prepared (so its charge is visible); delivery is recorded, never run.
  seam.prepare = (async (request: never, input: never, deps?: never) => {
    prepared.push(structuredClone(input) as PrepareInput);
    return realSeam.prepare(request, input, deps);
  }) as typeof seam.prepare;
  seam.start = ((round: unknown) => void started.push(round)) as typeof seam.start;
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
    if (url.startsWith("https://api.zoom.us/v2/meetings/")) {
      const eventId = url.split("/").pop()!.split("?")[0]!;
      if (method === "PATCH" && zoomRefuse.has(eventId)) return json({ code: 3001, message: "Meeting is locked" }, 409);
      return new Response(null, { status: 204 });
    }
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(seam, realSeam);
});
const charges = (prefix: string) =>
  calls.filter((c) => c.url.includes("rpc/consume_rate_limit") && String(JSON.parse(c.body ?? "{}").p_key).startsWith(prefix));
const zoomMoves = () => calls.filter((c) => c.method === "PATCH" && c.url.startsWith("https://api.zoom.us/v2/meetings/"));

// ---- in-memory meetings table ---------------------------------------------------------------------------

type State = {
  seriesColumn: boolean;
  inviteColumns: boolean;
  rows: Row[];
  updates: Array<{ id: string; values: Row }>;
  deletes: string[];
  deleteFails: Set<string>;
  updateFails: Set<string>;
  attendeeReads: number;
};

const row = (n: number, startsAt: string, over: Row = {}): Row => ({
  id: id(n),
  series_id: SERIES,
  student_id: STUDENT,
  counselor_id: OWNER,
  title: "Weekly check-in",
  mode: "in-person",
  status: "scheduled",
  join_url: null,
  calendar_provider: null,
  calendar_event_id: null,
  starts_at: startsAt,
  ends_at: new Date(Date.parse(startsAt) + 45 * 60_000).toISOString(),
  agenda: null,
  location: null,
  guardians_invited: false,
  send_invites: false,
  ics_sequence: 0,
  ...over,
});

function fakeDb(s: State) {
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    const all = (name: string) => ops.filter(([n]) => n === name);
    const op = (name: string) => ops.find(([n]) => n === name);
    const done = (): { data: unknown; error: unknown } => {
      const select = String(op("select")?.[1][0] ?? "");
      if (table === "profiles") {
        const profile = (pid: string) => ({ id: pid, full_name: pid === OWNER ? "Coach" : "Ana", email: `${pid.slice(-2)}@school.org`, archived_at: null, counselor_id: pid === FOREIGN ? id(999) : OWNER });
        const inOp = op("in");
        if (inOp) return { data: (inOp[1][1] as string[]).map(profile), error: null };
        return { data: profile(String(op("eq")?.[1][1])), error: null };
      }
      if (table === "meeting_attendees") {
        if (select === "student_id") s.attendeeReads += 1;
        return { data: [], error: null };
      }
      if (table !== "meetings") return { data: [], error: null };
      if (op("limit")?.[1][0] === 0) {
        const ok = select.includes("series_id") ? s.seriesColumn : s.inviteColumns;
        return ok ? { data: [], error: null } : { data: null, error: { code: "42703", message: "no column" } };
      }
      const eqs = all("eq").map(([, a]) => a as [string, unknown]);
      const match = (r: Row) =>
        eqs.every(([k, v]) => r[k] === v) &&
        all("gte").every(([, [k, v]]) => Date.parse(String(r[k as string])) >= Date.parse(String(v))) &&
        all("gt").every(([, [k, v]]) => Date.parse(String(r[k as string])) > Date.parse(String(v)));
      if (op("update")) {
        const target = s.rows.find(match)!;
        if (s.updateFails.has(String(target.id))) return { data: null, error: { code: "XX000", message: "The row couldn't be saved" } };
        const values = op("update")![1][0] as Row;
        s.updates.push({ id: String(target.id), values });
        Object.assign(target, values);
        return { data: { ...target }, error: null };
      }
      if (op("delete")) {
        const target = s.rows.find(match)!;
        if (s.deleteFails.has(String(target.id))) return { data: null, error: { code: "XX000", message: "The row couldn't be deleted" } };
        s.deletes.push(String(target.id));
        s.rows = s.rows.filter((r) => r !== target);
        return { data: null, error: null };
      }
      const found = s.rows.filter(match).sort((a, b) => Date.parse(String(a.starts_at)) - Date.parse(String(b.starts_at)));
      if (op("maybeSingle")) return { data: found[0] ? { ...found[0] } : null, error: null };
      return { data: found.map((r) => ({ ...r })), error: null };
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

const fresh = (rows: Row[], over: Partial<State> = {}): State => ({
  seriesColumn: true,
  inviteColumns: true,
  rows,
  updates: [],
  deletes: [],
  deleteFails: new Set(),
  updateFails: new Set(),
  attendeeReads: 0,
  ...over,
});
// Weekly, 9:00 New York, January 2040 (EST: 14:00Z); far enough ahead that `starts_at > now` always holds.
const weekly = (count: number, over: (n: number) => Row = () => ({})) =>
  Array.from({ length: count }, (_, i) => row(i + 1, new Date(Date.UTC(2040, 0, 5 + 7 * i, 14)).toISOString(), over(i + 1)));
const TZ = "America/New_York";
type App = Awaited<ReturnType<typeof build>>;
const patchSeries = (app: App, payload: unknown, series = SERIES) =>
  app.inject({ method: "PATCH", url: `/meetings/series/${series}`, payload: payload as object });
const deleteSeries = (app: App, query: string, series = SERIES) => app.inject({ method: "DELETE", url: `/meetings/series/${series}?${query}` });
const plusDay = (iso: string) => new Date(Date.parse(iso) + 86_400_000).toISOString();

// ---- PATCH ------------------------------------------------------------------------------------------------

test("following from the 3rd of 4 changes only rows 3 and 4", async () => {
  const state = fresh(weekly(4));
  const before = state.rows.map((r) => ({ ...r }));
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(3), scope: "following", timeZone: TZ, patch: { title: "Moved", startsAt: plusDay(String(before[2]!.starts_at)) } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { updated: 2, skipped: 0, failed: [], invites: { status: "none" } });
  assert.deepEqual(state.updates.map((u) => u.id), [id(3), id(4)]);
  assert.deepEqual(state.rows.slice(0, 2), before.slice(0, 2), "rows 1-2 untouched");
  for (const i of [2, 3]) {
    assert.equal(state.rows[i]!.title, "Moved");
    assert.equal(state.rows[i]!.starts_at, plusDay(String(before[i]!.starts_at)));
    assert.equal(state.rows[i]!.ends_at, plusDay(String(before[i]!.ends_at)), "keeps its own length");
  }
  await app.close();
});

test("all skips a held row (skipped: 1) and never touches a past row", async () => {
  const rows = weekly(4, (n) => (n === 2 ? { status: "held" } : {}));
  rows.unshift(row(9, "2020-01-07T14:00:00.000Z")); // a past occurrence of the same series
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { location: "Room 4" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().updated, 3);
  assert.equal(res.json().skipped, 1);
  assert.deepEqual(state.updates.map((u) => u.id), [id(1), id(3), id(4)]);
  assert.deepEqual(state.updates[0]!.values, { location: "Room 4" }, "only the keys the caller sent");
  await app.close();
});

test("following counts a non-scheduled row in the window as skipped, and rows of another series or student are never read", async () => {
  const rows = [...weekly(4, (n) => (n === 4 ? { status: "cancelled" } : {})), row(20, "2040-02-02T14:00:00.000Z", { series_id: OTHER_SERIES }), row(21, "2040-02-09T14:00:00.000Z", { student_id: FOREIGN })];
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(2), scope: "following", timeZone: TZ, patch: { agenda: "Bring drafts" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([res.json().updated, res.json().skipped], [2, 1]);
  assert.deepEqual(state.updates.map((u) => u.id), [id(2), id(3)]);
  await app.close();
});

test("a row nudged +30 min earlier keeps its own offset after a +1 day move", async () => {
  const rows = weekly(3, (n) => (n === 2 ? { starts_at: "2040-01-12T14:30:00.000Z", ends_at: "2040-01-12T15:15:00.000Z" } : {}));
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { startsAt: "2040-01-06T14:00:00.000Z" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    state.rows.map((r) => [r.starts_at, r.ends_at]),
    [
      ["2040-01-06T14:00:00.000Z", "2040-01-06T14:45:00.000Z"],
      ["2040-01-13T14:30:00.000Z", "2040-01-13T15:15:00.000Z"],
      ["2040-01-20T14:00:00.000Z", "2040-01-20T14:45:00.000Z"],
    ]
  );
  await app.close();
});

test("a move across the DST end keeps the local wall clock (America/New_York, Nov 4 2040)", async () => {
  // Tuesdays 9:00 local: EDT (13:00Z) before Nov 4, EST (14:00Z) after. Move all to 10:00 local.
  const rows = ["2040-10-23T13:00:00.000Z", "2040-10-30T13:00:00.000Z", "2040-11-06T14:00:00.000Z", "2040-11-13T14:00:00.000Z"].map((t, i) => row(i + 1, t));
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { startsAt: "2040-10-23T14:00:00.000Z" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(state.rows.map((r) => r.starts_at), ["2040-10-23T14:00:00.000Z", "2040-10-30T14:00:00.000Z", "2040-11-06T15:00:00.000Z", "2040-11-13T15:00:00.000Z"]);
  assert.deepEqual(state.rows.map((r) => r.ends_at), ["2040-10-23T14:45:00.000Z", "2040-10-30T14:45:00.000Z", "2040-11-06T15:45:00.000Z", "2040-11-13T15:45:00.000Z"]);
  await app.close();
});

test("a provider 409 on row 2: one failed entry with its local date and message, the others updated, ONE invite round", async () => {
  const rows = weekly(3, (n) => ({ mode: "zoom", calendar_provider: "zoom", calendar_event_id: `81200${n}`, send_invites: true }));
  zoomRefuse.add("812002");
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { title: "New title" } });
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.equal(out.updated, 2);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].id, id(2));
  assert.equal(out.failed[0].date, "2040-01-12");
  assert.match(out.failed[0].message, /Zoom/, "the provider's words, not a database error");
  assert.equal(state.rows[1]!.title, "Weekly check-in", "the failed row is untouched");
  assert.deepEqual([state.rows[0]!.title, state.rows[2]!.title], ["New title", "New title"]);
  assert.equal(zoomMoves().length, 3);
  assert.equal(prepared.length, 1, "one round");
  assert.equal(prepared[0]!.kind, "update");
  assert.deepEqual(prepared[0]!.before.map((b) => b.id), [id(1), id(3)]);
  assert.deepEqual(prepared[0]!.before.map((b) => b.title), ["Weekly check-in", "Weekly check-in"]);
  assert.deepEqual(prepared[0]!.after.map((a) => a.title), ["New title", "New title"]);
  assert.equal(prepared[0]!.notify, true);
  assert.equal(charges("meeting-invites:").length, 1, "the hourly allowance is charged once");
  assert.equal(out.invites.status, "sending");
  assert.equal(started.length, 1);
  assert.equal(state.attendeeReads, 1, "who holds the invite is read once for the series");
  await app.close();
});

test("rows go through applyMeetingPatch deferred: no per-row round or charge, only the series round", async () => {
  const state = fresh(weekly(4, () => ({ send_invites: true })));
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { agenda: "New agenda" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().updated, 4);
  assert.equal(charges("meeting-invites:").length, 1);
  assert.equal(prepared.length, 1);
  assert.equal(started.length, 1);
  assert.ok(!calls.some((c) => c.url.includes("/rest/v1/message_deliveries")), "nothing delivered per row");
  await app.close();
});

test("notifyAttendees false: invites none, no round prepared, nothing charged", async () => {
  const state = fresh(weekly(3, () => ({ send_invites: true })));
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, notifyAttendees: false, patch: { title: "Quiet" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().updated, 3);
  assert.deepEqual(res.json().invites, { status: "none" });
  assert.equal(prepared.length, 0);
  assert.equal(started.length, 0);
  assert.equal(charges("meeting-invites:").length, 0);
  await app.close();
});

test("mode, attendeeIds, status or sendInvites inside patch is a 400 and changes nothing", async () => {
  const app = await build(fresh(weekly(2)));
  for (const extra of [{ mode: "zoom" }, { attendeeIds: [FOREIGN] }, { status: "cancelled" }, { sendInvites: true }, { joinUrl: "https://x.org" }]) {
    const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { title: "x", ...extra } });
    assert.equal(res.statusCode, 400, `${JSON.stringify(extra)}: ${res.body}`);
  }
  await app.close();
});

test("a resize (endsAt only) sets each row's duration from its own start", async () => {
  const rows = weekly(3, (n) => (n === 2 ? { starts_at: "2040-01-12T14:30:00.000Z", ends_at: "2040-01-12T15:00:00.000Z" } : {}));
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { endsAt: "2040-01-05T15:30:00.000Z" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    state.rows.map((r) => [r.starts_at, r.ends_at]),
    [
      ["2040-01-05T14:00:00.000Z", "2040-01-05T15:30:00.000Z"],
      ["2040-01-12T14:30:00.000Z", "2040-01-12T16:00:00.000Z"],
      ["2040-01-19T14:00:00.000Z", "2040-01-19T15:30:00.000Z"],
    ]
  );
  assert.deepEqual(Object.keys(state.updates[0]!.values), ["ends_at"], "the start is not sent");
  await app.close();
});

test("an end at or before the start is a 400", async () => {
  const state = fresh(weekly(2));
  const app = await build(state);
  let res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { endsAt: "2040-01-05T14:00:00.000Z" } });
  assert.equal(res.statusCode, 400, res.body);
  res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { startsAt: "2040-01-05T16:00:00.000Z", endsAt: "2040-01-05T15:00:00.000Z" } });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(state.updates.length, 0);
  await app.close();
});

test("an anchor that isn't part of the series is a 404", async () => {
  const state = fresh([...weekly(2), row(30, "2040-01-05T14:00:00.000Z", { series_id: OTHER_SERIES })]);
  const app = await build(state);
  let res = await patchSeries(app, { anchorId: id(30), scope: "all", timeZone: TZ, patch: { title: "x" } });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error, "That meeting isn't part of this repeating series");
  res = await deleteSeries(app, `anchorId=${id(30)}&scope=all`);
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(state.updates.length + state.deletes.length, 0);
  await app.close();
});

test("an anchor whose student the caller can't edit is a 403", async () => {
  const state = fresh(weekly(2, () => ({ student_id: FOREIGN })));
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { title: "x" } });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(state.updates.length, 0);
  await app.close();
});

test("without the series_id column both routes answer 503 series_unavailable", async () => {
  const state = fresh(weekly(2), { seriesColumn: false });
  const app = await build(state);
  const expected = { error: "Repeating events aren't switched on yet.", code: "series_unavailable" };
  let res = await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { title: "x" } });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), expected);
  res = await deleteSeries(app, `anchorId=${id(1)}&scope=all`);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), expected);
  await app.close();
});

test("both routes are rate limited under their own names", async () => {
  const app = await build(fresh(weekly(2)));
  await patchSeries(app, { anchorId: id(1), scope: "all", timeZone: TZ, patch: { title: "x" } });
  await deleteSeries(app, `anchorId=${id(1)}&scope=all`);
  const limits = calls
    .filter((c) => c.url.includes("rpc/consume_rate_limit"))
    .map((c) => JSON.parse(c.body!) as { p_key: string; p_limit: number; p_window_seconds: number })
    .filter((b) => b.p_key.startsWith("meetings:"));
  assert.deepEqual(limits, [
    { p_key: `meetings:series-update:${OWNER}`, p_limit: 60, p_window_seconds: 60 },
    { p_key: `meetings:series-delete:${OWNER}`, p_limit: 60, p_window_seconds: 60 },
  ]);
  await app.close();
});

// ---- DELETE ---------------------------------------------------------------------------------------------

test("DELETE all removes upcoming scheduled rows only, with ONE cancel round from states captured before deletion", async () => {
  const rows = weekly(4, (n) => ({ send_invites: true, ...(n === 3 ? { status: "held" } : {}) }));
  rows.unshift(row(9, "2020-01-07T14:00:00.000Z", { send_invites: true }));
  const state = fresh(rows);
  const app = await build(state);
  const res = await deleteSeries(app, `anchorId=${id(2)}&scope=all`);
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.deepEqual([out.deleted, out.skipped, out.failed], [3, 1, []]);
  assert.deepEqual(state.deletes, [id(1), id(2), id(4)]);
  assert.deepEqual(state.rows.map((r) => r.id), [id(9), id(3)]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]!.kind, "cancel");
  assert.deepEqual(prepared[0]!.after, []);
  assert.equal(prepared[0]!.notify, true);
  assert.deepEqual(prepared[0]!.before.map((b) => [b.id, b.status, b.startsAt]), [
    [id(1), "scheduled", "2040-01-05T14:00:00.000Z"],
    [id(2), "scheduled", "2040-01-12T14:00:00.000Z"],
    [id(4), "scheduled", "2040-01-26T14:00:00.000Z"],
  ]);
  assert.equal(charges("meeting-invites:").length, 0, "a cancel is never charged");
  assert.equal(out.invites.status, "sending");
  assert.equal(started.length, 1);
  await app.close();
});

test("DELETE following from the 3rd of 12 leaves rows 1-2", async () => {
  const state = fresh(weekly(12));
  const app = await build(state);
  const res = await deleteSeries(app, `anchorId=${id(3)}&scope=following`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().deleted, 10);
  assert.deepEqual(state.rows.map((r) => r.id), [id(1), id(2)]);
  assert.deepEqual(res.json().invites, { status: "none" });
  assert.equal(prepared.length, 0, "no row held an invite: nothing to tell");
  await app.close();
});

test("DELETE: a row whose delete errors is in failed, not in deleted, and its state is left out of the round", async () => {
  const state = fresh(weekly(3, () => ({ send_invites: true })), { deleteFails: new Set([id(2)]) });
  const app = await build(state);
  const res = await deleteSeries(app, `anchorId=${id(1)}&scope=all&timeZone=${encodeURIComponent(TZ)}`);
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.equal(out.deleted, 2);
  assert.deepEqual(out.failed, [{ id: id(2), date: "2040-01-12", message: "Couldn't delete this meeting. Try again." }]);
  assert.deepEqual(state.rows.map((r) => r.id), [id(2)]);
  assert.deepEqual(prepared[0]!.before.map((b) => b.id), [id(1), id(3)]);
  await app.close();
});

test("DELETE with a bad scope or no anchor is a 400", async () => {
  const app = await build(fresh(weekly(2)));
  assert.equal((await deleteSeries(app, `anchorId=${id(1)}&scope=everything`)).statusCode, 400);
  assert.equal((await deleteSeries(app, `scope=all`)).statusCode, 400);
  await app.close();
});

// ---- the single-meeting routes are unchanged --------------------------------------------------------------

test("PATCH /meetings/:id and DELETE /meetings/:id on one occurrence still act on that meeting alone", async () => {
  const state = fresh(weekly(3));
  const app = await build(state);
  let res = await app.inject({ method: "PATCH", url: `/meetings/${id(2)}`, payload: { title: "Just this one" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(state.rows.map((r) => r.title), ["Weekly check-in", "Just this one", "Weekly check-in"]);
  res = await app.inject({ method: "DELETE", url: `/meetings/${id(3)}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { deleted: true, invites: { status: "none" } });
  assert.deepEqual(state.rows.map((r) => r.id), [id(1), id(2)]);
  assert.equal(prepared.length, 0, "no series round");
  await app.close();
});
