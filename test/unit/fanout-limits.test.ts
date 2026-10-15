// B14: every list read the speed-tested pages fan out to carries a DB-backed
// limit(...) preHandler (AGENTS.md "Reads get the DB-backed limiter when they
// carry volume or fan out"). The list is the one test/integration/perf-roster.mjs
// times; a new list read on those pages belongs here too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// [file, route path, and where to start looking when the file registers two plugins]
const FANOUT_READS: Array<[file: string, path: string, after?: string]> = [
  ["students.ts", "/"],
  ["overviewSummaries.ts", "/student-summaries"],
  ["pins.ts", "/"],
  ["outcomes.ts", "/", "export async function alumniRoutes"], // GET /alumni
  ["outcomes.ts", "/cycles"],
  ["invites.ts", "/building"],
  ["workItems.ts", "/"],
  ["calendar.ts", "/feed"],
  ["events.ts", "/calendar"],
  ["tasks.ts", "/"],
  ["pipeline.ts", "/"],
  ["pipeline.ts", "/payments"],
  ["management.ts", "/"],
];

const src = (f: string) => readFileSync(new URL(`../../src/routes/${f}`, import.meta.url), "utf8");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("pipeline.ts's read() helper is a DB-backed limit", () => {
  assert.match(src("pipeline.ts"), /const read = \(name: string, max = \d+\) => \[\.\.\.counselor, limit\(name, max, 60\)\]/);
});

test("every fan-out read on the speed-tested pages has a DB-backed limiter", () => {
  for (const [file, path, after] of FANOUT_READS) {
    const whole = src(file);
    const from = after ? whole.indexOf(after) : 0;
    assert.ok(from >= 0, `${after} in ${file}`);
    const text = whole.slice(from);
    const m = new RegExp(`app\\.get\\(\\s*"${escape(path)}"\\s*,\\s*\\{([^}]*)\\}`).exec(text);
    assert.ok(m, `GET ${path} in ${file}`);
    assert.match(m[1], /\blimit\(|\bread\(/, `GET ${path} in ${file} needs a limit(...) preHandler`);
  }
});
