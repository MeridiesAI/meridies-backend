/**
 * Hand check of the research path against a running API, for one fixture student.
 *
 *   API_URL=http://127.0.0.1:4000 SMOKE_COUNSELOR_TOKEN=<jwt> SMOKE_STUDENT_ID=<uuid> \
 *     npx tsx scripts/smoke/research.ts
 *
 * What it does: fetches the student (GET /students/:id) and refuses to go on unless the name starts with
 * "Fixture ", so it can never run research on a real student. Then it runs activities research (refresh: true)
 * and college-list research (cache allowed) and prints, for each run, the HTTP status, whether it was cached,
 * the number of recommendations, and each one's title, why and source URLs. Every source is checked with
 * `checkLink` (src/lib/links.ts). A `blocked` answer (the site refuses robots; checkLink can't tell) is a
 * warning. It exits 1 when a run fails, a recommendation has no source, or a source is `broken`.
 *
 * Safety: the token is read from the environment and never printed. The script refuses to run when API_URL is not
 * a localhost address unless SMOKE_ALLOW_REMOTE=1 is set, because a run against a deployed API spends model
 * and web-search money and writes rows there.
 *
 * Making the fixture student locally (the persona-suite harness needs SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY and DB_URL; see .superpowers or the "Local env" steps in AGENTS.md / ci.yml):
 *
 *   supabase db reset
 *   # start the API; add ANTHROPIC_API_KEY for a real run, or RESEARCH_FAKE=fixture for canned answers
 *   cat > make-fixture.mjs <<'EOF'
 *   import { user, sql } from "./test/integration/harness.mjs";
 *   import { seedStudent } from "./test/fixtures/context/students.mjs";
 *   const counselor = await user("smoke-counselor");
 *   const { student } = await seedStudent(counselor, "full");
 *   await sql(`update public.profiles set full_name = 'Fixture Maya' where id = '${student.id}'`);
 *   console.log(`export SMOKE_COUNSELOR_TOKEN='${counselor.token}'\nexport SMOKE_STUDENT_ID='${student.id}'`);
 *   EOF
 *   eval "$(node make-fixture.mjs)"    # the token is in your shell only; delete make-fixture.mjs afterwards
 *
 * A counselor token from the harness lasts about an hour.
 *
 * Name the fixture student "Fixture <something that is not a common word>", not "Fixture Student": every part of a
 * student's name is an identity token, and a reason that contains one (the match step is told to write "the
 * student") is dropped, so a student named "Fixture Student" gets no recommendations at all.
 */
import { checkLink } from "../../src/lib/links.js";

const apiUrl = (process.env.API_URL ?? "").replace(/\/+$/, "");
const token = process.env.SMOKE_COUNSELOR_TOKEN ?? "";
const studentId = process.env.SMOKE_STUDENT_ID ?? "";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!apiUrl || !token || !studentId) {
  fail("API_URL, SMOKE_COUNSELOR_TOKEN and SMOKE_STUDENT_ID must all be set (see the header of this file).");
}

function isLocal(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}
if (!isLocal(apiUrl) && process.env.SMOKE_ALLOW_REMOTE !== "1") {
  fail(
    `Refusing to run: API_URL (${apiUrl}) is not a localhost address. A run spends model and search money and writes rows ` +
      "on that server. Set SMOKE_ALLOW_REMOTE=1 if you mean it."
  );
}

type Source = { url: string; title: string | null; checkedAt: string };
type Rec = { id: string; title: string; why: string; sources: Source[] };
type Run = { runId: string; cached: boolean; recommendations: Rec[] };

async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, json };
}

// The guard comes first: nothing below runs for a student whose name doesn't start with "Fixture ".
const who = await api("GET", `/students/${studentId}`);
const fullName = (who.json as { fullName?: unknown } | null)?.fullName;
if (who.status !== 200 || typeof fullName !== "string") {
  fail(`Could not read the student (HTTP ${who.status}). Is the token a counselor's, and is the student on their roster?`);
}
if (!fullName.startsWith("Fixture ")) {
  fail(`Refusing to run: the student's name must start with "Fixture " (this smoke script only touches fixture students).`);
}
console.log(`Student: ${fullName}`);

let failures = 0;
let warnings = 0;

async function runOne(label: string, path: string, body: Record<string, unknown>): Promise<void> {
  console.log(`\n== ${label}: POST ${path} ${JSON.stringify(body)}`);
  const res = await api("POST", path, body);
  if (res.status !== 200) {
    console.log(`HTTP ${res.status}  FAILED  ${JSON.stringify(res.json).slice(0, 300)}`);
    failures++;
    return;
  }
  const run = res.json as Run;
  console.log(`HTTP ${res.status}  cached=${run.cached}  recommendations=${run.recommendations.length}`);
  if (run.recommendations.length === 0) {
    console.log("  WARN: no recommendations (a valid answer, but check the student's name isn't a word the reasons use)");
    warnings++;
  }
  for (const rec of run.recommendations) {
    console.log(`\n  - ${rec.title}\n    why: ${rec.why}`);
    if (rec.sources.length === 0) {
      console.log("    NO SOURCE");
      failures++;
      continue;
    }
    for (const s of rec.sources) {
      const check = await checkLink(s.url);
      const mark = check.status === "ok" ? "ok" : check.status === "blocked" ? "WARN (site refuses robots; can't tell)" : "BROKEN";
      if (check.status === "broken") failures++;
      if (check.status === "blocked") warnings++;
      console.log(`    source: ${s.url}  [${mark}]`);
    }
  }
}

await runOne("activities", `/students/${studentId}/research/activities`, { refresh: true });
await runOne("college list", `/students/${studentId}/research/college-list`, {});

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failure(s), ${warnings} warning(s)`);
process.exit(failures === 0 ? 0 : 1);
