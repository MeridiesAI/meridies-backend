import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BASE_FIELDS,
  EXTENDED_FIELD_GROUPS,
  EXTENDED_FIELDS,
  EXTENDED_STAT_COLUMNS,
  MISSING_STATS_COLUMNS_TTL_MS,
  SCORECARD_FIELDS,
  ScorecardHttpError,
  completionOf,
  isMissingStatsColumn,
  mapScorecardSchool,
  resetStatsColumnCache,
  runScorecardIngest,
  scorecardFetcher,
  upsertStats,
  type FetchPage,
} from "../../src/lib/ingest/scorecard.js";

type Raw = Record<string, unknown>;

const fixture = JSON.parse(readFileSync(new URL("../fixtures/scorecard-two-schools.json", import.meta.url), "utf8")) as { results: Raw[] };
const reference = JSON.parse(readFileSync(new URL("../fixtures/scorecard-field-reference.json", import.meta.url), "utf8")) as {
  fields: Record<string, { source: string }>;
};
const berkeleyRaw = fixture.results.find((r) => r.id === 110635)!;

const C = "latest.completion";
const D = "latest.student.demographics";

/**
 * A synthetic record: the recorded Berkeley response plus every extended
 * field. The names come from the field reference (checked against the
 * dictionary and Scorecard's site), the values are made up for the edge cases.
 */
const extended: Raw = {
  ...berkeleyRaw,
  [`${C}.completion_rate_4yr_100nt`]: 0.7612,
  [`${C}.completion_rate_4yr_150nt`]: 0.9317,
  [`${C}.completion_rate_4yr_150_white`]: 0.94,
  [`${C}.completion_rate_4yr_150_black`]: 0.85,
  [`${C}.completion_rate_4yr_150_hispanic`]: 0.88,
  [`${C}.completion_rate_4yr_150_asian`]: 0.95,
  [`${C}.completion_rate_4yr_150_aian`]: null,
  [`${C}.completion_rate_4yr_150_nhpi`]: 1.4, // out of range: dropped
  [`${C}.completion_rate_4yr_150_2ormore`]: 0.91,
  [`${C}.completion_rate_4yr_150_nonresident.alien`]: 0.9,
  [`${C}.completion_rate_4yr_150_race.unknown`]: 0.89,
  // A four-year school has no L4 cohort; a stray one must not be mixed in.
  [`${C}.completion_rate_l4yr_150_white`]: 0.2,
  "latest.student.retention_rate_suppressed.four_year.full_time_pooled": 0.9672,
  "latest.student.retention_rate_suppressed.lt_four_year.full_time_pooled": 0.5,
  "latest.student.part_time_share": 0.0251,
  "latest.student.grad_students": 12847,
  [`${D}.student_faculty_ratio`]: 0, // not a ratio: dropped
  [`${D}.women`]: 0.5501,
  [`${D}.men`]: 0.4499,
  [`${D}.race_ethnicity.white`]: 0.2,
  [`${D}.race_ethnicity.asian`]: 0.35,
  [`${D}.race_ethnicity.hispanic`]: "0.2", // not a number: dropped
  [`${D}.race_ethnicity.two_or_more`]: 0.07,
  [`${D}.race_ethnicity.non_resident_alien`]: 0.11,
  [`${D}.race_ethnicity.unknown`]: 0.03,
  "latest.cost.roomboard.oncampus": 21245,
  "latest.cost.booksupply": 1336,
  "latest.earnings.6_yrs_after_entry.median": 71102,
  "latest.aid.median_debt.completers.monthly_payments": 145.7,
  "latest.aid.median_debt.noncompleters": 4500,
  "school.carnegie_basic": 15,
};

test("Scorecard: the extended fields map to their columns", () => {
  const m = mapScorecardSchool(extended)!;
  const s = m.stats;
  assert.equal(s.completion_basis, "four-year");
  assert.equal(s.grad_rate_on_time, 0.7612);
  assert.equal(s.grad_rate_150, 0.9317);
  assert.deepEqual(s.completion_by_race, {
    white: 0.94,
    black: 0.85,
    hispanic: 0.88,
    asian: 0.95,
    two_or_more: 0.91,
    non_resident_alien: 0.9,
    unknown: 0.89,
  });
  assert.equal(s.retention_rate, 0.9672);
  assert.equal(s.part_time_share, 0.0251);
  assert.equal(s.grad_students, 12847);
  assert.equal(s.student_faculty_ratio, null);
  assert.deepEqual(s.demographics, { women: 0.5501, men: 0.4499, white: 0.2, asian: 0.35, two_or_more: 0.07, non_resident_alien: 0.11, unknown: 0.03 });
  assert.equal(s.room_board_on_campus, 21245);
  assert.equal(s.books_supplies, 1336);
  assert.equal(s.median_earnings_6yr, 71102);
  assert.equal(s.median_debt_monthly, 146);
  assert.equal(s.median_debt_noncompleters, 4500);
  assert.equal(s.carnegie_basic, 15);
  // Every extended column is written, and nothing else new.
  for (const c of EXTENDED_STAT_COLUMNS) assert.ok(c in s, c);
  // The existing figures are unchanged.
  assert.equal(s.grad_rate, 0.9428);
});

