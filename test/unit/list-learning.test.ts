import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ListCriteria, ListPick, ListSchool } from "../../src/lib/collegesV10.js";
import {
  CHOICE_LOOKBACK_DAYS,
  learningCriteria,
  logChoice,
  logChoices,
  logImpressions,
  logRestoredChoice,
  resetLearningForTest,
  type ImpressionRun,
  type LearnRequest,
} from "../../src/lib/listLearning.js";

// List-builder learning (20261119000001): what Build College Lists showed and what people did with each school,
// written on the service client, ids only, skipped for an excluded firm, and never allowed to throw or fail a request.

const STUDENT = "11111111-1111-4111-8111-111111111111";
const COUNSELOR = "22222222-2222-4222-8222-222222222222";
const FIRM = "33333333-3333-4333-8333-333333333333";
const COLLEGE = "44444444-4444-4444-8444-444444444444";
const COLLEGE_2 = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-11-10T12:00:00Z");

type Call = { table: string; op: "select" | "insert"; columns?: string; filters: [string, string, unknown][]; values?: unknown };
type Answer = { data: unknown; error: unknown };

/** A stand-in for the service client: records every call and answers through `world`. */
function fakeSvc(world: (call: Call) => Answer) {
  const calls: Call[] = [];
  const query = (call: Call) => {
    const b = {
      eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), b),
      gte: (col: string, v: unknown) => (call.filters.push(["gte", col, v]), b),
      in: (col: string, v: unknown) => (call.filters.push(["in", col, v]), b),
      order: (col: string, o: unknown) => (call.filters.push(["order", col, o]), b),
      limit: (n: number) => (call.filters.push(["limit", "", n]), b),
      maybeSingle: () => Promise.resolve(world(call)),
      then: (ok: (a: Answer) => unknown, no: (e: unknown) => unknown) => Promise.resolve(world(call)).then(ok, no),
    };
    return b;
  };
  const client = {
    from: (table: string) => ({
      select: (columns: string) => {
        const call: Call = { table, op: "select", columns, filters: [] };
        calls.push(call);
        return query(call);
      },
      insert: (values: unknown) => {
        const call: Call = { table, op: "insert", filters: [], values };
        calls.push(call);
        return Promise.resolve(world(call));
      },
    }),
  };
  return { calls, client: client as never, inserts: () => calls.filter((c) => c.op === "insert") };
}

const eqOf = (call: Call, col: string) => call.filters.find((f) => f[0] === "eq" && f[1] === col)?.[2];

/** A student whose counselor is in FIRM; `exclude` is the firm's flag; `shown` is the newest impression, if any. */
function practiceWorld(opts: { exclude?: boolean; firmId?: string | null; shown?: { run_id: string; position: number } | null; insertError?: unknown } = {}) {
  return (call: Call): Answer => {
    if (call.table === "profiles" && eqOf(call, "id") === STUDENT) return { data: { counselor_id: COUNSELOR }, error: null };
    if (call.table === "profiles" && eqOf(call, "id") === COUNSELOR) return { data: { firm_id: opts.firmId === undefined ? FIRM : opts.firmId }, error: null };
    if (call.table === "firms") return { data: { exclude_from_learning: opts.exclude ?? false }, error: null };
    if (call.table === "list_builder_impressions" && call.op === "select") return { data: opts.shown ?? null, error: null };
    if (call.op === "insert") return { data: null, error: opts.insertError ?? null };
    return { data: null, error: null };
  };
}

function fakeRequest(over: { role?: string; headers?: Record<string, string>; db?: unknown } = {}) {
  const warnings: unknown[] = [];
  const request = {
    auth: { userId: COUNSELOR, token: "t" },
    profile: { role: over.role ?? "counselor" },
    log: { warn: (obj: unknown) => warnings.push(obj) },
    headers: over.headers ?? {},
    db: over.db,
  } as unknown as LearnRequest & { db: never };
  return { request, warnings };
}

