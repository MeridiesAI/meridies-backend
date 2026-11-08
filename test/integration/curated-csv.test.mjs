// The curated CSV loader (scripts/ingest/curated-csv.ts) against a local
// Supabase: the supplements dataset writes college_supplements rows with their
// source and checked date, a re-run changes nothing, a dry run and a file with
// one bad row write nothing; and the policies dataset fills the two columns
// 20261111000009 adds. Uses MIT's catalog row under a cycle no real data uses
// (2098-2099), and puts MIT's policies row back after. All rows are fake.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, sql } from "./harness.mjs";

const repo = new URL("../..", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "curated-csv-"));
const mit = await sql(`select id from colleges where unitid = 166683 limit 1`);
check("the catalog has MIT", Boolean(mit));

function load(dataset, csv, { dryRun = false } = {}) {
  const file = join(dir, `${dataset}-${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(file, csv);
  const args = ["tsx", "scripts/ingest/curated-csv.ts", "--dataset", dataset, "--file", file];
  if (dryRun) args.push("--dry-run");
  try {
    return { ok: true, out: execFileSync("npx", args, { cwd: repo, env: process.env, stdio: "pipe" }).toString() };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}

const CYCLE = "2098-2099";
const rowsOf = () =>
  sql(`select string_agg(concat_ws('|', sort_order, title, prompt, coalesce(word_limit::text, ''), scope, coalesce(major_or_program, ''),
                                   required, source_url, source_verified_at::date), E'\\n' order by sort_order)
         from college_supplements where college_id = '${mit}' and admission_cycle = '${CYCLE}'`);
const stamps = () =>
  sql(`select string_agg(id::text || updated_at::text, ',' order by sort_order) from college_supplements
        where college_id = '${mit}' and admission_cycle = '${CYCLE}'`);

const HEAD = "unitid,cycle,sort_order,title,prompt,word_limit,scope,major_or_program,required,source_url,checked_on\n";
const GOOD =
  HEAD +
  `166683,2098-99,0,TEST short answer,"TEST: Describe the world you come from, in brief.",200,universal,,yes,https://admissions.example.edu/test,2026-11-01\n` +
  `166683,2098-99,1,TEST engineering,TEST: Why engineering?,150,major,Engineering,no,https://admissions.example.edu/test,2026-11-02\n`;

const policyBefore = await sql(`select row_to_json(p)::text from college_policies p where college_id = '${mit}'`);

try {
  await sql(`delete from college_supplements where college_id = '${mit}' and admission_cycle = '${CYCLE}'`);

  // ---- Supplements ----------------------------------------------------------------
  const dry = load("supplements", GOOD, { dryRun: true });
  check("a dry run checks the file", dry.ok && /Dry run, nothing written/.test(dry.out), dry.out);
  check("a dry run writes nothing", (await rowsOf()) === "");

  const first = load("supplements", GOOD);
  check("a good file loads", first.ok && /Loaded 2 supplements rows for 1 schools/.test(first.out), first.out);
  const loaded = await rowsOf();
  check(
    "each prompt lands with its source and checked date",
    loaded ===
      "0|TEST short answer|TEST: Describe the world you come from, in brief.|200|universal||t|https://admissions.example.edu/test|2026-11-01\n" +
        "1|TEST engineering|TEST: Why engineering?|150|major|Engineering|f|https://admissions.example.edu/test|2026-11-02",
    loaded
  );

  const before = await stamps();
  const again = load("supplements", GOOD);
  check("a re-run succeeds", again.ok, again.out);
  check("a re-run keeps the same two rows", (await rowsOf()) === loaded && (await sql(`select count(*) from college_supplements where college_id = '${mit}' and admission_cycle = '${CYCLE}'`)) === "2");
  check("a re-run updates in place (same ids)", (await stamps()).split(",").map((s) => s.slice(0, 36)).join() === before.split(",").map((s) => s.slice(0, 36)).join());

  const edited = load("supplements", GOOD.replace("TEST: Why engineering?", '"TEST: Why engineering, really?"'));
  check("an edited prompt updates its slot", edited.ok && (await sql(`select prompt from college_supplements where college_id = '${mit}' and admission_cycle = '${CYCLE}' and sort_order = 1`)) === "TEST: Why engineering, really?", edited.out);

  const current = await rowsOf();
  const badFiles = {
    "a row with no source_url": GOOD + `166683,2098-99,2,TEST new,TEST: New prompt,100,,,,,2026-11-01\n`,
    "a row with no checked_on": GOOD + `166683,2098-99,2,TEST new,TEST: New prompt,100,,,,https://admissions.example.edu/test,\n`,
    "a row with an http source": GOOD + `166683,2098-99,2,TEST new,TEST: New prompt,100,,,,http://admissions.example.edu/test,2026-11-01\n`,
    "a row naming a slot twice": GOOD + `166683,2098-2099,0,TEST dup,TEST: Dup,100,,,,https://admissions.example.edu/test,2026-11-01\n`,
    "a school not in the catalog": GOOD + `999999,2098-99,2,TEST new,TEST: New prompt,100,,,,https://admissions.example.edu/test,2026-11-01\n`,
  };
  for (const [label, csv] of Object.entries(badFiles)) {
    const bad = load("supplements", csv.replace("TEST short answer", "TEST changed title"));
    check(`${label} fails the file`, !bad.ok && /nothing written|Not in the catalog/.test(bad.out), bad.out);
    check(`${label}: nothing is written, not even the good rows`, (await rowsOf()) === current);
  }

  // ---- Policies: the two new columns -------------------------------------------------
  const cols = await sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'college_policies' and column_name in ('personal_statement_read', 'test_reporting')`);
  check("the migration added both columns", cols === "2", cols);
  const pol = load(
    "policies",
    "unitid,personal_statement_read,test_reporting,source_url,checked_on\n166683,no,self-report,https://admissions.example.edu/test-policy,2026-11-03\n"
  );
  check("a policies file with the new columns loads", pol.ok, pol.out);
  check(
    "both land with their sources",
    (await sql(`select personal_statement_read || '|' || test_reporting || '|' || (sources->'test_reporting'->>'url') || '|' || (sources->'personal_statement_read'->>'checkedAt') from college_policies where college_id = '${mit}'`)) ===
      "false|self-report|https://admissions.example.edu/test-policy|2026-11-03"
  );
  const badPol = load("policies", "unitid,test_reporting,source_url\n166683,official,https://admissions.example.edu/x\n");
  check("an unknown test_reporting value fails the file", !badPol.ok && /test_reporting/.test(badPol.out), badPol.out);
  check("and changes nothing", (await sql(`select test_reporting from college_policies where college_id = '${mit}'`)) === "self-report");
  let refused = false;
  try {
    await sql(`update college_policies set test_reporting = 'official' where college_id = '${mit}'`);
  } catch {
    refused = true;
  }
  check("the database refuses an unknown test_reporting too", refused);
} finally {
  await sql(`delete from college_supplements where college_id = '${mit}' and admission_cycle = '${CYCLE}'`);
  if (policyBefore) {
    await sql(`delete from college_policies where college_id = '${mit}'`);
    await sql(`insert into college_policies select * from json_populate_record(null::college_policies, '${policyBefore.replace(/'/g, "''")}'::json)`);
  } else {
    await sql(`delete from college_policies where college_id = '${mit}'`);
  }
  rmSync(dir, { recursive: true, force: true });
}
