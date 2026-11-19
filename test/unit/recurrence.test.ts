// Repeating meetings/events: the date maths (lib/recurrence.ts). Pure: no database, no network.
// 2026-11-24 is a Tuesday. America/New_York is EDT (-4) until Sun 2026-11-01 02:00, then EST (-5);
// it springs forward on Sun 2026-03-08 (02:00 -> 03:00).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SERIES,
  MAX_SERIES_WITH_LINKS,
  MAX_SPAN_DAYS,
  expandSeriesDates,
  repeatLabel,
  shiftInstant,
  wallDelta,
  zonedInstant,
  type RepeatSpec,
} from "../../src/lib/recurrence.js";

const NY = "America/New_York";

test("the limits are exported", () => {
  assert.equal(MAX_SERIES, 52);
  assert.equal(MAX_SERIES_WITH_LINKS, 12);
  assert.equal(MAX_SPAN_DAYS, 366);
});

// --- expandSeriesDates ---

test("weekly count 4", () => {
  assert.deepEqual(expandSeriesDates("2026-11-24", { preset: "weekly", end: { count: 4 } }), [
    "2026-11-24",
    "2026-12-01",
    "2026-12-08",
    "2026-12-15",
  ]);
});

test("biweekly count 3", () => {
  assert.deepEqual(expandSeriesDates("2026-11-24", { preset: "biweekly", end: { count: 3 } }), [
    "2026-11-24",
    "2026-12-08",
    "2026-12-22",
  ]);
});

test("daily until the 27th from the 25th is three dates (until is inclusive)", () => {
  assert.deepEqual(expandSeriesDates("2026-11-25", { preset: "daily", end: { until: "2026-11-27" } }), [
    "2026-11-25",
    "2026-11-26",
    "2026-11-27",
  ]);
});

test("weekly until stops at the last matching date on or before until", () => {
  assert.deepEqual(expandSeriesDates("2026-11-24", { preset: "weekly", end: { until: "2026-12-14" } }), [
    "2026-11-24",
    "2026-12-01",
    "2026-12-08",
  ]);
  assert.deepEqual(expandSeriesDates("2026-11-24", { preset: "weekly", end: { until: "2026-12-15" } }), [
    "2026-11-24",
    "2026-12-01",
    "2026-12-08",
    "2026-12-15",
  ]);
});

test("weekdays count 5 from a Friday skips the weekend", () => {
  assert.deepEqual(expandSeriesDates("2026-11-20", { preset: "weekdays", end: { count: 5 } }), [
    "2026-11-20",
    "2026-11-23",
    "2026-11-24",
    "2026-11-25",
    "2026-11-26",
  ]);
});

test("weekdays from a Saturday begins the next Monday", () => {
  assert.deepEqual(expandSeriesDates("2026-11-21", { preset: "weekdays", end: { count: 2 } }), [
    "2026-11-23",
    "2026-11-24",
  ]);
});

test("weekdays from a Sunday begins the next Monday", () => {
  assert.deepEqual(expandSeriesDates("2026-11-22", { preset: "weekdays", end: { count: 2 } }), [
    "2026-11-23",
    "2026-11-24",
  ]);
});

test("weekdays until skips weekends inside the range", () => {
  assert.deepEqual(expandSeriesDates("2026-11-26", { preset: "weekdays", end: { until: "2026-11-30" } }), [
    "2026-11-26",
    "2026-11-27",
    "2026-11-30",
  ]);
});

test("monthly keeps the start's day, clamped to short months, from the ORIGINAL start", () => {
  assert.deepEqual(expandSeriesDates("2026-01-31", { preset: "monthly", end: { count: 4 } }), [
    "2026-01-31",
    "2026-02-28",
    "2026-03-31",
    "2026-04-30",
  ]);
});

test("monthly clamps February to the 29th in a leap year", () => {
  assert.deepEqual(expandSeriesDates("2028-01-31", { preset: "monthly", end: { count: 3 } }), [
    "2028-01-31",
    "2028-02-29",
    "2028-03-31",
  ]);
});

test("monthly rolls over the year", () => {
  assert.deepEqual(expandSeriesDates("2026-11-30", { preset: "monthly", end: { count: 4 } }), [
    "2026-11-30",
    "2026-12-30",
    "2027-01-30",
    "2027-02-28",
  ]);
});

test("monthly until", () => {
  assert.deepEqual(expandSeriesDates("2026-11-15", { preset: "monthly", end: { until: "2027-01-14" } }), [
    "2026-11-15",
    "2026-12-15",
  ]);
});

