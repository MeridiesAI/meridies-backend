import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCalendarFeed, collegeFeedItems, FEED_BATCH_CONCURRENCY, FEED_ID_CHUNK, inChunks, testFeedItems, type FeedKind } from "../../src/lib/calendarFeed.js";
import { resetSeriesReady } from "../../src/lib/seriesSchema.js";

const window = { from: "2027-01-01", to: "2027-01-31" };
const typeOf = (kind: FeedKind) => kind;
const college = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  student_id: "s1",
  name: "Stanford University",
  round: "RD",
  deadline: "2027-01-05",
  custom_deadline: null,
  status: "in-progress",
  ...over,
});

test("a school deadline in the window is one `college:` item, as before", () => {
  const items = collegeFeedItems([college()], window, new Set(), typeOf);
  assert.equal(items.length, 1);
  assert.deepEqual(
    { id: items[0]!.id, kind: items[0]!.kind, ref: items[0]!.ref, type: items[0]!.type, title: items[0]!.title, date: items[0]!.date, detail: items[0]!.detail, school: items[0]!.school },
    { id: "college:c1", kind: "deadline", ref: "c1", type: "deadline", title: "Stanford University application due", date: "2027-01-05", detail: "Regular Decision deadline", school: "Stanford University" }
  );
});

test("the counselor's own date is a second item, `college-custom:`, naming the school's date when different", () => {
  const items = collegeFeedItems([college({ custom_deadline: "2026-12-20", deadline: "2027-01-05" })], { from: "2026-12-01", to: "2027-01-31" }, new Set(), typeOf);
  const custom = items.find((i) => i.id === "college-custom:c1");
  assert.ok(custom, "custom item present");
  assert.equal(custom.kind, "deadline");
  assert.equal(custom.ref, "c1");
  assert.equal(custom.type, "deadline");
  assert.equal(custom.title, "Stanford University: your deadline");
  assert.equal(custom.date, "2026-12-20");
  assert.equal(custom.allDay, true);
  assert.equal(custom.studentId, "s1");
  assert.equal(custom.school, "Stanford University");
  assert.equal(custom.detail, "The school's deadline is Jan 5, 2027");
  assert.ok(items.find((i) => i.id === "college:c1"));
});

test("only the dates inside the window are emitted", () => {
  // The school's date is outside, the custom one inside: only the custom item.
  const a = collegeFeedItems([college({ deadline: "2027-02-10", custom_deadline: "2027-01-20" })], window, new Set(), typeOf);
  assert.deepEqual(a.map((i) => i.id), ["college-custom:c1"]);
  // The other way round.
  const b = collegeFeedItems([college({ deadline: "2027-01-10", custom_deadline: "2026-12-01" })], window, new Set(), typeOf);
  assert.deepEqual(b.map((i) => i.id), ["college:c1"]);
});

test("the same day as the school's has no detail about the school's date", () => {
  const items = collegeFeedItems([college({ custom_deadline: "2027-01-05" })], window, new Set(), typeOf);
  assert.equal(items.find((i) => i.id === "college-custom:c1")?.detail, null);
});

test("a hand-entered deadline with the same school and date hides either item", () => {
  const hand = new Set(["s1|2027-01-20|stanford university"]);
  const items = collegeFeedItems([college({ custom_deadline: "2027-01-20" })], window, hand, typeOf);
  assert.deepEqual(items.map((i) => i.id), ["college:c1"]);
});

test("a submitted school's items are done", () => {
  const items = collegeFeedItems([college({ status: "submitted", custom_deadline: "2027-01-02" })], window, new Set(), typeOf);
  assert.ok(items.length === 2 && items.every((i) => i.done));
});

const academics = (over: Record<string, unknown> = {}) => ({
  student_id: "s1",
  planned_test_date: "2027-01-15",
  test_status: "scheduled",
  ...over,
});

test("a planned test date is a `test:` milestone of pseudo-type test", () => {
  const [item, ...rest] = testFeedItems([academics()], window);
  assert.equal(rest.length, 0);
  assert.ok(item);
  assert.equal(item.id, "test:s1");
  assert.equal(item.kind, "milestone");
  assert.equal(item.ref, "s1");
  assert.equal(item.type, "test");
  assert.equal(item.title, "Planned test date");
  assert.equal(item.date, "2027-01-15");
  assert.equal(item.allDay, true);
  assert.equal(item.startsAt, null);
  assert.equal(item.studentId, "s1");
  assert.equal(item.detail, "Scheduled");
  assert.equal(item.done, false);
  assert.equal(item.personal, undefined);
});

test("tests already taken, test-optional, undated or outside the window are skipped", () => {
  const items = testFeedItems(
    [
      academics({ student_id: "a", test_status: "taken" }),
      academics({ student_id: "b", test_status: "test-optional" }),
      academics({ student_id: "c", planned_test_date: null }),
      academics({ student_id: "d", planned_test_date: "2027-03-01" }),
      academics({ student_id: "e", test_status: null }),
      academics({ student_id: "f", test_status: "retaking" }),
    ],
    window
  );
  assert.deepEqual(items.map((i) => i.id), ["test:e", "test:f"]);
  assert.equal(items[0]!.detail, null);
  assert.equal(items[1]!.detail, "Retaking");
});

