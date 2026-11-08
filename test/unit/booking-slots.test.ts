// Student booking: the pure slot maths (lib/bookingSlots.ts). No database, no network.
// Times are checked as UTC instants; America/New_York is EST (-5) in winter, EDT (-4) in summer.
// 2026-03-08 (a Sunday) springs forward 02:00 -> 03:00; 2026-11-01 (a Sunday) falls back 02:00 -> 01:00.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSlots, parseWeeklyHours, wallTimeToInstant, type SlotInput } from "../../src/lib/bookingSlots.js";

const NY = "America/New_York";

function input(over: Partial<SlotInput>): SlotInput {
  return {
    timeZone: NY,
    weeklyHours: {},
    durationMinutes: 60,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 60,
    from: "2027-01-01T00:00:00.000Z",
    to: "2027-01-08T00:00:00.000Z",
    busy: [],
    now: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

const iso = (s: string) => new Date(s).toISOString();

test("weekly hours become slot starts in the counselor's zone, stepped by the duration", () => {
  // 2027-01-04 is a Monday.
  const slots = computeSlots(input({ weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] } }));
  assert.deepEqual(slots, [iso("2027-01-04T14:00Z"), iso("2027-01-04T15:00Z"), iso("2027-01-04T16:00Z")]);
});

test("no weekly hours means no slots", () => {
  assert.deepEqual(computeSlots(input({ weeklyHours: {} })), []);
  assert.deepEqual(computeSlots(input({ weeklyHours: { 1: [] } })), []);
});

test("a 45-minute type steps by 45 minutes and never runs past the end of the hours", () => {
  const slots = computeSlots(input({ durationMinutes: 45, weeklyHours: { 1: [{ start: "09:00", end: "10:30" }] } }));
  // 09:00-09:45 and 09:45-10:30 fit; 10:30 would run past.
  assert.deepEqual(slots, [iso("2027-01-04T14:00Z"), iso("2027-01-04T14:45Z")]);
});

test("spring forward: a 01:00-04:00 window is two real hours, and other hours follow the new offset", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 0: [{ start: "01:00", end: "04:00" }, { start: "09:00", end: "10:00" }], 6: [{ start: "09:00", end: "10:00" }] },
      from: "2026-03-07T00:00:00Z",
      to: "2026-03-09T00:00:00Z",
      now: "2026-03-01T00:00:00Z",
    })
  );
  assert.deepEqual(slots, [
    iso("2026-03-07T14:00Z"), // Saturday 09:00 EST
    iso("2026-03-08T06:00Z"), // Sunday 01:00 EST
    iso("2026-03-08T07:00Z"), // Sunday 03:00 EDT (02:00 never happens)
    iso("2026-03-08T13:00Z"), // Sunday 09:00 EDT
  ]);
});

test("fall back: a 00:00-03:00 window is four real hours, and 09:00 is EST again", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 0: [{ start: "00:00", end: "03:00" }, { start: "09:00", end: "10:00" }] },
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
      now: "2026-10-01T00:00:00Z",
    })
  );
  assert.deepEqual(slots, [
    iso("2026-11-01T04:00Z"), // 00:00 EDT
    iso("2026-11-01T05:00Z"), // 01:00 EDT
    iso("2026-11-01T06:00Z"), // 01:00 EST
    iso("2026-11-01T07:00Z"), // 02:00 EST
    iso("2026-11-01T14:00Z"), // 09:00 EST
  ]);
});

test("a wall time inside the spring-forward gap moves forward by the gap (02:30 -> 03:30 EDT); an ambiguous one takes the first", () => {
  assert.equal(new Date(wallTimeToInstant("2026-03-08", "02:30", NY)).toISOString(), iso("2026-03-08T07:30Z"));
  assert.equal(new Date(wallTimeToInstant("2026-11-01", "01:30", NY)).toISOString(), iso("2026-11-01T05:30Z"));
  assert.equal(new Date(wallTimeToInstant("2026-07-01", "09:00", NY)).toISOString(), iso("2026-07-01T13:00Z"));
  assert.equal(new Date(wallTimeToInstant("2026-07-01", "24:00", NY)).toISOString(), iso("2026-07-02T04:00Z"));
});

test("busy time removes overlapping slots; touching is not overlapping", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] },
      busy: [{ start: "2027-01-04T15:00:00Z", end: "2027-01-04T15:30:00Z" }],
    })
  );
  assert.deepEqual(slots, [iso("2027-01-04T14:00Z"), iso("2027-01-04T16:00Z")]);
});

test("the buffer keeps clear before a busy block", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] },
      bufferMinutes: 15,
      busy: [{ start: "2027-01-04T16:10:00Z", end: "2027-01-04T16:40:00Z" }],
    })
  );
  // 15:00-16:00 ends 10 minutes before the block: inside the 15-minute buffer.
  assert.deepEqual(slots, [iso("2027-01-04T14:00Z")]);
});

test("the buffer keeps clear after a busy block", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] },
      bufferMinutes: 15,
      busy: [{ start: "2027-01-04T13:00:00Z", end: "2027-01-04T13:50:00Z" }],
    })
  );
  // The block ends 13:50; with the buffer nothing may start before 14:05.
  assert.deepEqual(slots, [iso("2027-01-04T15:00Z"), iso("2027-01-04T16:00Z")]);
});

