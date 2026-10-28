// The 60-student speed test (B14): one counselor with 60 fully populated
// students, a firm of three, a 60-contact pipeline and Management tasks
// (scripts/seed/e2e-stack.mjs), then p50/p95 for what the Overview, Calendar,
// My Work Queue, Contact Pipeline and Management pages wait for.
//
//   npm run test:perf                    report only (exit 0 unless the run itself breaks)
//   PERF_ENFORCE=1 npm run test:perf     exit 1 when a page's p95 is PERF_BUDGET_MS (500) or more
//
// Env: the persona suite's (SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY, DB_URL, API_URL), all local: the seed refuses
// anything else. Optional PERF_STUDENTS (60), PERF_SAMPLES (20), PERF_OUT
// (perf-roster.json), PERF_OTHER_PRACTICES (3).
//
// Production holds many practices, so before timing it also seeds
// PERF_OTHER_PRACTICES other counselors with the same 60-student roster: a
// counselor's pages must not slow down as other practices' rows pile up, and a
// query that leans on RLS alone to find "my" rows reads all of theirs too.
//
// A page is timed the way it loads: the counselor layout awaits GET /students,
// then the page's own calls go out together, so a page sample is /students plus
// the slowest of the rest. My Work Queue is the card's one client call.
//
// Pacing: every request waits for room under the API's in-process limit (300 a
// minute per user, kept to 240 here) and under its route's DB-backed limit
// (kept to 80% of it, e.g. overview:summaries 60 a minute), counted over a
// sliding minute, which also keeps every fixed window under its cap. A 429
// would be measured as a fast answer, so any non-200 fails the run.
//
// It runs against a stack with NODE_ENV=development or test alike: the pacer
// never relies on the test allowList. Like imports-load, it leaves its
// accounts and rows behind; `supabase db reset` afterwards locally.
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  api, createPersona, createStudents, seedFirm, seedHubEvents, seedOverviewExtras, seedPractice, seedRoster, todayInSeedZone, SEED_TIME_ZONE,
} from "../../scripts/seed/e2e-stack.mjs";
import { shiftDate } from "../../scripts/seed/billing-scenario.mjs";
import { Pacer, percentile } from "./perf-pacer.mjs";

function whole(name, fallback, min, max) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}
const STUDENTS = whole("PERF_STUDENTS", 60, 1, 500);
const SAMPLES = whole("PERF_SAMPLES", 20, 5, 200);
const WARMUPS = 3;
const BUDGET_MS = whole("PERF_BUDGET_MS", 500, 1, 60_000);
const ENFORCE = process.env.PERF_ENFORCE === "1";
const OUT = process.env.PERF_OUT ?? "perf-roster.json";
const OTHER_PRACTICES = whole("PERF_OTHER_PRACTICES", 3, 0, 20);

const USER_CAP = 240; // in-process: 300 a minute per user
const cap = (max) => Math.floor(max * 0.8);

/** Rows in an answer, so a 0-row answer can't pass as fast without anyone noticing. */
function rowsOf(body) {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === "object") {
    for (const k of ["items", "contacts", "accounts", "consultants", "tasks"]) if (Array.isArray(body[k])) return body[k].length;
    return Object.keys(body).length;
  }
  return 0;
}

