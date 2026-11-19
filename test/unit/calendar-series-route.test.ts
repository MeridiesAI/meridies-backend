// POST /calendar/events/series, PATCH and DELETE /calendar/events/series/:seriesId: a repeating practice event.
// Fastify + an in-memory calendar_events table (with the two DB invariants as CHECKs answering 23514); the rate
// limiter's RPC is answered by a fetch stub. Only the DELETE `all` test reads the clock (today in a zone); the rest
// use `following`, whose window is the anchor's date, and fixtures in 2040.
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

const { HttpError } = await import("../../src/lib/errors.js");
const { resetSeriesReady } = await import("../../src/lib/seriesSchema.js");
const { default: calendarRoutes } = await import("../../src/routes/calendar.js");

type Row = Record<string, unknown>;
const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000009";
const STUDENT = "00000000-0000-4000-8000-000000000002";
const FOREIGN_STUDENT = "00000000-0000-4000-8000-000000000003";
const OWN_TYPE = "00000000-0000-4000-8000-0000000000a1";
const FOREIGN_TYPE = "00000000-0000-4000-8000-0000000000a2";
const SERIES = "00000000-0000-4000-8000-00000000c0de";
const OTHER_SERIES = "00000000-0000-4000-8000-00000000beef";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TZ = "America/New_York";

const realFetch = globalThis.fetch;
beforeEach(() => {
  resetSeriesReady();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/rest/v1/rpc/consume_rate_limit")) return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- in-memory tables --------------------------------------------------------------------------------------

type State = {
  seriesColumn: boolean;
  rows: Row[];
  inserts: Row[][];
  updates: Array<{ id: string; values: Row }>;
  deletes: string[];
  assignmentDeletes: string[];
  updateFails: Set<string>;
  deleteFails: Set<string>;
};

const fresh = (rows: Row[] = [], over: Partial<State> = {}): State => ({
  seriesColumn: true,
  rows,
  inserts: [],
  updates: [],
  deletes: [],
  assignmentDeletes: [],
  updateFails: new Set(),
  deleteFails: new Set(),
  ...over,
});

/** The table's two CHECKs. */
const violates = (r: Row) =>
  (r.ends_at != null && (r.starts_at == null || Date.parse(String(r.ends_at)) <= Date.parse(String(r.starts_at)))) ||
  (r.shared_with_student === true && r.student_id == null);

function fakeDb(s: State) {
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    const all = (name: string) => ops.filter(([n]) => n === name);
    const op = (name: string) => ops.find(([n]) => n === name);
    const done = (): { data: unknown; error: unknown } => {
      const select = String(op("select")?.[1][0] ?? "");
      if (op("limit")?.[1][0] === 0) {
        if (!select.includes("series_id") || s.seriesColumn) return { data: [], error: null };
        return { data: null, error: { code: "42703", message: "no column" } };
      }
      const eqs = all("eq").map(([, a]) => a as [string, unknown]);
      if (table === "calendar_event_type_assignments") {
        if (op("delete")) s.assignmentDeletes.push(String(eqs.find(([k]) => k === "event_ref")?.[1]));
        return { data: null, error: null };
      }
      const eqId = eqs.find(([k]) => k === "id")?.[1];
      // RLS hides another counselor's student and another owner's type: no row.
      if (table === "profiles") return { data: eqId === STUDENT ? { id: STUDENT, counselor_id: OWNER } : null, error: null };
      if (table === "calendar_event_types") return { data: eqId === OWN_TYPE ? { id: OWN_TYPE } : null, error: null };
      if (table !== "calendar_events") return { data: [], error: null };
      const match = (r: Row) =>
        eqs.every(([k, v]) => r[k] === v) && all("gte").every(([, [k, v]]) => String(r[k as string]) >= String(v));
      if (op("insert")) {
        const values = [op("insert")![1][0]].flat() as Row[];
        s.inserts.push(values);
        const saved = values.map((v, i) => ({ id: id(100 + s.rows.length + i), created_at: "c", updated_at: "u", ...v }));
        s.rows.push(...saved);
        if (op("single")) return { data: { ...saved[0] }, error: null };
        return { data: saved.map((r) => ({ ...r })), error: null };
      }
      if (op("update")) {
        const target = s.rows.find(match);
        if (!target) return { data: null, error: null };
        if (s.updateFails.has(String(target.id))) return { data: null, error: { code: "XX000", message: "boom" } };
        const values = op("update")![1][0] as Row;
        if (violates({ ...target, ...values })) return { data: null, error: { code: "23514", message: "check" } };
        s.updates.push({ id: String(target.id), values });
        Object.assign(target, values);
        return { data: { ...target }, error: null };
      }
      if (op("delete")) {
        const target = s.rows.find(match);
        if (!target) return { data: [], error: null };
        if (s.deleteFails.has(String(target.id))) return { data: null, error: { code: "XX000", message: "boom" } };
        s.deletes.push(String(target.id));
        s.rows = s.rows.filter((r) => r !== target);
        return { data: [{ id: target.id }], error: null };
      }
      const found = s.rows.filter(match).sort((a, b) => String(a.on_date).localeCompare(String(b.on_date)));
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
  app.register(calendarRoutes, { prefix: "/calendar" });
  await app.ready();
  return app;
}
type App = Awaited<ReturnType<typeof build>>;

const ev = (n: number, onDate: string, startsAt: string | null, over: Row = {}): Row => ({
  id: id(n),
  series_id: SERIES,
  owner_id: OWNER,
  student_id: null,
  title: "Planning block",
  detail: null,
  on_date: onDate,
  starts_at: startsAt,
  ends_at: startsAt ? new Date(Date.parse(startsAt) + 60 * 60_000).toISOString() : null,
  type_id: null,
  shared_with_student: false,
  created_at: "c",
  updated_at: "u",
  ...over,
});
// Weekly 9:00-10:00 New York, January 2040 (EST: 14:00Z).
const weekly = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(2040, 0, 5 + 7 * i, 14));
    return ev(i + 1, d.toISOString().slice(0, 10), d.toISOString());
  });