test("Scorecard: a two-year school's completion comes from the less-than-four-year cohort", () => {
  const twoYear = {
    id: 9,
    "school.name": "Somewhere Community College",
    "school.degrees_awarded.predominant": 2,
    [`${C}.completion_rate_less_than_4yr_100nt`]: 0.18,
    [`${C}.completion_rate_less_than_4yr_150nt`]: 0.31,
    [`${C}.completion_rate_l4yr_150_hispanic`]: 0.29,
    [`${C}.completion_rate_l4yr_150_2ormore`]: 0.33,
    "latest.student.retention_rate_suppressed.four_year.full_time_pooled": null,
    "latest.student.retention_rate_suppressed.lt_four_year.full_time_pooled": 0.58,
    "school.carnegie_basic": -2,
  };
  const s = mapScorecardSchool(twoYear)!.stats;
  assert.equal(s.completion_basis, "less-than-four-year");
  assert.equal(s.grad_rate_on_time, 0.18);
  assert.equal(s.grad_rate_150, 0.31);
  assert.deepEqual(s.completion_by_race, { hispanic: 0.29, two_or_more: 0.33 });
  assert.equal(s.retention_rate, 0.58);
  assert.equal(s.carnegie_basic, null);
});

test("Scorecard: completion never mixes cohorts", () => {
  // Race figures only on the four-year side, the overall rate on the L4 side: L4 wins whole.
  const mixed = completionOf({ [`${C}.completion_rate_4yr_150_white`]: 0.5, [`${C}.completion_rate_less_than_4yr_150nt`]: 0.4 });
  assert.equal(mixed.basis, "less-than-four-year");
  assert.deepEqual(mixed.byRace, {});
  // Nothing reported: no basis, nothing to label.
  assert.deepEqual(completionOf({}), { basis: null, onTime: null, within150: null, byRace: {} });
  // Race figures alone still name their cohort.
  assert.equal(completionOf({ [`${C}.completion_rate_l4yr_150_asian`]: 0.6 }).basis, "less-than-four-year");
});

test("Scorecard: the recorded response still maps, the new columns empty", () => {
  const s = mapScorecardSchool(berkeleyRaw)!.stats;
  for (const c of EXTENDED_STAT_COLUMNS) {
    if (c === "completion_by_race" || c === "demographics") assert.deepEqual(s[c], {}, c);
    else assert.equal(s[c], null, c);
  }
});

test("Scorecard field list: base first, no repeats, every name on the reference", () => {
  assert.deepEqual(SCORECARD_FIELDS.slice(0, BASE_FIELDS.length), BASE_FIELDS);
  assert.equal(new Set(SCORECARD_FIELDS).size, SCORECARD_FIELDS.length);
  assert.equal(EXTENDED_FIELDS.length, Object.values(EXTENDED_FIELD_GROUPS).flat().length);
  const missing = SCORECARD_FIELDS.filter((f) => !reference.fields[f]);
  assert.deepEqual(missing, [], "look the field up in the Scorecard data dictionary and add it to test/fixtures/scorecard-field-reference.json");
  // ...and the reference names nothing the ingest no longer asks for.
  assert.deepEqual(Object.keys(reference.fields).filter((f) => !SCORECARD_FIELDS.includes(f)), []);
});

// ---- upsertStats --------------------------------------------------------------------

/** college_stats with or without the extended columns. */
function statsTable(hasColumns: boolean, code = "PGRST204") {
  const calls: Raw[][] = [];
  const upsert = async (rows: Raw[]) => {
    calls.push(rows);
    if (!hasColumns && rows.some((r) => "demographics" in r)) {
      return { error: { code, message: "Could not find the 'demographics' column of 'college_stats' in the schema cache" } };
    }
    return { error: null };
  };
  return { calls, upsert };
}
const row = { college_id: "c1", admit_rate: 0.1, demographics: { women: 0.5 }, grad_rate_150: 0.9, carnegie_basic: 15 };

test("upsertStats: with the columns, one upsert carrying them", async () => {
  resetStatsColumnCache();
  const t = statsTable(true);
  const r = await upsertStats(t.upsert, [row], 0);
  assert.deepEqual(r, { error: null, stripped: false });
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], [row]);
});