test("the biggest allowed series works: 52 weekly meetings span 357 days", () => {
  const dates = expandSeriesDates("2026-11-24", { preset: "weekly", end: { count: 52 } });
  assert.equal(dates.length, 52);
  assert.equal(dates[51], "2027-11-16");
});

test("max can be raised or lowered by the caller", () => {
  const twelve = expandSeriesDates("2026-11-24", { preset: "weekly", end: { count: 12 } }, MAX_SERIES_WITH_LINKS);
  assert.equal(twelve.length, 12);
  const sixty = expandSeriesDates("2026-11-24", { preset: "daily", end: { count: 60 } }, 60);
  assert.equal(sixty.length, 60);
});

test("every limit is a RangeError with words, never a silent cut", () => {
  const weekly = (end: RepeatSpec["end"]): RepeatSpec => ({ preset: "weekly", end });
  assert.throws(() => expandSeriesDates("2026-11-24", weekly({ count: 1 })), {
    name: "RangeError",
    message: "A repeating series needs at least 2 meetings.",
  });
  assert.throws(() => expandSeriesDates("2026-11-24", weekly({ count: 0 })), RangeError);
  assert.throws(() => expandSeriesDates("2026-11-24", weekly({ count: -3 })), RangeError);
  assert.throws(() => expandSeriesDates("2026-11-24", weekly({ count: 53 })), {
    name: "RangeError",
    message: "A series can have at most 52 meetings.",
  });
  assert.throws(() => expandSeriesDates("2026-11-24", weekly({ count: 13 }), 12), {
    name: "RangeError",
    message: "A series can have at most 12 meetings.",
  });
  assert.throws(() => expandSeriesDates("2026-11-24", weekly({ count: 2.5 })), {
    name: "RangeError",
    message: "The number of meetings must be a whole number.",
  });
  assert.throws(() => expandSeriesDates("2026-11-24", weekly({ count: Number.NaN })), RangeError);
});

test("until: before the start, too far out, or too few dates", () => {
  const weekly = (until: string): RepeatSpec => ({ preset: "weekly", end: { until } });
  assert.throws(() => expandSeriesDates("2026-11-24", weekly("2026-11-23")), {
    name: "RangeError",
    message: "The end date can't be before the start date.",
  });
  // 400 days out.
  assert.throws(() => expandSeriesDates("2026-11-24", weekly("2027-12-29")), {
    name: "RangeError",
    message: "A series can run for at most 366 days.",
  });
  // The start itself only: one meeting is not a series.
  assert.throws(() => expandSeriesDates("2026-11-24", weekly("2026-11-24")), {
    name: "RangeError",
    message: "That end date leaves fewer than 2 meetings in the series.",
  });
  assert.throws(() => expandSeriesDates("2026-11-24", weekly("2026-11-30")), RangeError);
  // Daily for a year is 367 meetings, far over the cap: the message says how many.
  assert.throws(() => expandSeriesDates("2026-11-24", { preset: "daily", end: { until: "2027-11-25" } }), {
    name: "RangeError",
    message: "That end date makes 367 meetings; a series can have at most 52.",
  });
});

test("the span limit is 366 days, inclusive, for until and for count", () => {
  // Exactly 366 days out passes (with room for the 53 weekly dates), 367 does not.
  const ok = expandSeriesDates("2026-11-24", { preset: "weekly", end: { until: "2027-11-25" } }, 100);
  assert.equal(ok.length, 53);
  assert.throws(
    () => expandSeriesDates("2026-11-24", { preset: "weekly", end: { until: "2027-11-26" } }, 100),
    { name: "RangeError", message: "A series can run for at most 366 days." },
  );
  // A count that reaches past a year is refused too: 52 biweekly meetings would run two years.
  assert.throws(() => expandSeriesDates("2026-11-24", { preset: "biweekly", end: { count: 52 } }), {
    name: "RangeError",
    message: "A series can run for at most 366 days.",
  });
  // 14 monthly meetings from the 31st end 13 months later.
  assert.throws(() => expandSeriesDates("2026-01-31", { preset: "monthly", end: { count: 14 } }), RangeError);
  assert.equal(expandSeriesDates("2026-01-31", { preset: "monthly", end: { count: 13 } }).length, 13);
});

test("a bad start date is a RangeError", () => {
  const spec: RepeatSpec = { preset: "weekly", end: { count: 2 } };
  for (const bad of ["", "2026-13-01", "2026-02-30", "11/24/2026", "2026-11-24T10:00:00Z"]) {
    assert.throws(() => expandSeriesDates(bad, spec), {
      name: "RangeError",
      message: "The start date must be a real date (YYYY-MM-DD).",
    });
  }
  assert.throws(() => expandSeriesDates("2026-11-24", { preset: "weekly", end: { until: "soon" } }), {
    name: "RangeError",
    message: "The end date must be a real date (YYYY-MM-DD).",
  });
});