test("busy blocks from several sources are all honoured", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] },
      busy: [
        { start: "2027-01-04T14:30:00Z", end: "2027-01-04T14:45:00Z" },
        { start: "2027-01-04T16:00:00Z", end: "2027-01-04T18:00:00Z" },
      ],
    })
  );
  assert.deepEqual(slots, [iso("2027-01-04T15:00Z")]);
});

test("minimum notice drops slots that start too soon", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] },
      minNoticeHours: 1,
      now: "2027-01-04T13:30:00Z",
    })
  );
  assert.deepEqual(slots, [iso("2027-01-04T15:00Z"), iso("2027-01-04T16:00Z")]);
});

test("slots in the past are never offered, even with no notice", () => {
  const slots = computeSlots(input({ weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] }, now: "2027-01-04T15:00:00Z" }));
  assert.deepEqual(slots, [iso("2027-01-04T15:00Z"), iso("2027-01-04T16:00Z")]);
});

test("max days ahead stops the list", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 1: [{ start: "09:00", end: "10:00" }] },
      maxDaysAhead: 7,
      now: "2027-01-01T00:00:00Z",
      from: "2027-01-01T00:00:00Z",
      to: "2027-01-15T00:00:00Z",
    })
  );
  assert.deepEqual(slots, [iso("2027-01-04T14:00Z")]);
});

test("only slots that start inside [from, to) are returned", () => {
  const slots = computeSlots(
    input({
      weeklyHours: { 1: [{ start: "09:00", end: "12:00" }] },
      from: "2027-01-04T15:00:00Z",
      to: "2027-01-04T16:00:00Z",
    })
  );
  assert.deepEqual(slots, [iso("2027-01-04T15:00Z")]);
});

test("a slot that would straddle midnight is not offered", () => {
  // 2027-01-08 is a Friday.
  const late = (start: string, end: string) =>
    computeSlots(input({ weeklyHours: { 5: [{ start, end }] }, from: "2027-01-05T00:00:00Z", to: "2027-01-10T00:00:00Z" }));
  assert.deepEqual(late("23:30", "24:00"), []);
  assert.deepEqual(late("22:30", "23:59"), [iso("2027-01-09T03:30Z")]);
  assert.deepEqual(late("23:00", "24:00"), [iso("2027-01-09T04:00Z")]);
});

test("a zone west of UTC puts a local Monday evening on Tuesday in UTC", () => {
  const slots = computeSlots(input({ timeZone: "America/Los_Angeles", weeklyHours: { 1: [{ start: "18:00", end: "19:00" }] } }));
  assert.deepEqual(slots, [iso("2027-01-05T02:00Z")]);
});

test("parseWeeklyHours accepts weekdays 0-6 with ordered, non-overlapping HH:MM ranges", () => {
  const ok = parseWeeklyHours({ "1": [{ start: "13:00", end: "17:00" }, { start: "09:00", end: "12:00" }], "6": [], 0: [{ start: "23:00", end: "24:00" }] });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.value["1"], [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }]);
    assert.deepEqual(ok.value["0"], [{ start: "23:00", end: "24:00" }]);
  }
  // Touching ranges are fine.
  assert.ok(parseWeeklyHours({ 2: [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "13:00" }] }).ok);
});

test("parseWeeklyHours refuses bad shapes", () => {
  const bad: unknown[] = [
    null,
    [],
    "x",
    { 7: [] },
    { "-1": [] },
    { mon: [] },
    { 1: [{ start: "9:00", end: "12:00" }] },
    { 1: [{ start: "09:00", end: "25:00" }] },
    { 1: [{ start: "24:00", end: "24:00" }] },
    { 1: [{ start: "12:00", end: "12:00" }] },
    { 1: [{ start: "13:00", end: "12:00" }] },
    { 1: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] },
    { 1: [{ start: "09:60", end: "12:00" }] },
    { 1: { start: "09:00", end: "12:00" } },
    { 1: Array.from({ length: 13 }, (_, i) => ({ start: `${String(i).padStart(2, "0")}:00`, end: `${String(i).padStart(2, "0")}:30` })) },
  ];
  for (const b of bad) assert.equal(parseWeeklyHours(b).ok, false, JSON.stringify(b));
});

test("clampWindow starts no earlier than now, spans at most 14 days and stops at max days ahead", async () => {
  const { clampWindow } = await import("../../src/lib/bookingSlots.js");
  const now = "2027-01-01T00:00:00.000Z";
  assert.deepEqual(clampWindow({ from: "2026-12-01T00:00:00Z", to: "2027-01-03T00:00:00Z", now, maxDaysAhead: 30 }), {
    from: "2027-01-01T00:00:00.000Z",
    to: "2027-01-03T00:00:00.000Z",
  });
  assert.deepEqual(clampWindow({ from: "2027-01-02T00:00:00Z", to: "2027-03-01T00:00:00Z", now, maxDaysAhead: 60 }), {
    from: "2027-01-02T00:00:00.000Z",
    to: "2027-01-16T00:00:00.000Z",
  });
  assert.deepEqual(clampWindow({ from: "2027-01-02T00:00:00Z", to: "2027-01-12T00:00:00Z", now, maxDaysAhead: 5 }), {
    from: "2027-01-02T00:00:00.000Z",
    to: "2027-01-06T00:00:00.000Z",
  });
  assert.equal(clampWindow({ from: "2027-02-01T00:00:00Z", to: "2027-02-03T00:00:00Z", now, maxDaysAhead: 5 }), null);
  assert.equal(clampWindow({ from: "2027-01-03T00:00:00Z", to: "2027-01-02T00:00:00Z", now, maxDaysAhead: 5 }), null);
});