const now = () => NOW;

beforeEach(() => resetLearningForTest());

// ---- Choices ----

test("a choice is one row of ids and labels, linked to the newest impression of that school in the last 30 days", async () => {
  const svc = fakeSvc(practiceWorld({ shown: { run_id: RUN, position: 3 } }));
  const { request } = fakeRequest();
  const n = await logChoice(request, { studentId: STUDENT, collegeId: COLLEGE, action: "added", source: "manual" }, { svc: svc.client, now });
  assert.equal(n, 1);
  const [insert] = svc.inserts();
  assert.equal(insert!.table, "list_builder_choices");
  assert.deepEqual(insert!.values, [
    {
      firm_id: FIRM,
      actor_id: COUNSELOR,
      actor_role: "counselor",
      student_id: STUDENT,
      college_id: COLLEGE,
      action: "added",
      source: "manual",
      run_id: RUN,
      position: 3,
    },
  ]);
  const lookup = svc.calls.find((c) => c.table === "list_builder_impressions" && c.op === "select")!;
  assert.equal(eqOf(lookup, "student_id"), STUDENT);
  assert.equal(eqOf(lookup, "college_id"), COLLEGE);
  const since = lookup.filters.find((f) => f[0] === "gte")!;
  assert.equal(since[1], "created_at");
  assert.equal(since[2], new Date(NOW.getTime() - CHOICE_LOOKBACK_DAYS * 86_400_000).toISOString());
  assert.deepEqual(lookup.filters.find((f) => f[0] === "order"), ["order", "created_at", { ascending: false }]);
});

test("no impression of the school in the window: the choice is kept with no run and no position", async () => {
  const svc = fakeSvc(practiceWorld({ shown: null }));
  const { request } = fakeRequest({ role: "student" });
  await logChoice(request, { studentId: STUDENT, collegeId: COLLEGE, action: "removed", source: "manual" }, { svc: svc.client, now });
  const row = (svc.inserts()[0]!.values as Record<string, unknown>[])[0]!;
  assert.equal(row.run_id, null);
  assert.equal(row.position, null);
  assert.equal(row.actor_role, "student");
});

test("an excluded firm writes nothing, and reads no impressions", async () => {
  const svc = fakeSvc(practiceWorld({ exclude: true, shown: { run_id: RUN, position: 1 } }));
  const { request } = fakeRequest();
  const n = await logChoice(request, { studentId: STUDENT, collegeId: COLLEGE, action: "added", source: "manual" }, { svc: svc.client, now });
  assert.equal(n, 0);
  assert.equal(svc.inserts().length, 0);
  assert.equal(svc.calls.some((c) => c.table === "list_builder_impressions"), false);
});

test("a solo counselor's student (no firm) is logged with no firm, without reading firms", async () => {
  const svc = fakeSvc(practiceWorld({ firmId: null }));
  const { request } = fakeRequest();
  await logChoice(request, { studentId: STUDENT, collegeId: COLLEGE, action: "added", source: "manual" }, { svc: svc.client, now });
  assert.equal((svc.inserts()[0]!.values as Record<string, unknown>[])[0]!.firm_id, null);
  assert.equal(svc.calls.some((c) => c.table === "firms"), false);
});

test("a school typed in by hand (no catalog id) is not logged", async () => {
  const svc = fakeSvc(practiceWorld());
  const { request } = fakeRequest();
  assert.equal(await logChoice(request, { studentId: STUDENT, collegeId: null, action: "added", source: "manual" }, { svc: svc.client, now }), 0);
  assert.equal(svc.calls.length, 0);
});

test("AxIS's requests are labelled axis, whatever the route passed", async () => {
  const svc = fakeSvc(practiceWorld());
  const { request } = fakeRequest({ headers: { "x-meridies-axis": "1" } });
  await logChoice(request, { studentId: STUDENT, collegeId: COLLEGE, action: "added", source: "manual" }, { svc: svc.client, now });
  assert.equal((svc.inserts()[0]!.values as Record<string, unknown>[])[0]!.source, "axis");
});