test("upsertStats: without the columns, retried without them, then left out up front", async () => {
  for (const code of ["PGRST204", "42703"]) {
    resetStatsColumnCache();
    const t = statsTable(false, code);
    const r = await upsertStats(t.upsert, [row], 1000);
    assert.deepEqual(r, { error: null, stripped: true });
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.calls[1], [{ college_id: "c1", admit_rate: 0.1 }]);
    for (const c of EXTENDED_STAT_COLUMNS) assert.ok(!(c in t.calls[1][0]!), c);
    // The next page, inside the window: one call, already stripped.
    const again = await upsertStats(t.upsert, [row], 1000 + MISSING_STATS_COLUMNS_TTL_MS - 1);
    assert.equal(again.stripped, true);
    assert.equal(t.calls.length, 3);
    assert.ok(!("demographics" in t.calls[2][0]!));
    // After it, the columns are tried again.
    await upsertStats(t.upsert, [row], 1000 + MISSING_STATS_COLUMNS_TTL_MS + 1);
    assert.ok("demographics" in t.calls[3][0]!);
  }
});

test("upsertStats: any other error is returned as it is", async () => {
  resetStatsColumnCache();
  let calls = 0;
  const err = { code: "42703", message: 'column "admit_rate" of relation "college_stats" does not exist' };
  const r = await upsertStats(async () => (calls++, { error: err }), [row], 0);
  assert.deepEqual(r, { error: err, stripped: false });
  assert.equal(calls, 1);
  assert.equal(isMissingStatsColumn({ code: "23514", message: "demographics check" }), false);
  // A column whose name contains an extended one's isn't mistaken for it.
  assert.equal(isMissingStatsColumn({ code: "PGRST204", message: "Could not find the 'grad_rate_1500' column" }), false);
  assert.equal(isMissingStatsColumn({ code: "PGRST204", message: "Could not find the 'grad_rate_150' column" }), true);
  assert.equal(isMissingStatsColumn(null), false);
});

// ---- The fetcher's fallback -----------------------------------------------------------

/** The Scorecard API, refusing (400) any request that names one of `unknown`. */
function fakeApi(unknown: string[], opts: { failBase?: boolean; outageCalls?: number } = {}) {
  const requests: { fields: string[]; perPage: string | null; page: string | null }[] = [];
  let outage = opts.outageCalls ?? 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const fields = (url.searchParams.get("fields") ?? "").split(",");
    requests.push({ fields, perPage: url.searchParams.get("per_page"), page: url.searchParams.get("page") });
    const isProbe = url.searchParams.get("per_page") === "1";
    if (isProbe && outage > 0 && fields.length > BASE_FIELDS.length) {
      outage--;
      return new Response("busy", { status: 503 });
    }
    if (opts.failBase || fields.some((f) => unknown.includes(f))) {
      return new Response(`{"errors":[{"error":"field_not_found","input":"api_key=SECRET"}]}`, { status: 400 });
    }
    return new Response(JSON.stringify({ metadata: { total: 1 }, results: [berkeleyRaw] }), { status: 200 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}
const noSleep = async () => {};

test("fetcher: every field accepted, one request", async () => {
  const api = fakeApi([]);
  const f = scorecardFetcher("k", { fetchImpl: api.fetchImpl, sleep: noSleep });
  const body = await f(0);
  assert.equal(body.results.length, 1);
  assert.equal(api.requests.length, 1);
  assert.deepEqual(api.requests[0]!.fields, SCORECARD_FIELDS);
  assert.deepEqual(f.refusedGroups(), []);
});

test("fetcher: a refused field drops its group and keeps the rest", async () => {
  const bad = EXTENDED_FIELD_GROUPS.completionByRaceL4[3]!;
  const api = fakeApi([bad]);
  const f = scorecardFetcher("k", { fetchImpl: api.fetchImpl, sleep: noSleep });
  const body = await f(0);
  assert.equal(body.results.length, 1);
  assert.deepEqual(f.refusedGroups(), ["completionByRaceL4"]);
  const last = api.requests.at(-1)!;
  assert.equal(last.perPage, "100");
  assert.ok(!last.fields.some((x) => (EXTENDED_FIELD_GROUPS.completionByRaceL4 as readonly string[]).includes(x)));
  assert.ok(EXTENDED_FIELD_GROUPS.completion.every((x) => last.fields.includes(x)));
  assert.ok(BASE_FIELDS.every((x) => last.fields.includes(x)));
  // Full try, base probe, one probe per group, the page again.
  assert.equal(api.requests.length, 1 + 1 + Object.keys(EXTENDED_FIELD_GROUPS).length + 1);
  // Later pages ask for the narrowed list straight away and don't probe again.
  await f(1);
  assert.equal(api.requests.length, 1 + 1 + Object.keys(EXTENDED_FIELD_GROUPS).length + 2);
  assert.deepEqual(api.requests.at(-1)!.fields, last.fields);
});

test("fetcher: base fields refused is a real failure, and the error never echoes the body", async () => {
  const api = fakeApi([], { failBase: true });
  const f = scorecardFetcher("SECRET", { fetchImpl: api.fetchImpl, sleep: noSleep });
  await assert.rejects(f(0), (e: unknown) => e instanceof ScorecardHttpError && e.status === 400 && !e.message.includes("SECRET"));
});

test("fetcher: a probe cut short by an outage is tried again on the next page", async () => {
  const bad = EXTENDED_FIELD_GROUPS.carnegie[0]!;
  // Five 503s: the first attempt and its four retries.
  const api = fakeApi([bad], { outageCalls: 5 });
  const f = scorecardFetcher("k", { fetchImpl: api.fetchImpl, sleep: noSleep });
  await assert.rejects(f(0), (e: unknown) => e instanceof ScorecardHttpError && e.status === 503);
  assert.deepEqual(f.refusedGroups(), []);
  const body = await f(1);
  assert.equal(body.results.length, 1);
  assert.deepEqual(f.refusedGroups(), ["carnegie"]);
});

// ---- The run records a degraded load --------------------------------------------------

type Op = [string, unknown[]];
/** Just enough supabase-js for runScorecardIngest: every call chains, awaiting it asks `handle`. */
function fakeSvc(handle: (table: string, ops: Op[]) => { data?: unknown; error?: { code?: string; message: string } | null }) {
  const calls: { table: string; ops: Op[] }[] = [];
  const chain = (table: string, ops: Op[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            calls.push({ table, ops });
            const r = handle(table, ops);
            return (resolve: (v: unknown) => void) => resolve({ data: r.data ?? null, error: r.error ?? null });
          }
          return (...args: unknown[]) => chain(table, [...ops, [String(prop), args]]);
        },
      }
    );
  return { calls, client: { from: (t: string) => chain(t, []) } as unknown as SupabaseClient };
}