async function main() {
  const t0 = Date.now();
  console.log(`seeding: 1 counselor, ${STUDENTS} students, a firm of 3, 60 contacts, 20 billed families, and ${OTHER_PRACTICES} other practices…`);
  const counselor = await createPersona({ tag: "perf", fullName: "Pat Perf" });
  const members = [
    await createPersona({ tag: "perf-member-1", fullName: "Riley Consultant" }),
    await createPersona({ tag: "perf-member-2", fullName: "Quinn Consultant" }),
  ];
  await seedFirm(counselor, "Speed Test Counseling", members);
  const ids = createStudents(counselor, STUDENTS, "perf");
  if (ids.length !== STUDENTS) throw new Error(`expected ${STUDENTS} students, got ${ids.length}`);
  await seedRoster(counselor, ids);
  await seedPractice(counselor, { contacts: 60, packages: 20, tasks: 20, assignees: members, studentIds: ids });
  seedHubEvents();
  await seedOverviewExtras(counselor);
  for (let i = 1; i <= OTHER_PRACTICES; i++) {
    const other = await createPersona({ tag: `perf-other-${i}`, fullName: `Other Practice ${i}` });
    const theirs = createStudents(other, STUDENTS, `perf-other-${i}`);
    await seedRoster(other, theirs);
    await seedPractice(other, { contacts: 60, packages: 20, tasks: 10, studentIds: theirs });
  }
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const today = todayInSeedZone();
  const monthStart = `${today.slice(0, 8)}01`;
  const nextMonth = new Date(`${monthStart}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const from = shiftDate(monthStart, -7);
  // The window must reach the seeded Events Hub listings (seedHubEvents: today +12 and +20 days),
  // or late in a month the hub read is empty and "returns the seeded rows" fails on the date alone.
  const calendarEnd = shiftDate(nextMonth.toISOString().slice(0, 10), 6);
  const seededEnd = shiftDate(todayInSeedZone(), 21);
  const to = calendarEnd > seededEnd ? calendarEnd : seededEnd;
  const tz = encodeURIComponent(SEED_TIME_ZONE);

  // [name, path, DB limiter key and max, or null for a point lookup]
  const E = {
    students: ["/students", ["students:list", 120]],
    summaries: ["/overview/student-summaries", ["overview:summaries", 60]],
    pins: ["/pins", ["pins:list", 240]],
    alumni: ["/alumni", ["alumni:list", 120]],
    building: ["/invites/building", ["invites:building", 120]],
    cycles: ["/outcomes/cycles", ["outcomes:cycles", 120]],
    workItems: ["/work-items?includeDerived=true", ["work-items:list", 240]],
    calendarFeed: [`/calendar/feed?from=${from}&to=${to}&tz=${tz}`, ["calendar:feed", 240]],
    hubCalendar: [`/events/calendar?from=${from}&to=${to}`, ["events:calendar", 240]],
    tasks: ["/tasks", ["tasks:list", 300]],
    pipeline: ["/pipeline", ["pipeline:board", 120]],
    payments: ["/pipeline/payments", ["pipeline:payments", 120]],
    management: ["/management", ["management:read", 120]],
    student: [`/students/${ids[0]}`, null],
  };
  const PAGES = {
    Overview: { layout: true, calls: ["summaries", "pins", "alumni", "building", "cycles"] },
    Calendar: { layout: true, calls: ["calendarFeed", "hubCalendar"] },
    "My Work Queue": { layout: false, calls: ["workItems"] },
    "Contact Pipeline": { layout: true, calls: ["pipeline"] },
    "Payment Tracker": { layout: false, calls: ["payments"] },
    Management: { layout: true, calls: ["management"] },
  };
  const ENFORCED = new Set(["Overview", "Calendar", "My Work Queue", "Contact Pipeline", "Management"]);

  const pacer = new Pacer();
  const pairsFor = (name) => [["user", USER_CAP], ...(E[name][1] ? [[E[name][1][0], cap(E[name][1][1])]] : [])];
  const rows = {};
  async function timed(name) {
    const start = performance.now();
    const r = await api(counselor.token, "GET", E[name][0]);
    const ms = performance.now() - start;
    if (r.status !== 200) throw new Error(`GET ${E[name][0].split("?")[0]} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    rows[name] = rowsOf(r.body);
    return ms;
  }
  const summarize = (samples) => {
    const s = [...samples].sort((a, b) => a - b);
    return { p50: Math.round(percentile(s, 50)), p95: Math.round(percentile(s, 95)), max: Math.round(s[s.length - 1]), n: s.length };
  };

  console.log(`timing ${Object.keys(E).length} endpoints, ${WARMUPS} warm-ups + ${SAMPLES} samples each…`);
  const endpoints = {};
  for (const name of Object.keys(E)) {
    const samples = [];
    for (let i = 0; i < WARMUPS + SAMPLES; i++) {
      await pacer.take(pairsFor(name));
      const ms = await timed(name);
      if (i >= WARMUPS) samples.push(ms);
    }
    endpoints[name] = { path: E[name][0].split("?")[0], ...summarize(samples), rows: rows[name] };
  }

  console.log(`timing ${Object.keys(PAGES).length} pages…`);
  const pages = {};
  for (const [page, { layout, calls }] of Object.entries(PAGES)) {
    const samples = [];
    for (let i = 0; i < WARMUPS + SAMPLES; i++) {
      for (const name of [...(layout ? ["students"] : []), ...calls]) await pacer.take(pairsFor(name));
      const start = performance.now();
      if (layout) await timed("students");
      await Promise.all(calls.map((name) => timed(name)));
      const ms = performance.now() - start;
      if (i >= WARMUPS) samples.push(ms);
    }
    pages[page] = { calls: [...(layout ? ["students ->"] : []), ...calls].join(" "), ...summarize(samples), enforced: ENFORCED.has(page) };
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(`\n${pad("endpoint", 30)}${num("p50", 7)}${num("p95", 7)}${num("max", 7)}${num("rows", 7)}`);
  for (const e of Object.values(endpoints)) console.log(`${pad(e.path, 30)}${num(e.p50, 7)}${num(e.p95, 7)}${num(e.max, 7)}${num(e.rows, 7)}`);
  console.log(`\n${pad("page (ms)", 20)}${num("p50", 7)}${num("p95", 7)}${num("max", 7)}  calls`);
  for (const [name, p] of Object.entries(pages)) console.log(`${pad(name, 20)}${num(p.p50, 7)}${num(p.p95, 7)}${num(p.max, 7)}  ${p.calls}`);

  // Each seeded list must come back non-empty, or the timing means nothing.
  const expectRows = {
    students: STUDENTS, summaries: STUDENTS, pins: 5, building: 3, workItems: STUDENTS, calendarFeed: STUDENTS, hubCalendar: 1,
    tasks: STUDENTS * 4, pipeline: 60, payments: 20, management: 3,
  };
  let broken = false;
  for (const [name, min] of Object.entries(expectRows)) {
    const ok = endpoints[name].rows >= min;
    if (!ok) broken = true;
    console.log(`${ok ? "PASS" : "FAIL"}  ${endpoints[name].path} returns the seeded rows  ${endpoints[name].rows} (want >= ${min})`);
  }
  const over = Object.entries(pages).filter(([, p]) => p.enforced && p.p95 >= BUDGET_MS);
  for (const [name, p] of Object.entries(pages).filter(([, p]) => p.enforced)) {
    const ok = p.p95 < BUDGET_MS;
    console.log(`${ok ? "PASS" : ENFORCE ? "FAIL" : "WARN"}  ${name} p95 under ${BUDGET_MS} ms  ${p.p95} ms`);
  }
  writeFileSync(OUT, JSON.stringify({
    ranAt: new Date().toISOString(), students: STUDENTS, otherPractices: OTHER_PRACTICES, samples: SAMPLES, warmups: WARMUPS, budgetMs: BUDGET_MS,
    enforced: ENFORCE, node: process.version, endpoints, pages,
  }, null, 2));
  console.log(`\nwrote ${OUT}${ENFORCE ? "" : " (report only; PERF_ENFORCE=1 fails a page over budget)"}`);
  if (broken || (ENFORCE && over.length)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`perf-roster failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
