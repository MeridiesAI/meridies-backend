import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListSchool } from "../../src/lib/collegesV10.js";
import { fitsForSchools, stampFits } from "../../src/lib/studentListFit.js";

// A student's Reach / Target / Safety tag is the server's, never the student's: the Builder's own rules
// (published admit rate moved by where the student's SAT and unweighted GPA sit, under 15% admitted is a reach for
// anyone) applied to the student's own numbers, always with scores.

const school = (over: Partial<ListSchool> = {}): ListSchool => ({
  collegeId: "c1",
  slug: "c1",
  name: "College One",
  initials: null,
  brandColor: null,
  city: null,
  state: null,
  website: null,
  lat: 0,
  lng: 0,
  undergrads: 10_000,
  setting: null,
  testPolicy: null,
  admit: 50,
  satMid: 1200,
  gpaMid: 3.5,
  needRating: null,
  largestGroupPct: null,
  fields: [],
  regularDeadline: null,
  ...over,
});
const mid = { sat: 1200, gpaUnweighted: 3.5 };

test("a school under 15% admitted is a reach, whatever the student's numbers", () => {
  const fits = fitsForSchools({ sat: 1600, gpaUnweighted: 4 }, [school({ collegeId: "a", admit: 4, satMid: 1500, gpaMid: 3.9 })]);
  assert.equal(fits.get("a"), "reach");
});

test("a school with no published admit rate is a reach: no odds are better than an invented one", () => {
  assert.equal(fitsForSchools(mid, [school({ collegeId: "a", admit: null })]).get("a"), "reach");
});

test("numbers at a school's middle give its published rate: 50% is a target, 80% a safety, 20% a reach", () => {
  const fits = fitsForSchools(mid, [school({ collegeId: "t", admit: 50 }), school({ collegeId: "s", admit: 80 }), school({ collegeId: "r", admit: 20 })]);
  assert.equal(fits.get("t"), "target");
  assert.equal(fits.get("s"), "likely");
  assert.equal(fits.get("r"), "reach");
});

test("the SAT counts: a score far above the school's middle lifts a 40% school to a safety", () => {
  const s = school({ collegeId: "a", admit: 40, satMid: 1100, gpaMid: null });
  assert.equal(fitsForSchools({ sat: null, gpaUnweighted: null }, [s]).get("a"), "target");
  assert.equal(fitsForSchools({ sat: 1500, gpaUnweighted: null }, [s]).get("a"), "likely");
});

test("a student with no numbers on file is read at each school's published rate", () => {
  const none = { sat: null, gpaUnweighted: null };
  assert.equal(fitsForSchools(none, [school({ collegeId: "a", admit: 50 })]).get("a"), "target");
});

test("one answer per school; a school given twice is read once", () => {
  const fits = fitsForSchools(mid, [school({ collegeId: "a" }), school({ collegeId: "a" }), school({ collegeId: "b", admit: 90 })]);
  assert.equal(fits.size, 2);
});

// ---- Writing the tag: one column, on the row the student just added ----

function fakeService(result: { error: unknown } = { error: null }) {
  const calls: { table: string; values: unknown; filters: [string, unknown][] }[] = [];
  const client = {
    from: (table: string) => ({
      update: (values: unknown) => {
        const call = { table, values, filters: [] as [string, unknown][] };
        calls.push(call);
        const b = {
          eq: (col: string, val: unknown) => {
            call.filters.push([col, val]);
            return b;
          },
          then: (resolve: (r: { error: unknown }) => unknown) => resolve(result),
        };
        return b;
      },
    }),
  };
  return { client, calls };
}
const log = () => {
  const warns: string[] = [];
  return { warn: (_o: unknown, msg?: string) => void warns.push(msg ?? ""), warns };
};

test("stampFits sets only fit, on the one row, for that student and only while the student added it", async () => {
  const { client, calls } = fakeService();
  const l = log();
  const n = await stampFits(client as never, {
    studentId: "stu",
    numbers: mid,
    rows: [{ rowId: "row1", school: school({ collegeId: "a", admit: 80 }) }],
    log: l,
  });
  assert.equal(n, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.table, "student_colleges");
  assert.deepEqual(calls[0]!.values, { fit: "likely" });
  assert.deepEqual(calls[0]!.filters, [["id", "row1"], ["student_id", "stu"], ["added_by", "stu"]]);
});

test("stampFits skips a row with no catalog school (a hand-typed one has no odds to read)", async () => {
  const { client, calls } = fakeService();
  const n = await stampFits(client as never, { studentId: "stu", numbers: mid, rows: [{ rowId: "row1", school: null }], log: log() });
  assert.equal(n, 0);
  assert.equal(calls.length, 0);
});

test("stampFits never throws: a failed write leaves the row without a tag and says so", async () => {
  const { client } = fakeService({ error: { code: "XX000", message: "boom" } });
  const l = log();
  const n = await stampFits(client as never, { studentId: "stu", numbers: mid, rows: [{ rowId: "row1", school: school() }], log: l });
  assert.equal(n, 0);
  assert.equal(l.warns.length, 1);
});

test("stampFits with no service client does nothing", async () => {
  const n = await stampFits(null, { studentId: "stu", numbers: mid, rows: [{ rowId: "row1", school: school() }], log: log() });
  assert.equal(n, 0);
});