// ---- The builder's scope (it also runs under the service role for the iCal feed) ----

/**
 * A stand-in client: every query builder method chains, awaiting answers `rows[table]` (none by default); records `.in`
 * filters per table and every `.select` string. `seriesMissing` makes the series probe (meetings, `series_id`) answer
 * 42703, as a database without 20261129000002 does.
 */
function fakeDb(rows: Record<string, unknown[]> = {}, opts: { seriesMissing?: boolean } = {}) {
  const ins: Array<{ table: string; col: string; ids: string[] }> = [];
  const selects: Array<{ table: string; cols: string }> = [];
  const make = (table: string, cols = ""): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) =>
              resolve(
                opts.seriesMissing && table === "meetings" && cols === "series_id"
                  ? { data: null, error: { code: "42703", message: "column meetings.series_id does not exist" } }
                  : { data: rows[table] ?? [], error: null }
              );
          }
          return (...args: unknown[]) => {
            if (prop === "in") ins.push({ table, col: String(args[0]), ids: args[1] as string[] });
            if (prop === "select") {
              selects.push({ table, cols: String(args[0]) });
              return make(table, String(args[0]));
            }
            return make(table, cols);
          };
        },
      }
    );
  return { db: { from: (t: string) => make(t) } as never, ins, selects };
}
const q = { from: "2027-01-01", to: "2027-01-31", tz: "UTC", includeDone: true, includeCancelled: false };

test("a practice event is marked, a meeting is not", async () => {
  const { db } = fakeDb({
    calendar_events: [
      { id: "p1", title: "Office hours", on_date: "2027-01-12", starts_at: null, ends_at: null, student_id: null, detail: null, type_id: null },
      { id: "p2", title: "Parent call", on_date: "2027-01-13", starts_at: "2027-01-13T15:00:00Z", ends_at: "2027-01-13T15:30:00Z", student_id: "s1", detail: null, type_id: null },
    ],
    meetings: [{ id: "m1", student_id: "s1", counselor_id: "c1", title: "Check-in", starts_at: "2027-01-10T15:00:00Z", ends_at: null, status: "scheduled" }],
  });
  const { items } = await buildCalendarFeed({ db, ownerId: "c1", role: "counselor", caseload: [] }, q);
  const allDay = items.find((i) => i.id === "milestone:p1");
  assert.equal(allDay?.practice, true);
  assert.equal(allDay?.allDay, true);
  assert.equal(allDay?.startsAt, null);
  const timed = items.find((i) => i.id === "milestone:p2");
  assert.equal(timed?.practice, true);
  assert.equal(timed?.allDay, false);
  assert.equal(timed?.startsAt, "2027-01-13T15:00:00Z");
  assert.equal(timed?.endsAt, "2027-01-13T15:30:00Z");
  const meeting = items.find((i) => i.id === "meeting:m1");
  assert.ok(meeting);
  assert.equal("practice" in meeting, false);
});

// ---- Repeating events (20261129000002): the feed names series_id only once the column exists ----

const seriesRows = {
  calendar_events: [
    { id: "p1", title: "Office hours", on_date: "2027-01-12", starts_at: null, ends_at: null, student_id: null, detail: null, type_id: null, series_id: "ser-p" },
    { id: "p2", title: "Parent call", on_date: "2027-01-13", starts_at: "2027-01-13T15:00:00Z", ends_at: "2027-01-13T15:30:00Z", student_id: null, detail: null, type_id: null, series_id: null },
  ],
  meetings: [
    { id: "m1", student_id: "s1", counselor_id: "c1", title: "Check-in", starts_at: "2027-01-10T15:00:00Z", ends_at: null, status: "scheduled", series_id: "ser-m" },
    { id: "m2", student_id: "s1", counselor_id: "c1", title: "One-off", starts_at: "2027-01-11T15:00:00Z", ends_at: null, status: "scheduled", series_id: null },
  ],
};
const feedSelect = (selects: Array<{ table: string; cols: string }>, table: string) =>
  selects.filter((s) => s.table === table && s.cols !== "series_id").map((s) => s.cols);

test("with the series column in, the meeting select names series_id and each item carries seriesId", async () => {
  resetSeriesReady();
  const { db, selects } = fakeDb(seriesRows);
  const { items } = await buildCalendarFeed({ db, ownerId: "c1", role: "counselor", caseload: [] }, q);
  const cols = feedSelect(selects, "meetings");
  assert.equal(cols.length, 1);
  assert.match(cols[0]!, /\bseries_id\b/);
  const by = new Map(items.map((i) => [i.id, i]));
  assert.equal(by.get("meeting:m1")?.seriesId, "ser-m");
  assert.equal(by.get("meeting:m2")?.seriesId, null);
  assert.equal(by.get("milestone:p1")?.seriesId, "ser-p");
  assert.equal(by.get("milestone:p2")?.seriesId, null);
  resetSeriesReady();
});