const create = (app: App, payload: unknown) => app.inject({ method: "POST", url: "/calendar/events/series", payload: payload as object });
const patchSeries = (app: App, payload: unknown, series = SERIES) =>
  app.inject({ method: "PATCH", url: `/calendar/events/series/${series}`, payload: payload as object });
const deleteSeries = (app: App, query: string, series = SERIES) => app.inject({ method: "DELETE", url: `/calendar/events/series/${series}?${query}` });
const plusDay = (iso: string) => new Date(Date.parse(iso) + 86_400_000).toISOString();
const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// ---- POST ----------------------------------------------------------------------------------------------------

test("POST weekly x3 timed: 3 rows in ONE insert, one series_id, 7 days apart on the wall clock", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await create(app, { title: "Planning", date: "2040-01-05", startMinutes: 540, durationMins: 45, timeZone: TZ, repeat: { preset: "weekly", count: 3 } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(state.inserts.length, 1);
  const body = res.json();
  assert.equal(body.events.length, 3);
  assert.deepEqual(body.events.map((e: Row) => e.onDate), ["2040-01-05", "2040-01-12", "2040-01-19"]);
  assert.deepEqual(body.events.map((e: Row) => e.startsAt), ["2040-01-05T14:00:00.000Z", "2040-01-12T14:00:00.000Z", "2040-01-19T14:00:00.000Z"]);
  assert.deepEqual(body.events.map((e: Row) => e.endsAt), ["2040-01-05T14:45:00.000Z", "2040-01-12T14:45:00.000Z", "2040-01-19T14:45:00.000Z"]);
  for (const r of state.inserts[0]!) {
    assert.equal(r.series_id, body.seriesId);
    assert.equal(r.owner_id, OWNER);
  }
  await app.close();
});

test("POST across the 2027-11-07 New York DST end keeps 9:00 local", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await create(app, { title: "Planning", date: "2027-10-31", startMinutes: 540, durationMins: 60, timeZone: TZ, repeat: { preset: "weekly", count: 3 } });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(res.json().events.map((e: Row) => e.startsAt), ["2027-10-31T13:00:00.000Z", "2027-11-07T14:00:00.000Z", "2027-11-14T14:00:00.000Z"]);
  await app.close();
});

