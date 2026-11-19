// Characterization of PATCH /meetings/:id: what it does, in what order, and what it answers. Written before the handler's
// body moved into applyMeetingPatch (for the repeating-series route to reuse), and it must pass unchanged on both sides of
// that move. The routes run on Fastify with a fake request database; `events` is the order of the steps that matter.
process.env.ZOOM_CLIENT_ID = "zoom-client-id-0000";
process.env.ZOOM_CLIENT_SECRET = "zoom-client-secret-0000";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000000";
process.env.INTEGRATION_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const { HttpError } = await import("../../src/lib/errors.js");
const { encryptToken } = await import("../../src/lib/tokenCrypto.js");
const { resetInvitesReady } = await import("../../src/lib/meetingInvites.js");
const { default: meetingRoutes } = await import("../../src/routes/meetings.js");

type Row = Record<string, unknown>;
const OWNER = "00000000-0000-4000-8000-000000000001";
const STUDENT = "00000000-0000-4000-8000-000000000002";
const SECOND = "00000000-0000-4000-8000-000000000003"; // another student of the same counselor
const FOREIGN = "00000000-0000-4000-8000-000000000004"; // a student of someone else
const MID = "00000000-0000-4000-8000-0000000000aa";
const NOTE = "00000000-0000-4000-8000-0000000000bb";
const ELSEWHERE = "00000000-0000-4000-8000-0000000000ee";

type State = {
  ready: boolean;
  existing: Row;
  students: Record<string, string>; // student id -> their counselor
  noteStudent: string | null; // the student a meeting note is about (null: no such note)
  attendeeReadFailsFrom: number; // the Nth read of meeting_attendees and every one after it errors (0: never)
  attendeeWriteError: boolean;
  events: string[];
  updated: Row[];
  attendeeReads: number;
  zoomRefuses: boolean;
};

let state: State;
const fresh = (over: Partial<State> = {}): State => ({
  ready: false,
  existing: row(),
  students: { [STUDENT]: OWNER, [SECOND]: OWNER, [FOREIGN]: ELSEWHERE },
  noteStudent: null,
  attendeeReadFailsFrom: 0,
  attendeeWriteError: false,
  events: [],
  updated: [],
  attendeeReads: 0,
  zoomRefuses: false,
  ...over,
});

const row = (over: Row = {}): Row => ({
  id: MID,
  student_id: STUDENT,
  counselor_id: OWNER,
  title: "Essay check-in",
  mode: "google-meet",
  status: "scheduled",
  join_url: null,
  calendar_provider: null,
  calendar_event_id: null,
  starts_at: "2030-01-15T15:00:00Z",
  ends_at: "2030-01-15T15:45:00Z",
  agenda: null,
  location: null,
  guardians_invited: false,
  ...over,
});

// ---- fetch stub: Zoom, the token store and the rate limiter ------------------------------------------

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
  resetInvitesReady();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") ?? "";
    if (url.includes("/rest/v1/rpc/consume_rate_limit")) {
      const key = String((JSON.parse(String(init?.body)) as Row).p_key);
      if (key.startsWith("meeting-invites:")) state.events.push("round:consume");
      return json(true);
    }
    if (url.includes("/rest/v1/integration_tokens") && method === "GET") return accept.includes("pgrst.object") ? json(tokenRow()) : json([tokenRow()]);
    if (url.startsWith("https://api.zoom.us/v2/meetings/")) {
      if (method === "PATCH") state.events.push("zoom:move");
      return state.zoomRefuses ? json({ code: 1, message: "refused" }, 400) : new Response(null, { status: 204 });
    }
    // Anything else the background delivery touches (delivery records): accepted, and not part of the order under test.
    if (url.includes("/rest/v1/")) return json([]);
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
});

// ---- fake request database -----------------------------------------------------------------------------