test("without the series column the meeting select never names series_id and no item carries seriesId", async () => {
  resetSeriesReady();
  const { db, selects } = fakeDb(seriesRows, { seriesMissing: true });
  const { items } = await buildCalendarFeed({ db, ownerId: "c1", role: "counselor", caseload: [] }, q);
  const cols = feedSelect(selects, "meetings");
  assert.equal(cols.length, 1);
  assert.doesNotMatch(cols[0]!, /series_id/);
  assert.ok(items.some((i) => i.id === "meeting:m1"), "the feed still answers");
  const meetings = items.filter((i) => i.kind === "meeting");
  assert.equal(meetings.length, 2);
  assert.ok(meetings.every((i) => !("seriesId" in i)), "a meeting row has no seriesId key before the migration");
  // A practice event reads `select *`, so it carries seriesId only when its row has the key (an older database's has none).
  const older = fakeDb({ ...seriesRows, calendar_events: [{ id: "p3", title: "Old", on_date: "2027-01-14", starts_at: null, ends_at: null, student_id: null, detail: null, type_id: null }] }, { seriesMissing: true });
  resetSeriesReady();
  const out = await buildCalendarFeed({ db: older.db, ownerId: "c1", role: "counselor", caseload: [] }, q);
  assert.equal("seriesId" in out.items.find((i) => i.id === "milestone:p3")!, false);
  resetSeriesReady();
});

test("inChunks splits a list into batches", () => {
  assert.deepEqual(inChunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(inChunks([], 2), []);
});

test("a counselor's whole calendar without a caseload is refused, never run unscoped", async () => {
  const { db, ins } = fakeDb();
  await assert.rejects(buildCalendarFeed({ db, ownerId: "c1", role: "counselor" }, q), /caseload/i);
  assert.equal(ins.length, 0);
});

test("a big caseload is read in batches, every student-spanning read named", async () => {
  const { db, ins } = fakeDb();
  const caseload = Array.from({ length: FEED_ID_CHUNK * 2 + 5 }, (_, i) => `s${i}`);
  const out = await buildCalendarFeed({ db, ownerId: "c1", role: "counselor", caseload }, q);
  assert.deepEqual(out.items, []);
  for (const table of ["deadlines", "deliverables", "student_colleges", "student_academics"]) {
    const batches = ins.filter((x) => x.table === table && x.col === "student_id");
    assert.equal(batches.length, 3, table);
    assert.deepEqual(batches.flatMap((b) => b.ids), caseload, table);
    assert.ok(batches.every((b) => b.ids.length <= FEED_ID_CHUNK), table);
  }
});

test("an empty caseload reads nothing student-spanning", async () => {
  const { db, ins } = fakeDb();
  await buildCalendarFeed({ db, ownerId: "c1", role: "counselor", caseload: [] }, q);
  assert.equal(ins.filter((x) => ["deadlines", "deliverables", "student_colleges", "student_academics"].includes(x.table)).length, 0);
});

/** A stand-in that answers each batch read a tick later, with one deadline row per student, counting reads in flight. */
function slowDb() {
  const SPANNING = new Set(["deadlines", "deliverables", "student_colleges", "student_academics"]);
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const make = (table: string, ids: string[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => {
              if (!SPANNING.has(table)) return resolve({ data: [], error: null });
              reads++;
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
              setTimeout(() => {
                inFlight--;
                const data =
                  table === "deadlines"
                    ? ids.map((id) => ({ id: `d-${id}`, student_id: id, title: `D ${id}`, due_date: "2027-01-10", done: false }))
                    : [];
                resolve({ data, error: null });
              }, 2);
            };
          }
          return (...args: unknown[]) => make(table, prop === "in" && args[0] === "student_id" ? (args[1] as string[]) : ids);
        },
      }
    );
  return { db: { from: (t: string) => make(t, []) } as never, stats: () => ({ maxInFlight, reads }) };
}

test("a big caseload's batch reads are bounded in flight, and the answer is the same", async () => {
  const { db, stats } = slowDb();
  const caseload = Array.from({ length: FEED_ID_CHUNK * 10 }, (_, i) => `s${String(i).padStart(5, "0")}`);
  const out = await buildCalendarFeed({ db, ownerId: "c1", role: "counselor", caseload }, q);
  assert.equal(stats().reads, 40, "10 batches for each of the 4 tables");
  assert.ok(stats().maxInFlight <= FEED_BATCH_CONCURRENCY, `max in flight ${stats().maxInFlight}`);
  assert.ok(FEED_BATCH_CONCURRENCY >= 1 && FEED_BATCH_CONCURRENCY <= 4);
  // Every student's deadline, once, in caseload order (all on one day, sorted by title).
  assert.deepEqual(out.items.map((i) => i.studentId), caseload);
});