test("POST all day: starts_at and ends_at null", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await create(app, { title: "Essay day", date: "2040-01-05", startMinutes: null, timeZone: TZ, repeat: { preset: "daily", count: 2 } });
  assert.equal(res.statusCode, 201, res.body);
  for (const r of state.inserts[0]!) {
    assert.equal(r.starts_at, null);
    assert.equal(r.ends_at, null);
  }
  assert.deepEqual(state.inserts[0]!.map((r) => r.on_date), ["2040-01-05", "2040-01-06"]);
  await app.close();
});

test("POST refuses: timed without durationMins, sharing without a student, over the cap, a stray key", async () => {
  const app = await build(fresh());
  const base = { title: "P", date: "2040-01-05", startMinutes: 540, durationMins: 30, timeZone: TZ, repeat: { preset: "weekly", count: 3 } };
  const { durationMins: _d, ...noDuration } = base;
  assert.equal((await create(app, noDuration)).statusCode, 400);
  assert.equal((await create(app, { ...base, sharedWithStudent: true })).statusCode, 400);
  const overSpan = await create(app, { ...base, repeat: { preset: "weekly", until: "2041-06-01" } });
  assert.equal(overSpan.statusCode, 400);
  assert.equal(overSpan.json().error, "A series can run for at most 366 days.");
  assert.equal((await create(app, { ...base, onDate: "2040-01-05" })).statusCode, 400);
  await app.close();
});

// ---- PATCH ---------------------------------------------------------------------------------------------------

test("PATCH following {days:1}: moves on_date and instants of the anchor and later rows only", async () => {
  const state = fresh(weekly(3));
  const before = state.rows.map((r) => ({ ...r }));
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(2), scope: "following", timeZone: TZ, patch: { startsAt: plusDay(String(before[1]!.starts_at)), title: "Moved" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { updated: 2, skipped: 0, failed: [] });
  assert.deepEqual(state.rows[0], before[0], "row 1 untouched");
  for (const i of [1, 2]) {
    assert.equal(state.rows[i]!.on_date, plusDay(`${before[i]!.on_date}T00:00:00.000Z`).slice(0, 10));
    assert.equal(state.rows[i]!.starts_at, plusDay(String(before[i]!.starts_at)));
    assert.equal(state.rows[i]!.ends_at, plusDay(String(before[i]!.ends_at)), "keeps its own length");
    assert.equal(state.rows[i]!.title, "Moved");
  }
  await app.close();
});

test("PATCH onDate drives days; a nudged row keeps its own offset; an all-day row only moves its date", async () => {
  const rows = weekly(3);
  rows[1]!.starts_at = "2040-01-12T15:30:00.000Z"; // nudged to 10:30 local by hand
  rows[1]!.ends_at = "2040-01-12T16:00:00.000Z";
  rows[2]!.starts_at = null; // made all day by hand
  rows[2]!.ends_at = null;
  const state = fresh(rows);
  const app = await build(state);
  // Anchor row 1: one day later and an hour later.
  const res = await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { onDate: "2040-01-06", startsAt: "2040-01-06T15:00:00.000Z" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().updated, 3);
  assert.equal(state.rows[0]!.starts_at, "2040-01-06T15:00:00.000Z");
  assert.equal(state.rows[1]!.on_date, "2040-01-13");
  assert.equal(state.rows[1]!.starts_at, "2040-01-13T16:30:00.000Z", "nudged row keeps its offset");
  assert.equal(state.rows[1]!.ends_at, "2040-01-13T17:00:00.000Z", "and its own 30 minutes");
  assert.equal(state.rows[2]!.on_date, "2040-01-20");
  assert.equal(state.rows[2]!.starts_at, null, "all-day row ignores the time keys");
  assert.equal(state.rows[2]!.ends_at, null);
  assert.deepEqual(Object.keys(state.updates[2]!.values), ["on_date"]);
  await app.close();
});

test("PATCH a move across the DST end keeps the local time", async () => {
  const rows = [ev(1, "2027-10-31", "2027-10-31T13:00:00.000Z"), ev(2, "2027-11-07", "2027-11-07T14:00:00.000Z")];
  const state = fresh(rows);
  const app = await build(state);
  // 9:00 -> 10:00 local on the anchor (EDT).
  const res = await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { startsAt: "2027-10-31T14:00:00.000Z" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(state.rows[1]!.starts_at, "2027-11-07T15:00:00.000Z", "10:00 EST");
  assert.equal(state.rows[1]!.on_date, "2027-11-07");
  await app.close();
});

test("PATCH resize (endsAt only) sets every timed row's length", async () => {
  const state = fresh(weekly(3));
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { endsAt: "2040-01-05T14:30:00.000Z" } });
  assert.equal(res.statusCode, 200, res.body);
  for (const r of state.rows) assert.equal(Date.parse(String(r.ends_at)) - Date.parse(String(r.starts_at)), 30 * 60_000);
  assert.deepEqual(Object.keys(state.updates[0]!.values), ["ends_at"]);
  await app.close();
});