// --- zonedInstant ---

test("zonedInstant: 9:00 AM wall-clock on either side of the fall-back", () => {
  assert.equal(zonedInstant("2026-11-01", 540, NY), "2026-11-01T14:00:00.000Z");
  assert.equal(zonedInstant("2026-10-31", 540, NY), "2026-10-31T13:00:00.000Z");
});

test("zonedInstant: a wall time in the spring-forward gap moves forward", () => {
  assert.equal(zonedInstant("2026-03-08", 150, NY), "2026-03-08T07:30:00.000Z"); // 02:30 -> 03:30 EDT
  assert.equal(zonedInstant("2026-03-08", 120, NY), "2026-03-08T07:00:00.000Z"); // 02:00 -> 03:00 EDT
  assert.equal(zonedInstant("2026-03-08", 180, NY), "2026-03-08T07:00:00.000Z"); // 03:00 EDT is real
  assert.equal(zonedInstant("2026-03-08", 60, NY), "2026-03-08T06:00:00.000Z"); // 01:00 EST
});

test("zonedInstant: an ambiguous fall-back wall time is its first occurrence", () => {
  assert.equal(zonedInstant("2026-11-01", 90, NY), "2026-11-01T05:30:00.000Z"); // 01:30 EDT, not EST
});

test("zonedInstant: other zones, including east of UTC, without DST and UTC itself", () => {
  assert.equal(zonedInstant("2026-11-01", 540, "Asia/Kolkata"), "2026-11-01T03:30:00.000Z");
  assert.equal(zonedInstant("2026-11-01", 540, "UTC"), "2026-11-01T09:00:00.000Z");
  assert.equal(zonedInstant("2026-03-29", 90, "Europe/London"), "2026-03-29T01:30:00.000Z"); // 01:30 never happens: 02:30 BST
  assert.equal(zonedInstant("2026-07-01", 540, "Pacific/Auckland"), "2026-06-30T21:00:00.000Z");
});

test("zonedInstant: minutes past a day roll into the next day, negative into the one before", () => {
  assert.equal(zonedInstant("2026-10-31", 1440 + 540, NY), "2026-11-01T14:00:00.000Z"); // Nov 1 09:00 EST
  assert.equal(zonedInstant("2026-11-01", -60, NY), "2026-11-01T03:00:00.000Z"); // Oct 31 23:00 EDT
});

test("zonedInstant: an unknown time zone is a RangeError", () => {
  assert.throws(() => zonedInstant("2026-11-01", 540, "Not/AZone"), RangeError);
});

// --- shiftInstant ---

test("shiftInstant keeps the wall-clock time across the fall-back", () => {
  assert.equal(
    shiftInstant("2026-10-27T13:00:00.000Z", { days: 7, minutes: 0 }, NY),
    "2026-11-03T14:00:00.000Z",
  );
});

test("shiftInstant keeps the wall-clock time across the spring-forward", () => {
  // Sun 2026-03-01 09:00 EST + 7 days = Sun 2026-03-08 09:00 EDT.
  assert.equal(
    shiftInstant("2026-03-01T14:00:00.000Z", { days: 7, minutes: 0 }, NY),
    "2026-03-08T13:00:00.000Z",
  );
});

test("shiftInstant adds wall-clock minutes", () => {
  assert.equal(
    shiftInstant("2026-10-27T13:00:00.000Z", { days: 0, minutes: 60 }, NY),
    "2026-10-27T14:00:00.000Z",
  );
  // 00:30 EDT on the fall-back day + 120 wall minutes is 02:30, which is EST (the clock reads 2:30 once).
  assert.equal(
    shiftInstant("2026-11-01T04:30:00.000Z", { days: 0, minutes: 120 }, NY),
    "2026-11-01T07:30:00.000Z",
  );
});

test("shiftInstant goes backwards, over month and year ends, and by nothing", () => {
  assert.equal(
    shiftInstant("2026-11-03T14:00:00.000Z", { days: -7, minutes: 0 }, NY),
    "2026-10-27T13:00:00.000Z",
  );
  assert.equal(
    shiftInstant("2026-12-31T15:00:00.000Z", { days: 1, minutes: 0 }, NY),
    "2027-01-01T15:00:00.000Z",
  );
  assert.equal(
    shiftInstant("2026-10-27T13:00:00.000Z", { days: 0, minutes: 0 }, NY),
    "2026-10-27T13:00:00.000Z",
  );
  assert.equal(
    shiftInstant("2026-10-27T13:00:00.000Z", { days: 0, minutes: -90 }, NY),
    "2026-10-27T11:30:00.000Z",
  );
});

