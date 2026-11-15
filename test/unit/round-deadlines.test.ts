import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MISSING_TABLE_TTL_MS,
  deadlineAfterRoundChange,
  knownDate,
  loadOfficialDeadlines,
  resetOfficialDeadlineCache,
  type RoundDates,
} from "../../src/lib/officialDeadlines.js";
import { catalogDeadline, toEssayCollege } from "../../src/lib/studentApplication.js";

const CYCLE = "2026-2027";
const COLLEGE = "11111111-1111-4111-8111-111111111111";

/** Dates for one school: the official rows this cycle, by round, and the catalog's curated summary. */
const dates = (official: Record<string, string>, curated: Record<string, string> = {}): RoundDates => ({
  official: new Map(Object.entries(official)),
  curated,
  cycle: CYCLE,
});

// ---- catalogDeadline: the curated summary ("Nov 1") as a date in the cycle -----------------------------

test("catalogDeadline: a curated 'Nov 1' falls in the cycle's first year, 'Jan 5' in its second", () => {
  const curated = { "Early Decision I": "Nov 1", "Early Decision II": "Jan 1", "Regular Decision": "Jan 5" };
  assert.equal(catalogDeadline(curated, "ED", CYCLE), "2026-11-01");
  assert.equal(catalogDeadline(curated, "ED2", CYCLE), "2027-01-01");
  assert.equal(catalogDeadline(curated, "RD", CYCLE), "2027-01-05");
  assert.equal(catalogDeadline(curated, null, CYCLE), "2027-01-05", "no round reads as Regular Decision");
  assert.equal(catalogDeadline(curated, "EA", CYCLE), null, "a round the school doesn't list has no date");
  assert.equal(catalogDeadline({ "Regular Action": "Jan 1" }, "RD", CYCLE), "2027-01-01");
  assert.equal(catalogDeadline({ "Regular Decision": "early January" }, "RD", CYCLE), null, "words that aren't a date");
  assert.equal(catalogDeadline(null, "RD", CYCLE), null);
});

// ---- knownDate: official first, then the curated summary -----------------------------------------------

test("knownDate: the official date for the round wins over the curated one", () => {
  const d = dates({ ED: "2026-11-04", RD: "2027-01-03" }, { "Early Decision": "Nov 1", "Regular Decision": "Jan 5" });
  assert.equal(knownDate(d, "ED"), "2026-11-04");
  assert.equal(knownDate(d, "RD"), "2027-01-03");
});

test("knownDate: a round with no official row falls back to the curated summary, then to nothing", () => {
  const d = dates({ ED: "2026-11-04" }, { "Early Action": "Nov 15", "Regular Decision": "Jan 5" });
  assert.equal(knownDate(d, "EA"), "2026-11-15");
  assert.equal(knownDate(d, "RD"), "2027-01-05");
  assert.equal(knownDate(d, "REA"), null);
  assert.equal(knownDate(d, "rolling"), null);
  assert.equal(knownDate(d, null), "2027-01-05", "no round reads as Regular Decision, as catalogDeadline does");
});

// ---- deadlineAfterRoundChange: the date belongs to the round -------------------------------------------

test("a round change fills the new round's official date", () => {
  const d = dates({ ED: "2026-11-01", RD: "2027-01-02" });
  assert.equal(deadlineAfterRoundChange("2027-01-02", "RD", "ED", d), "2026-11-01");
  assert.equal(deadlineAfterRoundChange(null, "RD", "ED", d), "2026-11-01", "an empty date fills too");
});

test("the new round's known date replaces a date typed by hand for the old round", () => {
  // Typed for RD (the school had no RD date on file), then the round became ED, which has one.
  const d = dates({ ED: "2026-11-01" });
  assert.equal(deadlineAfterRoundChange("2027-01-09", "RD", "ED", d), "2026-11-01");
});

test("with no date known for the new round, the old round's filled-in date is cleared", () => {
  const d = dates({ ED: "2026-11-01" }, { "Regular Decision": "Jan 5" });
  assert.equal(deadlineAfterRoundChange("2026-11-01", "ED", "EA", d), null, "the official ED date");
  assert.equal(deadlineAfterRoundChange("2027-01-05", "RD", "EA", d), null, "the curated RD date");
});

test("a date filled from the curated summary before the official row existed still counts as filled in", () => {
  const d = dates({ RD: "2027-01-03" }, { "Regular Decision": "Jan 5" });
  assert.equal(deadlineAfterRoundChange("2027-01-05", "RD", "rolling", d), null);
});

test("with no date known for the new round, a date typed by hand stays (it may be the new round's)", () => {
  const d = dates({ RD: "2027-01-02" });
  // Typed Nov 3 first, then picked EA, which nothing on file dates.
  assert.equal(deadlineAfterRoundChange("2026-11-03", "RD", "EA", d), undefined);
  assert.equal(deadlineAfterRoundChange(null, "RD", "EA", d), undefined, "nothing to fill, nothing to clear");
});

test("picking the round the row already has only fills an empty date", () => {
  const d = dates({ ED: "2026-11-01" });
  assert.equal(deadlineAfterRoundChange(null, "ED", "ED", d), "2026-11-01");
  assert.equal(deadlineAfterRoundChange("2026-10-28", "ED", "ED", d), undefined, "a typed date for this round stands");
  assert.equal(deadlineAfterRoundChange("2026-11-01", "ED", "ED", d), undefined);
});

test("no write when the date already is the new round's", () => {
  const d = dates({ ED: "2026-11-01", EA: "2026-11-01" });
  assert.equal(deadlineAfterRoundChange("2026-11-01", "ED", "EA", d), undefined);
});