test("PATCH refuses with 400: end not after start, a null time, an unknown or forbidden key", async () => {
  const state = fresh(weekly(2));
  const app = await build(state);
  const p = (patch: unknown) => patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch });
  assert.equal((await p({ endsAt: "2040-01-05T14:00:00.000Z" })).statusCode, 400);
  assert.equal((await p({ startsAt: null })).statusCode, 400);
  assert.equal((await p({ endsAt: null })).statusCode, 400);
  assert.equal((await p({ colour: "red" })).statusCode, 400);
  assert.equal((await p({ seriesId: OTHER_SERIES })).statusCode, 400);
  assert.equal((await p({})).statusCode, 400);
  assert.equal(state.updates.length, 0);
  await app.close();
});

test("PATCH 404: anchor in another series, or another owner's", async () => {
  const rows = [...weekly(2), ev(7, "2040-01-05", null, { series_id: OTHER_SERIES }), ev(8, "2040-01-05", null, { owner_id: OTHER_OWNER })];
  const state = fresh(rows);
  const app = await build(state);
  assert.equal((await patchSeries(app, { anchorId: id(7), scope: "following", timeZone: TZ, patch: { title: "x" } })).statusCode, 404);
  assert.equal((await patchSeries(app, { anchorId: id(8), scope: "following", timeZone: TZ, patch: { title: "x" } })).statusCode, 404);
  assert.equal(state.updates.length, 0);
  await app.close();
});

test("PATCH never touches another owner's row of the same series id", async () => {
  const rows = [...weekly(2), ev(8, "2040-01-19", null, { owner_id: OTHER_OWNER })];
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { title: "Mine" } });
  assert.equal(res.json().updated, 2);
  assert.equal(state.rows[2]!.title, "Planning block");
  await app.close();
});

test("PATCH per row: a failing row is reported, the others updated, still 200; a CHECK is said in words", async () => {
  const rows = weekly(3);
  rows[2]!.student_id = STUDENT; // only row 3 can be shared
  const state = fresh(rows, { updateFails: new Set([id(2)]) });
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { sharedWithStudent: true } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.updated, 1);
  assert.deepEqual(body.failed.map((f: Row) => [f.id, f.date]), [[id(1), "2040-01-05"], [id(2), "2040-01-12"]]);
  assert.match(body.failed[0].message, /student/i);
  assert.equal(body.failed[1].message, "Couldn't change this event. Try again.");
  assert.equal(state.rows[2]!.shared_with_student, true);
  await app.close();
});

test("PATCH un-assigning the student un-shares", async () => {
  const rows = weekly(2).map((r) => ({ ...r, student_id: STUDENT, shared_with_student: true }));
  const state = fresh(rows);
  const app = await build(state);
  const res = await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { studentId: null } });
  assert.equal(res.json().updated, 2);
  assert.deepEqual(state.updates[0]!.values, { student_id: null, shared_with_student: false });
  await app.close();
});

// ---- DELETE --------------------------------------------------------------------------------------------------

