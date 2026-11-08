import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCalendarFeed, collegeFeedItems, FEED_ID_CHUNK, inChunks, testFeedItems, type FeedKind } from "../../src/lib/calendarFeed.js";

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

/** A stand-in client: every query builder method chains, awaiting answers no rows; records `.in` filters per table. */
function fakeDb() {
  const ins: Array<{ table: string; col: string; ids: string[] }> = [];
  const make = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
          return (...args: unknown[]) => {
            if (prop === "in") ins.push({ table, col: String(args[0]), ids: args[1] as string[] });
            return make(table);
          };
        },
      }
    );
  return { db: { from: (t: string) => make(t) } as never, ins };
}
const q = { from: "2027-01-01", to: "2027-01-31", tz: "UTC", includeDone: true, includeCancelled: false };

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
