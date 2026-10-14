import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverForCollege, type ResearchFn } from "../../src/lib/eventsDiscovery.js";

type Row = Record<string, unknown>;

/** Just enough of supabase-js for discoverForCollege: hub_events, colleges and college_visit_offerings. */
function fakeDb(rows: Row[]) {
  let nextId = rows.length + 1;
  /** Updates to rows outside hub_events (the college's visit page and last-looked-up stamp). */
  const updates: Row[] = [];
  /** college_visit_offerings, keyed by college. */
  const offerings: Row[] = [];
  const query = () => {
    const filters: ((r: Row) => boolean)[] = [];
    const q = {
      select: () => q,
      is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), q),
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
      limit: async () => ({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return q;
  };
  return {
    rows,
    updates,
    offerings,
    from: (table: string) => ({
      select: () => query(),
      insert: async (row: Row | Row[]) => {
        if (table === "college_visit_offerings") {
          offerings.push(...(Array.isArray(row) ? row : [row]));
          return { error: null };
        }
        rows.push({ id: String(nextId++), created_by: null, firm_id: null, ...(row as Row) });
        return { error: null };
      },
      delete: () => ({
        eq: async (_col: string, id: string) => {
          if (table === "college_visit_offerings") {
            for (let i = offerings.length - 1; i >= 0; i--) if (offerings[i].college_id === id) offerings.splice(i, 1);
          }
          return { error: null };
        },
      }),
      update: (row: Row) => ({
        eq: async (_col: string, id: string) => {
          const target = table === "hub_events" ? rows.find((r) => r.id === id) : undefined;
          if (target) Object.assign(target, row);
          else updates.push({ id, ...row });
          return { error: null };
        },
      }),
    }),
  };
}

const college = { id: "c1", name: "Stanford University", website: "https://www.stanford.edu" };
const log = { info() {}, warn() {}, error() {} };
const ok = async () => ({ status: "ok" as const });
const NOW = new Date("2026-10-13T15:00:00Z");

const tour = (date: string) => ({
  title: "Campus Tour",
  kind: "campus-tour",
  startDate: date,
  startTime: "10:00",
  endTime: "11:30",
  timeZone: "America/Los_Angeles",
  place: "Stanford, CA",
  signUpUrl: "https://visit.stanford.edu/tours/",
  description: "A student-led walking tour.",
});

const research =
  (items: object[], seen = ["https://visit.stanford.edu/tours/"]): ResearchFn =>
  async () => ({
    parts: [{ text: "```json\n" + JSON.stringify(items) + "\n```", citations: [] }],
    sources: [],
    runId: null,
    refused: false,
    queries: [],
    seenUrls: seen,
  });

test("found events land as Meridies-wide rows for everyone, and a re-run updates instead of duplicating", async () => {
  const db = fakeDb([]);
  const first = await discoverForCollege(db as never, college, { research: research([tour("2026-11-07"), tour("2026-11-14")]), check: ok, blocked: [], now: NOW, log });
  assert.equal(first.inserted, 2);
  assert.equal(db.rows.length, 2);
  const r = db.rows[0];
  assert.equal(r.host, "Stanford University");
  assert.equal(r.audience, "everyone");
  assert.equal(r.source, "discovered");
  assert.equal(r.college_id, "c1");
  assert.equal(r.url, "https://visit.stanford.edu/tours/");
  assert.ok(r.last_verified_at);

  const again = await discoverForCollege(db as never, college, { research: research([tour("2026-11-07")]), check: ok, blocked: [], now: NOW, log });
  assert.equal(again.updated, 1);
  assert.equal(again.inserted, 0);
  assert.equal(db.rows.length, 2);
});

test("a curator's row with the same key is never overwritten", async () => {
  const db = fakeDb([
    { id: "x", name: "Campus Tour", host: "Stanford University", start_date: "2026-11-07", source: "csv", college_id: "c1", created_by: null, firm_id: null, description: "curated" },
  ]);
  const out = await discoverForCollege(db as never, college, { research: research([tour("2026-11-07")]), check: ok, blocked: [], now: NOW, log });
  assert.equal(out.skipped, 1);
  assert.equal(db.rows[0].description, "curated");
});

test("a link the run never saw, a dead link or a blocked site keeps nothing", async () => {
  const unseen = await discoverForCollege(fakeDb([]) as never, college, { research: research([tour("2026-11-07")], ["https://visit.stanford.edu/other"]), check: ok, blocked: [], now: NOW, log });
  assert.equal(unseen.kept, 0);

  const dead = await discoverForCollege(fakeDb([]) as never, college, { research: research([tour("2026-11-07")]), check: async () => ({ status: "broken" as const }), blocked: [], now: NOW, log });
  assert.equal(dead.kept, 0);

  const blocked = await discoverForCollege(fakeDb([]) as never, college, { research: research([tour("2026-11-07")]), check: ok, blocked: ["stanford.edu"], now: NOW, log });
  assert.equal(blocked.kept, 0);
  assert.match(blocked.error ?? "", /blocklist/);
});

test("no website on file, or research that fails, is an outcome, never a throw", async () => {
  const noSite = await discoverForCollege(fakeDb([]) as never, { ...college, website: null }, { research: research([]), blocked: [], now: NOW, log });
  assert.equal(noSite.error, "no website on file");

  const failing: ResearchFn = async () => {
    throw new Error("the monthly discovery budget is spent");
  };
  const out = await discoverForCollege(fakeDb([]) as never, college, { research: failing, blocked: [], now: NOW, log });
  assert.match(out.error ?? "", /budget/);
});

test("the visit page is kept on the college when it checks out, even with no dated events", async () => {
  const db = fakeDb([]);
  const answer: ResearchFn = async () => ({
    parts: [{ text: JSON.stringify({ visitPage: "https://visit.stanford.edu/plan/", events: [] }), citations: [] }],
    sources: [],
    runId: null,
    refused: false,
    queries: [],
    seenUrls: ["https://visit.stanford.edu/plan/"],
  });
  const out = await discoverForCollege(db as never, college, { research: answer, check: ok, blocked: [], now: NOW, log });
  assert.equal(out.visitUrl, "https://visit.stanford.edu/plan/");
  assert.ok(db.updates.some((u) => u.visit_url_checked_at && !("visit_url" in u)), "stamped as looked up");
  assert.equal(db.updates.find((u) => "visit_url" in u)?.visit_url, "https://visit.stanford.edu/plan/");

  const offSite: ResearchFn = async () => ({
    parts: [{ text: JSON.stringify({ visitPage: "https://example.com/visit", events: [] }), citations: [] }],
    sources: [],
    runId: null,
    refused: false,
    queries: [],
    seenUrls: ["https://example.com/visit"],
  });
  const none = await discoverForCollege(fakeDb([]) as never, college, { research: offSite, check: ok, blocked: [], now: NOW, log });
  assert.equal(none.visitUrl, null);
});

test("graduate and certificate program sessions are not a first-year's events", async () => {
  const db = fakeDb([]);
  const grad = { ...tour("2026-11-07"), title: "Master of Science Info Session", kind: "info-session" };
  const cert = { ...tour("2026-11-08"), title: "Graduate Certificate Info Session", kind: "info-session" };
  const out = await discoverForCollege(db as never, college, { research: research([grad, cert, tour("2026-11-09")]), check: ok, blocked: [], now: NOW, log });
  assert.equal(out.inserted, 1);
  assert.equal(db.rows[0].name, "Campus Tour");
});

test("offerings the run saw on the college's site replace the college's old ones", async () => {
  const db = fakeDb([]);
  db.offerings.push({ college_id: "c1", kind: "campus-tour", title: "Old tour" });
  const answer: ResearchFn = async () => ({
    parts: [
      {
        text: JSON.stringify({
          visitPage: null,
          offerings: [
            { kind: "campus-tour", title: "Campus Tour", schedule: "Most weekdays", signUpUrl: "https://visit.stanford.edu/tours/" },
            { kind: "info-session", title: "Graduate Program Info Session", schedule: null, signUpUrl: "https://visit.stanford.edu/tours/" },
            { kind: "virtual-visit", title: "Virtual Session", schedule: null, signUpUrl: "https://visit.stanford.edu/never-seen" },
          ],
          events: [],
        }),
        citations: [],
      },
    ],
    sources: [],
    runId: null,
    refused: false,
    queries: [],
    seenUrls: ["https://visit.stanford.edu/tours/"],
  });
  const out = await discoverForCollege(db as never, college, { research: answer, check: ok, blocked: [], now: NOW, log });
  assert.equal(out.offerings, 1, "the graduate session and the page never seen are dropped");
  assert.deepEqual(db.offerings.map((o) => o.title), ["Campus Tour"]);
  assert.equal(db.offerings[0].schedule, "Most weekdays");
});