test("a batch reads the practice once and writes one insert", async () => {
  const svc = fakeSvc(practiceWorld());
  const { request } = fakeRequest({ role: "student" });
  const n = await logChoices(
    request,
    [COLLEGE, COLLEGE_2].map((collegeId) => ({ studentId: STUDENT, collegeId, action: "added" as const, source: "list_builder" as const })),
    { svc: svc.client, now }
  );
  assert.equal(n, 2);
  assert.equal(svc.calls.filter((c) => c.table === "firms").length, 1);
  assert.equal(svc.inserts().length, 1);
  assert.deepEqual((svc.inserts()[0]!.values as Record<string, unknown>[]).map((r) => r.source), ["list_builder", "list_builder"]);
});

// ---- Never throws, never fails the request ----

test("errors never throw: a client that throws, an insert error, a practice read error (nothing written)", async () => {
  const { request, warnings } = fakeRequest();
  const choice = { studentId: STUDENT, collegeId: COLLEGE, action: "added" as const, source: "manual" as const };

  const throwing = { from: () => { throw new Error("socket hang up"); } } as never;
  assert.equal(await logChoice(request, choice, { svc: throwing, now }), 0);

  const failingInsert = fakeSvc(practiceWorld({ insertError: { code: "23503", message: "fk" } }));
  assert.equal(await logChoice(request, choice, { svc: failingInsert.client, now }), 0);

  const unreadable = fakeSvc((c) => (c.table === "profiles" ? { data: null, error: { code: "57014", message: "timeout" } } : { data: null, error: null }));
  assert.equal(await logChoice(request, choice, { svc: unreadable.client, now }), 0);
  assert.equal(unreadable.inserts().length, 0, "can't tell whether the firm is excluded: write nothing");

  assert.equal(warnings.length, 3);
  // The warnings carry error codes or messages, never the ids or what was chosen.
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(`${STUDENT}|${COLLEGE}`));
});

test("no service key, or a caller who is neither counselor nor student: nothing, quietly", async () => {
  const { request, warnings } = fakeRequest();
  assert.equal(await logChoice(request, { studentId: STUDENT, collegeId: COLLEGE, action: "added", source: "manual" }, { svc: null, now }), 0);
  const svc = fakeSvc(practiceWorld());
  const odd = fakeRequest({ role: "admin" });
  assert.equal(await logChoice(odd.request, { studentId: STUDENT, collegeId: COLLEGE, action: "added", source: "manual" }, { svc: svc.client, now }), 0);
  assert.equal(svc.calls.length, 0);
  assert.equal(warnings.length + odd.warnings.length, 0);
});

test("without the migration: one warning, then nothing is tried for five minutes", async () => {
  const missing = fakeSvc((c) =>
    c.table === "firms" ? { data: null, error: { code: "42703", message: "column does not exist" } } : practiceWorld()(c)
  );
  const { request, warnings } = fakeRequest();
  const choice = { studentId: STUDENT, collegeId: COLLEGE, action: "added" as const, source: "manual" as const };
  assert.equal(await logChoice(request, choice, { svc: missing.client, now }), 0);
  assert.equal(warnings.length, 1);
  const before = missing.calls.length;
  assert.equal(await logChoice(request, choice, { svc: missing.client, now: () => new Date(NOW.getTime() + 60_000) }), 0);
  assert.equal(missing.calls.length, before, "paused: no reads at all");
  assert.equal(warnings.length, 1);
  await logChoice(request, choice, { svc: missing.client, now: () => new Date(NOW.getTime() + 6 * 60_000) });
  assert.ok(missing.calls.length > before, "tried again after five minutes");
});