function fakeDb(s: State) {
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    const op = (name: string) => ops.find(([n]) => n === name);
    const done = (): { data: unknown; error: unknown } => {
      const select = String(op("select")?.[1][0] ?? "");
      const eqId = String(op("eq")?.[1][1] ?? "");
      if (table === "meetings") {
        if (op("update")) {
          s.events.push("update");
          s.updated.push(op("update")![1][0] as Row);
          return { data: { ...s.existing, ...(op("update")![1][0] as Row) }, error: null };
        }
        if (select.includes("send_invites")) {
          s.events.push("probe");
          return s.ready ? { data: [], error: null } : { data: null, error: { code: "42703", message: "no column" } };
        }
        s.events.push("load");
        return { data: s.existing, error: null };
      }
      if (table === "profiles") {
        if (select === "id, counselor_id") {
          s.events.push(`access:${eqId.slice(-1)}`);
          return { data: s.students[eqId] ? { id: eqId, counselor_id: s.students[eqId] } : null, error: null };
        }
        if (select === "id, full_name, email") {
          s.events.push("round:organizer");
          return { data: { id: OWNER, full_name: "Counselor", email: "counselor@school.org" }, error: null };
        }
        s.events.push("round:students");
        const ids = (op("in")?.[1][1] as string[]).filter((id) => s.students[id]);
        return { data: ids.map((id) => ({ id, full_name: "Student", email: `${id.slice(-1)}@school.org`, archived_at: null, counselor_id: s.students[id] })), error: null };
      }
      if (table === "student_collaborators") return { data: null, error: null };
      if (table === "meeting_notes") {
        s.events.push("note");
        return { data: s.noteStudent ? { student_id: s.noteStudent } : null, error: null };
      }
      if (table === "accountability_settings") {
        s.events.push("round:settings");
        return { data: [], error: null };
      }
      if (table === "meeting_attendees") {
        if (op("delete")) {
          s.events.push("attendees:delete");
          return { data: null, error: s.attendeeWriteError ? { code: "XX000", message: "write failed" } : null };
        }
        if (op("upsert")) {
          s.events.push("attendees:upsert");
          return { data: null, error: null };
        }
        if (select === "meeting_id, student_id") {
          s.events.push("attendees:response");
          return { data: [], error: null };
        }
        s.attendeeReads += 1;
        s.events.push("attendees:read");
        return s.attendeeReadFailsFrom && s.attendeeReads >= s.attendeeReadFailsFrom
          ? { data: null, error: { code: "XX000", message: "read failed" } }
          : { data: [], error: null };
      }
      throw new Error(`unexpected table ${table}`);
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

async function patch(payload: Row, over: Partial<State> = {}) {
  state = fresh(over);
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
  const res = await app.inject({ method: "PATCH", url: `/meetings/${MID}`, payload });
  await app.close();
  return { res, s: state };
}

// ---- the plain answer ---------------------------------------------------------------------------------

test("a plain PATCH writes only what was sent and answers the meeting with its attendees, its link and invites none", async () => {
  const { res, s } = await patch({ title: "Renamed", agenda: "Bring drafts" });
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.equal(out.title, "Renamed");
  assert.equal(out.agenda, "Bring drafts");
  assert.deepEqual(out.attendeeIds, [STUDENT]);
  assert.equal(out.htmlLink, null);
  assert.deepEqual(out.invites, { status: "none" });
  assert.deepEqual(s.updated, [{ title: "Renamed", agenda: "Bring drafts" }]);
  assert.deepEqual(s.events, ["load", "access:2", "probe", "update", "attendees:response"]);
});

test("a patch that changes nothing on the row writes nothing and still answers the meeting", async () => {
  const { res, s } = await patch({});
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().title, "Essay check-in");
  assert.deepEqual(res.json().invites, { status: "none" });
  assert.deepEqual(s.updated, []);
  assert.deepEqual(s.events, ["load", "access:2", "probe", "attendees:response"]);
});

test("sendInvites before the invite columns exist answers unavailable, and the write names no invite column", async () => {
  const { res, s } = await patch({ title: "Renamed", sendInvites: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().invites, { status: "unavailable", reason: "Calendar invites aren't switched on yet" });
  assert.deepEqual(s.updated, [{ title: "Renamed" }]);
});

// ---- refused before anything is written -----------------------------------------------------------------

test("an invite with no end time is refused once the invite columns exist, before anything moves", async () => {
  const { res, s } = await patch({ sendInvites: true }, { ready: true, existing: row({ ends_at: null }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "A calendar invite needs an end time");
  assert.deepEqual(s.updated, []);
  assert.deepEqual(s.events, ["load", "access:2", "probe"]);
});

test("a note about another student is refused before anything is written", async () => {
  const { res, s } = await patch({ meetingNoteId: NOTE, title: "Renamed" }, { noteStudent: SECOND });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "That note isn't about this student");
  assert.deepEqual(s.updated, []);
  assert.deepEqual(s.events, ["load", "access:2", "note"]);
});

test("a note about the meeting's own student is linked", async () => {
  const { res, s } = await patch({ meetingNoteId: NOTE }, { noteStudent: STUDENT });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(s.updated, [{ meeting_note_id: NOTE }]);
  assert.deepEqual(s.events, ["load", "access:2", "note", "probe", "update", "attendees:response"]);
});

test("an attendee the counselor may not edit is refused after the primary's check and before anything else", async () => {
  const { res, s } = await patch({ attendeeIds: [SECOND, FOREIGN], title: "Renamed" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, "That student isn't on your roster");
  assert.deepEqual(s.updated, []);
  assert.deepEqual(s.events, ["load", "access:2", "access:3", "access:4"]);
});

test("booking a conference on someone else's meeting is refused before the row is written", async () => {
  const { res, s } = await patch({ createConference: true, mode: "google-meet" }, { existing: row({ counselor_id: ELSEWHERE }) });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(s.updated, []);
  assert.deepEqual(s.events, ["load", "access:2", "probe"]);
});

test("a provider that refuses a move leaves the row as it was", async () => {
  const zoom = row({ mode: "zoom", join_url: "https://zoom.us/j/1", calendar_provider: "zoom", calendar_event_id: "81234567890" });
  const { res, s } = await patch({ startsAt: "2030-01-16T15:00:00Z" }, { existing: zoom, zoomRefuses: true });
  assert.ok(res.statusCode >= 400, res.body);
  assert.deepEqual(s.updated, []);
  assert.deepEqual(s.events, ["load", "access:2", "probe", "zoom:move"]);
});

// ---- the invite round -----------------------------------------------------------------------------------

const inviting = (over: Row = {}) => row({ send_invites: true, ...over });

test("a change to a meeting that sends invites reads who held it first, writes the row, then tells them", async () => {
  const { res, s } = await patch({ title: "Moved" }, { ready: true, existing: inviting() });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().invites.status, "sending");
  assert.equal(res.json().invites.recipients, 1);
  assert.deepEqual(s.updated, [{ title: "Moved" }]);
  assert.deepEqual(s.events, ["load", "access:2", "probe", "attendees:read", "update", "round:organizer", "round:students", "round:settings", "round:consume", "attendees:response"]);
});

test("notifyAttendees false saves the change, still reads who held it, and prepares no round", async () => {
  const { res, s } = await patch({ title: "Moved", notifyAttendees: false }, { ready: true, existing: inviting() });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().invites, { status: "none" });
  assert.deepEqual(s.updated, [{ title: "Moved" }]);
  assert.deepEqual(s.events, ["load", "access:2", "probe", "attendees:read", "update", "attendees:response"]);
});

test("new attendees replace the old ones after the row is written, and the round runs on the new set", async () => {
  const { res, s } = await patch({ title: "Moved", attendeeIds: [SECOND] }, { ready: true, existing: inviting() });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().invites.status, "sending");
  assert.equal(res.json().invites.recipients, 2);
  assert.deepEqual(s.events, [
    "load", "access:2", "access:3", "probe", "attendees:read", "update", "attendees:delete", "attendees:upsert",
    "round:organizer", "round:students", "round:settings", "round:consume", "attendees:response",
  ]);
});

test("when the attendee write fails after the row is saved, the invitees are still told and the failure is what comes back", async () => {
  const { res, s } = await patch({ title: "Moved", attendeeIds: [SECOND] }, { ready: true, existing: inviting(), attendeeWriteError: true });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, "Database error");
  assert.deepEqual(s.updated, [{ title: "Moved" }], "the row change is committed");
  // The round runs on who is still invited (re-read after the failed write), before the failure is thrown.
  assert.deepEqual(s.events, [
    "load", "access:2", "access:3", "probe", "attendees:read", "update", "attendees:delete", "attendees:read",
    "round:organizer", "round:students", "round:settings", "round:consume",
  ]);
});

test("when the attendee write fails and who is invited can't be re-read, no round is prepared and the write's failure comes back", async () => {
  const { res, s } = await patch({ title: "Moved", attendeeIds: [SECOND] }, { ready: true, existing: inviting(), attendeeWriteError: true, attendeeReadFailsFrom: 2 });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, "Database error");
  assert.deepEqual(s.updated, [{ title: "Moved" }]);
  assert.deepEqual(s.events, ["load", "access:2", "access:3", "probe", "attendees:read", "update", "attendees:delete", "attendees:read"]);
});

test("who held the invite is read before anything moves, and a failed read stops the change", async () => {
  const { res, s } = await patch({ title: "Moved" }, { ready: true, existing: inviting(), attendeeReadFailsFrom: 1 });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(s.updated, []);
  assert.deepEqual(s.events, ["load", "access:2", "probe", "attendees:read"]);
});