test("clearing the round reads the dates as Regular Decision's", () => {
  const d = dates({ ED: "2026-11-01", RD: "2027-01-02" });
  assert.equal(deadlineAfterRoundChange("2026-11-01", "ED", null, d), "2027-01-02");
  assert.equal(deadlineAfterRoundChange("2027-01-02", null, "ED", d), "2026-11-01");
});

// ---- loadOfficialDeadlines: one school's rows this cycle, never failing the request ---------------------

type Answer = { data: unknown; error: { code?: string; message: string } | null } | Error;

/** Just enough of supabase-js: from(t).select(c).eq(a, x).eq(b, y), answering in turn. */
function fakeDb(answers: Answer[]) {
  const calls: { table: string; columns: string; filters: [string, unknown][] }[] = [];
  const db = {
    from: (table: string) => ({
      select: (columns: string) => {
        const call = { table, columns, filters: [] as [string, unknown][] };
        calls.push(call);
        const chain = {
          eq: (col: string, value: unknown) => {
            call.filters.push([col, value]);
            return call.filters.length < 2 ? chain : answer();
          },
        };
        return chain;
      },
    }),
  };
  function answer() {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
  return { db: db as never, calls };
}

const quiet = () => {
  const warned: object[] = [];
  return { warned, log: { warn: (o: object) => void warned.push(o) } };
};

test("loadOfficialDeadlines reads one school's rows for the cycle, by round", async () => {
  resetOfficialDeadlineCache();
  const { db, calls } = fakeDb([
    {
      data: [
        { round: "ED", deadline: "2026-11-01" },
        { round: "RD", deadline: "2027-01-02" },
        { round: "EA", deadline: "Nov 15" },
        { round: null, deadline: "2026-11-15" },
      ],
      error: null,
    },
  ]);
  const got = await loadOfficialDeadlines(db, COLLEGE, CYCLE);
  assert.deepEqual([...got.entries()], [
    ["ED", "2026-11-01"],
    ["RD", "2027-01-02"],
  ], "a row that isn't a round and an ISO date is left out");
  assert.equal(calls[0]!.table, "college_round_deadlines");
  assert.deepEqual(calls[0]!.filters, [
    ["college_id", COLLEGE],
    ["admission_cycle", CYCLE],
  ]);
});

test("loadOfficialDeadlines: a school typed in by hand (no catalog id) reads nothing", async () => {
  resetOfficialDeadlineCache();
  const { db, calls } = fakeDb([{ data: [], error: null }]);
  assert.equal((await loadOfficialDeadlines(db, null, CYCLE)).size, 0);
  assert.equal(calls.length, 0);
});

test("loadOfficialDeadlines: before the migration it answers no dates, quietly, and stops asking for five minutes", async () => {
  resetOfficialDeadlineCache();
  const { warned, log } = quiet();
  const { db, calls } = fakeDb([
    { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.college_round_deadlines'" } },
    { data: [{ round: "ED", deadline: "2026-11-01" }], error: null },
  ]);
  const t0 = 1_000_000;
  assert.equal((await loadOfficialDeadlines(db, COLLEGE, CYCLE, log, t0)).size, 0);
  assert.equal(warned.length, 0, "an unapplied migration is expected, not a warning");
  assert.equal((await loadOfficialDeadlines(db, COLLEGE, CYCLE, log, t0 + MISSING_TABLE_TTL_MS - 1)).size, 0);
  assert.equal(calls.length, 1, "no second read inside the five minutes");
  const after = await loadOfficialDeadlines(db, COLLEGE, CYCLE, log, t0 + MISSING_TABLE_TTL_MS);
  assert.equal(after.get("ED"), "2026-11-01", "asks again once the five minutes are up");
  resetOfficialDeadlineCache();
});

test("loadOfficialDeadlines: any other failure answers no dates and is logged, and the next read tries again", async () => {
  resetOfficialDeadlineCache();
  const { warned, log } = quiet();
  const { db, calls } = fakeDb([
    { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
    new Error("fetch failed"),
    { data: [{ round: "RD", deadline: "2027-01-02" }], error: null },
  ]);
  assert.equal((await loadOfficialDeadlines(db, COLLEGE, CYCLE, log)).size, 0);
  assert.equal((await loadOfficialDeadlines(db, COLLEGE, CYCLE, log)).size, 0, "a thrown error too");
  assert.equal(warned.length, 2);
  assert.equal((await loadOfficialDeadlines(db, COLLEGE, CYCLE, log)).get("RD"), "2027-01-02");
  assert.equal(calls.length, 3);
});

// ---- the Essays section's schools ----------------------------------------------------------------------

test("toEssayCollege carries the round, the school's date and where the application stands", () => {
  const row = {
    id: "row-1",
    college_id: COLLEGE,
    name: "Duke University",
    initials: "DU",
    brand_color: "#012169",
    round: "ED",
    deadline: "2026-11-01",
    custom_deadline: "2026-10-25",
    status: "in-progress",
    notes: "private",
  };
  assert.deepEqual(toEssayCollege(row), {
    id: "row-1",
    collegeId: COLLEGE,
    name: "Duke University",
    initials: "DU",
    color: "#012169",
    round: "ED",
    deadline: "2026-11-01",
    status: "in-progress",
  });
});

test("toEssayCollege: a school typed in by hand, with no round or date yet", () => {
  assert.deepEqual(toEssayCollege({ id: "row-2", college_id: null, name: "Hudson Valley Institute", initials: null, brand_color: null, round: null, deadline: null, status: null }), {
    id: "row-2",
    collegeId: null,
    name: "Hudson Valley Institute",
    initials: "HV",
    color: "#176b45",
    round: null,
    deadline: null,
    status: "not-started",
  });
});