test("DELETE following from the 2nd of 3 leaves row 1 and drops the assignments of the deleted rows", async () => {
  const state = fresh(weekly(3));
  const app = await build(state);
  const res = await deleteSeries(app, `anchorId=${id(2)}&scope=following&timeZone=${encodeURIComponent(TZ)}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { deleted: 2, skipped: 0, failed: [] });
  assert.deepEqual(state.rows.map((r) => r.id), [id(1)]);
  assert.deepEqual(state.assignmentDeletes, [id(2), id(3)]);
  await app.close();
});

test("DELETE all leaves rows before today in the given time zone", async () => {
  // Kiritimati (UTC+14) is always a day or two ahead of Pago Pago (UTC-11).
  const pago = todayIn("Pacific/Pago_Pago");
  const mk = () => [ev(1, pago, null), ...weekly(2).map((r, i) => ({ ...r, id: id(i + 2) }))];
  let state = fresh(mk());
  let app = await build(state);
  let res = await deleteSeries(app, `anchorId=${id(2)}&scope=all&timeZone=Pacific/Kiritimati`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().deleted, 2);
  assert.deepEqual(state.rows.map((r) => r.id), [id(1)], "yesterday in Kiritimati stays");
  await app.close();

  state = fresh(mk());
  app = await build(state);
  res = await deleteSeries(app, `anchorId=${id(2)}&scope=all&timeZone=Pacific/Pago_Pago`);
  assert.equal(res.json().deleted, 3, "today in Pago Pago is in");
  await app.close();
});

test("DELETE per row: a failure is reported, never thrown", async () => {
  const state = fresh(weekly(3), { deleteFails: new Set([id(2)]) });
  const app = await build(state);
  const res = await deleteSeries(app, `anchorId=${id(1)}&scope=following&timeZone=${encodeURIComponent(TZ)}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().deleted, 2);
  assert.deepEqual(res.json().failed, [{ id: id(2), date: "2040-01-12", message: "Couldn't delete this event. Try again." }]);
  assert.deepEqual(state.rows.map((r) => r.id), [id(2)]);
  await app.close();
});

test("DELETE 404 for an anchor outside the series", async () => {
  const state = fresh([...weekly(2), ev(7, "2040-01-05", null, { series_id: OTHER_SERIES })]);
  const app = await build(state);
  assert.equal((await deleteSeries(app, `anchorId=${id(7)}&scope=following`)).statusCode, 404);
  assert.equal(state.deletes.length, 0);
  await app.close();
});

// ---- 503 and the single routes --------------------------------------------------------------------------------

test("all three answer 503 series_unavailable without the column", async () => {
  const state = fresh(weekly(2), { seriesColumn: false });
  const app = await build(state);
  const responses = [
    await create(app, { title: "P", date: "2040-01-05", startMinutes: null, timeZone: TZ, repeat: { preset: "weekly", count: 2 } }),
    await patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch: { title: "x" } }),
    await deleteSeries(app, `anchorId=${id(1)}&scope=following`),
  ];
  for (const res of responses) {
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().code, "series_unavailable");
  }
  assert.equal(state.inserts.length + state.updates.length + state.deletes.length, 0);
  await app.close();
});

test("a foreign studentId or typeId is refused (404) on the series POST and PATCH, nothing written", async () => {
  const state = fresh(weekly(2));
  const app = await build(state);
  const base = { title: "P", date: "2040-01-05", startMinutes: null, timeZone: TZ, repeat: { preset: "weekly", count: 2 } };
  assert.equal((await create(app, { ...base, studentId: FOREIGN_STUDENT })).statusCode, 404);
  assert.equal((await create(app, { ...base, typeId: FOREIGN_TYPE })).statusCode, 404);
  assert.equal((await create(app, { ...base, studentId: STUDENT, typeId: OWN_TYPE })).statusCode, 201, "own refs pass");
  const p = (patch: unknown) => patchSeries(app, { anchorId: id(1), scope: "following", timeZone: TZ, patch });
  assert.equal((await p({ studentId: FOREIGN_STUDENT })).statusCode, 404);
  assert.equal((await p({ typeId: FOREIGN_TYPE })).statusCode, 404);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.updates.length, 0);
  await app.close();
});

test("the single POST /calendar/events still makes one event (201)", async () => {
  const state = fresh();
  const app = await build(state);
  const res = await app.inject({ method: "POST", url: "/calendar/events", payload: { title: "One", onDate: "2040-01-05" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().title, "One");
  assert.equal(state.rows.length, 1);
  await app.close();
});

test("the single /calendar/events/:id routes still answer (not captured by /events/series)", async () => {
  const state = fresh(weekly(1));
  const app = await build(state);
  const res = await app.inject({ method: "PATCH", url: `/calendar/events/${id(1)}`, payload: { title: "One" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().title, "One");
  const del = await app.inject({ method: "DELETE", url: `/calendar/events/${id(1)}` });
  assert.deepEqual(del.json(), { deleted: true });
  await app.close();
});
