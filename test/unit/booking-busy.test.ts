// Student booking: listBusy in lib/suiteApi.ts, the counselor's busy time from their connected
// calendar. The provider HTTP is stubbed through the __busy seam; nothing reaches the network.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { HttpError } from "../../src/lib/errors.js";
import { GOOGLE_SCOPE, MICROSOFT_SCOPE } from "../../src/lib/oauth.js";
import { __busy, listBusy } from "../../src/lib/suiteApi.js";

type Seen = { ownerId: string; provider: string; url: string; init: RequestInit; scope: string };
const log = { warn: () => undefined };
const FROM = "2027-01-04T00:00:00.000Z";
const TO = "2027-01-06T00:00:00.000Z";
const NY = "America/New_York";
let owner = 0;
const nextOwner = () => `00000000-0000-4000-8000-${String(++owner).padStart(12, "0")}`;

function stub(answers: (Response | Error)[]): Seen[] {
  const seen: Seen[] = [];
  __busy.request = async (ownerId, provider, url, init, scope) => {
    seen.push({ ownerId, provider, url, init, scope: scope.name });
    const next = answers.shift();
    if (!next) throw new Error("no more stubbed answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return seen;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => __busy.reset());

test("Google: events.list on primary with the calendar.events scope, never freebusy", async () => {
  const id = nextOwner();
  const seen = stub([
    json({
      items: [
        { status: "confirmed", start: { dateTime: "2027-01-04T10:00:00-05:00" }, end: { dateTime: "2027-01-04T11:00:00-05:00" } },
        { status: "cancelled", start: { dateTime: "2027-01-04T12:00:00-05:00" }, end: { dateTime: "2027-01-04T13:00:00-05:00" } },
        { transparency: "transparent", start: { dateTime: "2027-01-04T14:00:00-05:00" }, end: { dateTime: "2027-01-04T15:00:00-05:00" } },
        { start: { date: "2027-01-05" }, end: { date: "2027-01-06" } },
      ],
    }),
  ]);
  const busy = await listBusy(id, "google", FROM, TO, NY, log);
  assert.deepEqual(busy, [
    { start: "2027-01-04T15:00:00.000Z", end: "2027-01-04T16:00:00.000Z" },
    // All day on the 5th, as the counselor's whole local day.
    { start: "2027-01-05T05:00:00.000Z", end: "2027-01-06T05:00:00.000Z" },
  ]);
  assert.equal(seen.length, 1);
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, "https://www.googleapis.com/calendar/v3/calendars/primary/events");
  assert.equal(u.searchParams.get("singleEvents"), "true");
  assert.equal(u.searchParams.get("orderBy"), "startTime");
  assert.equal(u.searchParams.get("timeMin"), FROM);
  assert.equal(u.searchParams.get("timeMax"), TO);
  assert.equal(seen[0].scope, GOOGLE_SCOPE.calendarEvents);
  assert.ok(!/freebusy/i.test(seen[0].url));
});

test("Google: follows nextPageToken", async () => {
  const id = nextOwner();
  const seen = stub([
    json({ items: [{ start: { dateTime: "2027-01-04T15:00:00Z" }, end: { dateTime: "2027-01-04T16:00:00Z" } }], nextPageToken: "p2" }),
    json({ items: [{ start: { dateTime: "2027-01-05T15:00:00Z" }, end: { dateTime: "2027-01-05T16:00:00Z" } }] }),
  ]);
  const busy = await listBusy(id, "google", FROM, TO, NY, log);
  assert.equal(busy.length, 2);
  assert.equal(new URL(seen[1].url).searchParams.get("pageToken"), "p2");
});

test("Microsoft: calendarView in UTC, skipping free and cancelled; never getSchedule", async () => {
  const id = nextOwner();
  const seen = stub([
    json({
      value: [
        { showAs: "busy", start: { dateTime: "2027-01-04T15:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2027-01-04T16:00:00.0000000", timeZone: "UTC" } },
        { showAs: "free", start: { dateTime: "2027-01-04T17:00:00.0000000" }, end: { dateTime: "2027-01-04T18:00:00.0000000" } },
        { showAs: "tentative", isCancelled: true, start: { dateTime: "2027-01-04T19:00:00.0000000" }, end: { dateTime: "2027-01-04T20:00:00.0000000" } },
        { showAs: "oof", isAllDay: true, start: { dateTime: "2027-01-05T00:00:00.0000000" }, end: { dateTime: "2027-01-06T00:00:00.0000000" } },
      ],
    }),
  ]);
  const busy = await listBusy(id, "microsoft", FROM, TO, NY, log);
  assert.deepEqual(busy, [
    { start: "2027-01-04T15:00:00.000Z", end: "2027-01-04T16:00:00.000Z" },
    { start: "2027-01-05T05:00:00.000Z", end: "2027-01-06T05:00:00.000Z" },
  ]);
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, "https://graph.microsoft.com/v1.0/me/calendarView");
  assert.equal(u.searchParams.get("startDateTime"), FROM);
  assert.equal(u.searchParams.get("endDateTime"), TO);
  assert.equal((seen[0].init.headers as Record<string, string>).Prefer, 'outlook.timezone="UTC"');
  assert.equal(seen[0].scope, MICROSOFT_SCOPE.calendar);
  assert.ok(!/getSchedule/i.test(seen[0].url));
});

test("Microsoft: follows @odata.nextLink only on graph.microsoft.com", async () => {
  const id = nextOwner();
  const seen = stub([
    json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skip=10" }),
    json({ value: [], "@odata.nextLink": "https://evil.example.com/steal" }),
  ]);
  await listBusy(id, "microsoft", FROM, TO, NY, log);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].url, "https://graph.microsoft.com/v1.0/me/calendarView?$skip=10");
});