// --- wallDelta ---

test("wallDelta reads the difference on the wall clock, not in elapsed time", () => {
  assert.deepEqual(wallDelta("2026-10-27T13:00:00.000Z", "2026-11-03T14:00:00.000Z", NY), {
    days: 7,
    minutes: 0,
  });
});

test("wallDelta: zero, negative, and a time-of-day move", () => {
  const a = "2026-10-27T13:00:00.000Z";
  assert.deepEqual(wallDelta(a, a, NY), { days: 0, minutes: 0 });
  assert.deepEqual(wallDelta("2026-11-03T14:00:00.000Z", a, NY), { days: -7, minutes: 0 });
  assert.deepEqual(wallDelta(a, "2026-10-27T14:15:00.000Z", NY), { days: 0, minutes: 75 });
  assert.deepEqual(wallDelta("2026-10-27T14:15:00.000Z", a, NY), { days: 0, minutes: -75 });
  // 9:00 on the 27th to 8:00 on the 28th.
  assert.deepEqual(wallDelta(a, "2026-10-28T12:00:00.000Z", NY), { days: 1, minutes: -60 });
});

test("wallDelta uses the zone's day, not UTC's", () => {
  // 23:00 EST on Nov 2 is 04:00Z on Nov 3: the same wall day as 09:00 EST on Nov 2.
  assert.deepEqual(wallDelta("2026-11-02T14:00:00.000Z", "2026-11-03T04:00:00.000Z", NY), {
    days: 0,
    minutes: 840,
  });
});

test("shiftInstant(a, wallDelta(a, b)) gives back b", () => {
  const pairs: Array<[string, string]> = [
    ["2026-10-27T13:00:00.000Z", "2026-11-03T14:00:00.000Z"],
    ["2026-11-03T14:00:00.000Z", "2026-10-27T13:00:00.000Z"],
    ["2026-03-01T14:00:00.000Z", "2026-03-08T13:00:00.000Z"],
    ["2026-10-27T13:00:00.000Z", "2026-10-28T12:00:00.000Z"],
    ["2026-12-31T15:00:00.000Z", "2027-02-01T20:45:00.000Z"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(shiftInstant(a, wallDelta(a, b, NY), NY), b);
  }
});

// --- repeatLabel ---

test("repeatLabel names the cadence, the start's weekday and the end", () => {
  assert.equal(repeatLabel({ preset: "weekly", end: { count: 10 } }, "2026-11-24"), "Weekly on Tuesday, 10 times");
  assert.equal(
    repeatLabel({ preset: "biweekly", end: { until: "2026-12-22" } }, "2026-11-24"),
    "Every 2 weeks on Tuesday until Dec 22",
  );
  assert.equal(repeatLabel({ preset: "daily", end: { count: 5 } }, "2026-11-24"), "Daily, 5 times");
  assert.equal(repeatLabel({ preset: "weekdays", end: { until: "2026-12-04" } }, "2026-11-24"), "Every weekday until Dec 4");
});

test("repeatLabel: monthly uses the start's day with an ordinal", () => {
  assert.equal(repeatLabel({ preset: "monthly", end: { count: 4 } }, "2026-01-31"), "Monthly on the 31st, 4 times");
  const day = (d: number) => repeatLabel({ preset: "monthly", end: { count: 2 } }, `2026-03-${String(d).padStart(2, "0")}`);
  assert.equal(day(1), "Monthly on the 1st, 2 times");
  assert.equal(day(2), "Monthly on the 2nd, 2 times");
  assert.equal(day(3), "Monthly on the 3rd, 2 times");
  assert.equal(day(4), "Monthly on the 4th, 2 times");
  assert.equal(day(11), "Monthly on the 11th, 2 times");
  assert.equal(day(12), "Monthly on the 12th, 2 times");
  assert.equal(day(13), "Monthly on the 13th, 2 times");
  assert.equal(day(21), "Monthly on the 21st, 2 times");
  assert.equal(day(22), "Monthly on the 22nd, 2 times");
  assert.equal(day(23), "Monthly on the 23rd, 2 times");
});

test("repeatLabel: the year of an until date shows only when it differs from the start's", () => {
  assert.equal(
    repeatLabel({ preset: "weekly", end: { until: "2027-01-26" } }, "2026-11-24"),
    "Weekly on Tuesday until Jan 26, 2027",
  );
});

test("an unknown preset is a RangeError, not a loop", () => {
  assert.throws(
    () => expandSeriesDates("2026-11-24", { preset: "hourly" as never, end: { until: "2026-12-01" } }),
    { name: "RangeError", message: "Choose how often the series repeats." },
  );
});