test("a missing table on insert (a solo counselor's student never reads firms) also pauses quietly", async () => {
  const svc = fakeSvc((c) => (c.op === "insert" ? { data: null, error: { code: "PGRST205", message: "no table" } } : practiceWorld({ firmId: null })(c)));
  const { request, warnings } = fakeRequest();
  assert.equal(await logChoice(request, { studentId: STUDENT, collegeId: COLLEGE, action: "added", source: "manual" }, { svc: svc.client, now }), 0);
  assert.equal(warnings.length, 1);
});

// ---- Impressions ----

const school = (collegeId: string, over: Partial<ListSchool> = {}): ListSchool => ({
  collegeId,
  slug: collegeId,
  name: "Somewhere College",
  initials: null,
  brandColor: null,
  city: "Springfield",
  state: "IL",
  website: "https://example.edu",
  lat: 40,
  lng: -89,
  undergrads: 5000,
  setting: "Suburban",
  testPolicy: "optional",
  admit: 40,
  satMid: 1300,
  gpaMid: 3.7,
  needRating: 7,
  largestGroupPct: 50,
  fields: ["Engineering"],
  regularDeadline: "Jan 1",
  ...over,
});
const pick = (s: ListSchool, odds: number | null, fit: ListPick["fit"]): ListPick => ({ school: s, miles: 120, odds, fit });

const criteria: ListCriteria = {
  majors: ["Mechanical Engineering", "my own words about robots"],
  sizes: ["Medium"],
  settings: ["Suburban"],
  testOptional: null,
  miles: 500,
  origin: { lat: 41.88, lng: -87.63, label: "123 Elm St, Chicago" },
  aid: "No preference",
  diversity: "No preference",
};

function run(over: Partial<ImpressionRun> = {}): ImpressionRun {
  return {
    studentId: STUDENT,
    criteria,
    relaxed: ["Diversity"],
    view: { offset: 4, perTier: 2, excluded: [COLLEGE_2] },
    curatedIds: new Set([COLLEGE]),
    bands: [
      { fit: "reach", total: 9, shown: [{ pick: pick(school(COLLEGE), 12.3456, "reach"), bandRank: 5 }, { pick: pick(school(COLLEGE_2, { admit: null }), null, "reach"), bandRank: 6 }] },
      { fit: "target", total: 0, shown: [] },
      { fit: "likely", total: 1, shown: [{ pick: pick(school(RUN, { admit: 85 }), 88, "likely"), bandRank: 1 }] },
    ],
    ...over,
  };
}

test("one row per school shown, one run id, position counted within each band from 1", async () => {
  const svc = fakeSvc(practiceWorld());
  const { request } = fakeRequest();
  assert.equal(await logImpressions(request, run(), { svc: svc.client, now }), 3);
  const rows = svc.inserts()[0]!.values as Record<string, unknown>[];
  assert.equal(svc.inserts()[0]!.table, "list_builder_impressions");
  assert.equal(new Set(rows.map((r) => r.run_id)).size, 1);
  assert.deepEqual(rows.map((r) => [r.college_id, r.band, r.position]), [
    [COLLEGE, "reach", 1],
    [COLLEGE_2, "reach", 2],
    [RUN, "likely", 1],
  ]);
  assert.deepEqual(rows.map((r) => r.odds), [12.35, null, 88]);
  assert.deepEqual(rows.map((r) => r.firm_id), [FIRM, FIRM, FIRM]);
  const f = rows[0]!.features as Record<string, unknown>;
  assert.deepEqual(f, {
    admit: 40, satMid: 1300, gpaMid: 3.7, needRating: 7, largestGroupPct: 50, undergrads: 5000, setting: "Suburban",
    testPolicy: "optional", fields: ["Engineering"], miles: 120, curated: true, bandRank: 5, bandTotal: 9,
  });
  assert.equal((rows[1]!.features as Record<string, unknown>).curated, false);
});