test("no calendar connected, or calendar not granted, is no busy time, not an error", async () => {
  stub([new HttpError(409, "Google isn't connected.", "google_disconnected")]);
  assert.deepEqual(await listBusy(nextOwner(), "google", FROM, TO, NY, log), []);
  stub([new HttpError(409, "no scope", "busy_scope_missing")]);
  assert.deepEqual(await listBusy(nextOwner(), "microsoft", FROM, TO, NY, log), []);
});

test("a provider failure is an error, so slots aren't offered over unknown busy time", async () => {
  stub([json({ error: "boom" }, 500)]);
  await assert.rejects(listBusy(nextOwner(), "google", FROM, TO, NY, log), (e: unknown) => e instanceof HttpError && e.statusCode === 503);
  stub([new HttpError(409, "reconnect", "google_reconnect")]);
  await assert.rejects(listBusy(nextOwner(), "google", FROM, TO, NY, log), (e: unknown) => e instanceof HttpError && e.code === "google_reconnect");
});

test("answers are cached for 60 seconds per counselor and window", async () => {
  const id = nextOwner();
  let t = 1_000_000;
  __busy.now = () => t;
  const seen = stub([json({ items: [] }), json({ items: [] }), json({ items: [] })]);
  await listBusy(id, "google", FROM, TO, NY, log);
  await listBusy(id, "google", FROM, TO, NY, log);
  assert.equal(seen.length, 1, "second read within 60 s comes from the cache");
  await listBusy(id, "google", FROM, "2027-01-07T00:00:00.000Z", NY, log);
  assert.equal(seen.length, 2, "another window is another entry");
  t += 61_000;
  await listBusy(id, "google", FROM, TO, NY, log);
  assert.equal(seen.length, 3, "expired after 60 s");
});

test("busy reads are rate limited per counselor", async () => {
  const id = nextOwner();
  stub(Array.from({ length: 100 }, () => json({ items: [] })));
  let refused: unknown = null;
  for (let i = 0; i < 100 && !refused; i++) {
    // A fresh window each time, so the cache never answers.
    const to = new Date(Date.parse(TO) + i * 60_000).toISOString();
    await listBusy(id, "google", FROM, to, NY, log).catch((e) => (refused = e));
  }
  assert.ok(refused instanceof HttpError && refused.statusCode === 429, String(refused));
});

test("more pages than the cap is unknown busy time: 503, never a partial list", async () => {
  stub(Array.from({ length: 10 }, (_, i) => json({ items: [], nextPageToken: `p${i + 2}` })));
  await assert.rejects(listBusy(nextOwner(), "google", FROM, TO, NY, log), (e: unknown) => e instanceof HttpError && e.statusCode === 503 && e.code === "calendar_busy_unavailable");
  stub(Array.from({ length: 10 }, () => json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skip=1" })));
  await assert.rejects(listBusy(nextOwner(), "microsoft", FROM, TO, NY, log), (e: unknown) => e instanceof HttpError && e.statusCode === 503 && e.code === "calendar_busy_unavailable");
});
