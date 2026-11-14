// Student booking: the busy view's merge (lib/bookingSlots.ts mergeBusy). Pure: no database, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeBusy, openRanges } from "../../src/lib/bookingSlots.js";

const FROM = "2027-01-04T00:00:00.000Z";
const TO = "2027-01-05T00:00:00.000Z";
const iv = (start: string, end: string) => ({ start, end });

test("overlapping and touching ranges join, sorted", () => {
  const out = mergeBusy(
    [
      iv("2027-01-04T15:00:00Z", "2027-01-04T16:00:00Z"),
      iv("2027-01-04T10:00:00Z", "2027-01-04T11:00:00Z"),
      iv("2027-01-04T10:30:00Z", "2027-01-04T12:00:00Z"),
      iv("2027-01-04T12:00:00Z", "2027-01-04T13:00:00Z"),
    ],
    FROM,
    TO
  );
  assert.deepEqual(out, [iv("2027-01-04T10:00:00.000Z", "2027-01-04T13:00:00.000Z"), iv("2027-01-04T15:00:00.000Z", "2027-01-04T16:00:00.000Z")]);
});

test("clipped to the window; empty, reversed and unparseable ranges dropped", () => {
  const out = mergeBusy(
    [
      iv("2027-01-03T22:00:00Z", "2027-01-04T01:00:00Z"),
      iv("2027-01-04T23:00:00Z", "2027-01-05T03:00:00Z"),
      iv("2027-01-04T05:00:00Z", "2027-01-04T05:00:00Z"),
      iv("2027-01-04T09:00:00Z", "2027-01-04T08:00:00Z"),
      iv("nope", "2027-01-04T08:00:00Z"),
      iv("2027-01-06T01:00:00Z", "2027-01-06T02:00:00Z"),
    ],
    FROM,
    TO
  );
  assert.deepEqual(out, [iv("2027-01-04T00:00:00.000Z", "2027-01-04T01:00:00.000Z"), iv("2027-01-04T23:00:00.000Z", "2027-01-05T00:00:00.000Z")]);
});

test("only start and end leave: no title, id or attendee survives", () => {
  const rich = { start: "2027-01-04T10:00:00Z", end: "2027-01-04T11:00:00Z", title: "Ana's essay review", id: "m1", attendees: ["x"] };
  const [out] = mergeBusy([rich], FROM, TO);
  assert.deepEqual(Object.keys(out).sort(), ["end", "start"]);
});

test("nothing busy is an empty list", () => {
  assert.deepEqual(mergeBusy([], FROM, TO), []);
});

test("open hours: weekly hours in the counselor's zone as instants, DST-safe, clipped", () => {
  // Mon 2027-01-04 09:00-12:00 and 13:00-17:00 New York (EST, -5); Tue has none.
  const weeklyHours = { "1": [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }] };
  const out = openRanges({ timeZone: "America/New_York", weeklyHours, from: "2027-01-04T00:00:00Z", to: "2027-01-06T00:00:00Z" });
  assert.deepEqual(out, [iv("2027-01-04T14:00:00.000Z", "2027-01-04T17:00:00.000Z"), iv("2027-01-04T18:00:00.000Z", "2027-01-04T22:00:00.000Z")]);
  // Spring-forward Sunday 2027-03-14 (EDT from 02:00): 09:00 local is 13:00Z, not 14:00Z.
  const sun = openRanges({ timeZone: "America/New_York", weeklyHours: { "0": [{ start: "09:00", end: "10:00" }] }, from: "2027-03-14T00:00:00Z", to: "2027-03-15T00:00:00Z" });
  assert.deepEqual(sun, [iv("2027-03-14T13:00:00.000Z", "2027-03-14T14:00:00.000Z")]);
  // A window starting mid-range clips it.
  const clipped = openRanges({ timeZone: "America/New_York", weeklyHours, from: "2027-01-04T15:00:00Z", to: "2027-01-04T19:00:00Z" });
  assert.deepEqual(clipped, [iv("2027-01-04T15:00:00.000Z", "2027-01-04T17:00:00.000Z"), iv("2027-01-04T18:00:00.000Z", "2027-01-04T19:00:00.000Z")]);
  assert.deepEqual(openRanges({ timeZone: "America/New_York", weeklyHours: {}, from: "2027-01-04T00:00:00Z", to: "2027-01-05T00:00:00Z" }), []);
});