test("the stored criteria hold no free text: majors become fields, the origin only whether one was set", () => {
  const c = learningCriteria(criteria, ["Diversity"], { offset: 4, perTier: 2, excluded: [COLLEGE_2] });
  const text = JSON.stringify(c);
  assert.doesNotMatch(text, /Elm|Chicago|41\.88|87\.63|robots|Mechanical/);
  assert.deepEqual(c.majorFields, ["Engineering"]);
  assert.equal(c.majorsGiven, 2);
  assert.equal(c.originSet, true);
  assert.deepEqual(c.excluded, [COLLEGE_2]);
  assert.equal(c.excludedCount, 1);
});

test("the chat's dropped schools are capped on the row; the count is kept", () => {
  const many = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const c = learningCriteria(criteria, [], { offset: 0, perTier: 12, excluded: many });
  assert.equal((c.excluded as string[]).length, 50);
  assert.equal(c.excludedCount, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(c)) < 8000, "fits the column's 8,000-byte check");
});

test("impressions: an excluded firm, an empty answer, or an error write nothing and never throw", async () => {
  const { request } = fakeRequest();
  const excluded = fakeSvc(practiceWorld({ exclude: true }));
  assert.equal(await logImpressions(request, run(), { svc: excluded.client, now }), 0);
  assert.equal(excluded.inserts().length, 0);

  const empty = fakeSvc(practiceWorld());
  const none = run({ bands: [{ fit: "reach", total: 0, shown: [] }] });
  assert.equal(await logImpressions(request, none, { svc: empty.client, now }), 0);
  assert.equal(empty.calls.length, 0);

  const failing = fakeSvc(practiceWorld({ insertError: { code: "23514", message: "check" } }));
  assert.equal(await logImpressions(request, run(), { svc: failing.client, now }), 0);
  const throwing = { from: () => { throw new Error("boom"); } } as never;
  assert.equal(await logImpressions(request, run(), { svc: throwing, now }), 0);
});

// ---- An AxIS Restore of a removed school ----

test("a restored college_list.remove logs the school as added by AxIS; any other restore logs nothing", async () => {
  const svc = fakeSvc(practiceWorld());
  const reads: string[] = [];
  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => {
            reads.push(`${table}:${id}`);
            return { data: { student_id: STUDENT, college_id: COLLEGE }, error: null };
          },
        }),
      }),
    }),
  };
  const { request } = fakeRequest({ db });
  const rowId = "77777777-7777-4777-8777-777777777777";
  assert.equal(await logRestoredChoice(request, { op: "college_list.remove", input: { student_id: STUDENT, student_college_id: rowId } }, { svc: svc.client, now }), 1);
  assert.deepEqual(reads, [`student_colleges:${rowId}`]);
  const row = (svc.inserts()[0]!.values as Record<string, unknown>[])[0]!;
  assert.equal(row.action, "added");
  assert.equal(row.source, "axis");

  assert.equal(await logRestoredChoice(request, { op: "tasks.delete", input: { task_id: rowId } }, { svc: svc.client, now }), 0);
  assert.equal(await logRestoredChoice(request, null, { svc: svc.client, now }), 0);
  assert.equal(reads.length, 1);
});

// ---- Every add and remove is covered ----

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []
  );
}

test("every direct insert or delete on student_colleges is a reviewed, logged write path", () => {
  // Adding a path means calling logChoice/logChoices there (or going through addToList), then listing it here.
  // Covered elsewhere and not matched by this scan: routes/records.ts (registerCollection's generic writes, with
  // afterWrite/afterDelete), and an AxIS Restore (the database re-inserts; routes/axis.ts calls logRestoredChoice).
  const REVIEWED = ["routes/application.ts"];
  const src = fileURLToPath(new URL("../../src", import.meta.url));
  const found = tsFiles(src)
    .filter((f) => /from\(\s*["']student_colleges["']\s*\)\s*\.\s*(insert|delete|upsert)\s*\(/.test(readFileSync(f, "utf8")))
    .map((f) => relative(src, f).split("\\").join("/"))
    .sort();
  assert.deepEqual(found, REVIEWED);
});