function catalog(opts: { statsColumns: boolean }) {
  return fakeSvc((table, ops) => {
    const [first] = ops;
    if (table === "ingest_runs" && first?.[0] === "insert") return { data: { id: "run-1" } };
    if (table === "colleges" && first?.[0] === "select") {
      return { data: fixture.results.map((r) => ({ id: `c-${r.id}`, unitid: r.id, slug: `s-${r.id}`, catalog_source: "scorecard" })) };
    }
    if (table === "college_stats" && first?.[0] === "upsert") {
      const rows = first[1][0] as Raw[];
      if (!opts.statsColumns && rows.some((r) => "completion_by_race" in r)) {
        return { error: { code: "PGRST204", message: "Could not find the 'completion_by_race' column of 'college_stats' in the schema cache" } };
      }
    }
    return {};
  });
}
const quiet = { info() {}, warn() {}, error() {} };
const onePage: FetchPage = async (page) => ({ total: 2, results: page === 0 ? fixture.results : [] });

test("run: a clean load is clean", async () => {
  resetStatsColumnCache();
  const svc = catalog({ statsColumns: true });
  const out = await runScorecardIngest(svc.client, onePage, quiet);
  assert.equal(out.status, "succeeded");
  assert.deepEqual(out.degraded, []);
  assert.equal(out.upserted, 2);
});

test("run: missing columns load the rest and say so", async () => {
  resetStatsColumnCache();
  const svc = catalog({ statsColumns: false });
  const out = await runScorecardIngest(svc.client, onePage, quiet);
  assert.equal(out.upserted, 2);
  assert.equal(out.status, "partial");
  assert.equal(out.degraded.length, 1);
  assert.match(out.degraded[0]!, /20261023080001/);
  assert.equal(out.errors[0], out.degraded[0]);
  const runUpdate = svc.calls.find((c) => c.table === "ingest_runs" && c.ops[0]?.[0] === "update")!;
  assert.equal((runUpdate.ops[0]![1][0] as Raw).status, "partial");
  resetStatsColumnCache();
});

test("run: refused fields load the rest and say so", async () => {
  resetStatsColumnCache();
  const svc = catalog({ statsColumns: true });
  const narrowed = Object.assign(onePage, { refusedGroups: () => ["completionByRaceL4"] });
  const out = await runScorecardIngest(svc.client, narrowed, quiet);
  assert.equal(out.upserted, 2);
  assert.equal(out.status, "partial");
  assert.match(out.degraded[0]!, /completionByRaceL4/);
});
