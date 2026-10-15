// Campus photos are not published the moment Wikidata or Commons says so.
// Each attack here is a crowd edit landing just before a run: a vandal's main
// image (P18) on a college's Wikidata item, and a new version uploaded over a
// college's existing Commons file. Neither may reach the app on that run; the
// old photo keeps serving, the change waits in the review queue
// (college_photo_candidates) until it has been stable for a week, and a later
// run publishes it. A team pick is published at once. The dry-run CSV the
// team reviews never hands a spreadsheet a formula.
//
// The loader runs through scripts/ingest/college-photos.ts on the fixtures in
// test/fixtures/college-photos/review (nothing reaches Wikimedia), with
// --now pinning the clock the fixtures' timestamps are read against.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { user, call, check, sql } from "./harness.mjs";

const c = await user("counselor-photo-review");
const colgate = await sql(`select id from colleges where unitid = 190099 limit 1`);
const ithaca = await sql(`select id from colleges where unitid = 191968 limit 1`);
check("the catalog has Colgate and Ithaca College", Boolean(colgate && ithaca), `${colgate} ${ithaca}`);

const repo = new URL("../..", import.meta.url);
const DIR = "test/fixtures/college-photos/review";
const DAY0 = "2026-10-15T00:00:00Z"; // the fixtures' changes are from 2026-10-14
const at = (days) => new Date(Date.parse(DAY0) + days * 86400000).toISOString();
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const V1 = sha1("File:Colgate Memorial Chapel.jpg#v1");
const V2 = sha1("File:Colgate Memorial Chapel.jpg#v2");
const VANDAL = "File:Ithaca campus vandal.jpg";

function load({ now, picks = "picks-empty.csv", dryRun = false } = {}) {
  const args = ["tsx", "scripts/ingest/college-photos.ts", "--fixture-dir", DIR, "--picks", `${DIR}/${picks}`, "--only", "190099,191968", "--now", now];
  if (dryRun) args.push("--dry-run");
  try {
    return { ok: true, out: execFileSync("npx", args, { cwd: repo, env: process.env, stdio: "pipe" }).toString() };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}
const hasTable = async () => (await sql(`select to_regclass('public.college_photo_candidates') is not null`)) === "t";
const photoOf = async (id) => sql(`select coalesce(commons_title || '|' || commons_sha1, '') from college_photos where college_id = '${id}'`);
const reset = async () => {
  await sql(`delete from college_photos where college_id in ('${colgate}', '${ithaca}')`);
  if (await hasTable()) await sql(`delete from college_photo_candidates where college_id in ('${colgate}', '${ithaca}')`);
  // Colgate's photo as an earlier run stored it: version 1 of its file.
  await sql(`insert into college_photos (college_id, source, wikidata_id, commons_title, commons_sha1, storage_path, thumb_path, width, height, credit, license, license_url, source_url)
    values ('${colgate}', 'wikidata', 'Q1110520', 'File:Colgate Memorial Chapel.jpg', '${V1}', '190099/${V1}-1280.jpg', '190099/${V1}-500.jpg', 1280, 853,
            'Chapel Photographer', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0', 'https://commons.wikimedia.org/wiki/File:Colgate_Memorial_Chapel.jpg')`);
};
await reset();

// ---- The run right after the edits ----------------------------------------------------
const day0 = load({ now: DAY0 });
check("the run goes through", day0.ok, day0.out.slice(-600));
check("a main image a vandal set on Wikidata yesterday is not published", (await photoOf(ithaca)) === "", await photoOf(ithaca));
check("a new version uploaded over a college's Commons file yesterday doesn't replace its photo", (await photoOf(colgate)) === `File:Colgate Memorial Chapel.jpg|${V1}`, await photoOf(colgate));
const ithacaCard = await call(c.token, "GET", `/colleges/${ithaca}`);
check("the app shows no photo for the vandalised college", ithacaCard.status === 200 && ithacaCard.body.photo === null, JSON.stringify(ithacaCard.body.photo));
const colgateCard = await call(c.token, "GET", `/colleges/${colgate}`);
check("the app keeps serving the old photo", colgateCard.status === 200 && (colgateCard.body.photo?.url ?? "").includes(`${V1}-1280.jpg`), JSON.stringify(colgateCard.body.photo));

const queue = (await hasTable())
  ? await sql(`select string_agg(college_id::text || '|' || commons_title || '|' || array_to_string(reasons, ';'), ',' order by commons_title) from college_photo_candidates where college_id in ('${colgate}', '${ithaca}')`)
  : "";
check("both changes wait in the review queue, with why", queue.includes(`${colgate}|File:Colgate Memorial Chapel.jpg|`) && queue.includes(`${ithaca}|${VANDAL}|`) && /replacement/.test(queue) && /wikidata-recent/.test(queue) && /file-recent/.test(queue), queue);
const counts = await sql(`select coalesce(counts::text, '') from ingest_runs where source = 'college-photos' order by started_at desc limit 1`).catch(() => "");
check("the run's ingest_runs row counts what it held", /"held-new": 1/.test(counts) && /"held-replace": 1/.test(counts), counts);

// ---- The dry-run CSV the team opens in a spreadsheet ----------------------------------
const dry = load({ now: DAY0, dryRun: true });
check("a dry run goes through", dry.ok, dry.out.slice(-400));
const csvLines = dry.out.split("\n").filter((l) => /^[a-z-]+,1[0-9]{5},/.test(l) || /,1[0-9]{5},/.test(l));
const ithacaLine = csvLines.find((l) => l.includes(VANDAL)) ?? "";
check("the dry run lists the held vandal photo for review", ithacaLine.startsWith("held-new,191968,") && /wikidata-recent/.test(ithacaLine), dry.out.slice(0, 600));
/** Cells of one CSV line, quotes undone. */
const cells = (line) => {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};
const formulaCells = csvLines.flatMap(cells).filter((v) => /^[ ]*[=+\-@\t\r]/.test(v));
check("no CSV cell starts a formula (a Commons credit of =HYPERLINK(...) is defused)", ithacaLine.includes("HYPERLINK") && formulaCells.length === 0, JSON.stringify(formulaCells));

// ---- A day later: still held -------------------------------------------------------------
const day1 = load({ now: at(1) });
check("a day later both are still held", day1.ok && (await photoOf(ithaca)) === "" && (await photoOf(colgate)).endsWith(V1));

// ---- A week on, unchanged: published ----------------------------------------------------
const day8 = load({ now: at(8) });
check("a week on, the run goes through", day8.ok, day8.out.slice(-600));
check("the new main image, stable for a week, is published", (await photoOf(ithaca)) === `${VANDAL}|${sha1(VANDAL)}`, await photoOf(ithaca));
check("the replacement, seen unchanged a week apart, is published", (await photoOf(colgate)) === `File:Colgate Memorial Chapel.jpg|${V2}`, await photoOf(colgate));
check("the review queue is empty for them", !(await hasTable()) || (await sql(`select count(*) from college_photo_candidates where college_id in ('${colgate}', '${ithaca}')`)) === "0");

// ---- A team pick is published at once -------------------------------------------------
await reset();
const picked = load({ now: DAY0, picks: "picks-ithaca.csv" });
check("a team pick of a file uploaded yesterday is published on the same run", picked.ok && (await photoOf(ithaca)).startsWith("File:Ithaca fresh pick.jpg|"), await photoOf(ithaca));

// ---- Without the review migration: replacements wait, the run still works ---------------
if (await hasTable()) {
  await reset();
  const countsColumn = (await sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'ingest_runs' and column_name = 'counts'`)) === "1";
  await sql(`alter table public.college_photo_candidates rename to college_photo_candidates_off`);
  if (countsColumn) await sql(`alter table public.ingest_runs rename column counts to counts_off`);
  await sql(`notify pgrst, 'reload schema'`);
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const before = await sql(`select count(*) from ingest_runs where source = 'college-photos' and finished_at is not null`);
    const old = load({ now: at(30) });
    check("without the review table the run still goes through", old.ok, old.out.slice(-600));
    check("the run knew it had no review queue", /"reviewTable": false/.test(old.out) && /"hold:no-review-table": 1/.test(old.out), old.out.slice(-800));
    check("and a replacement is held: nothing remembers having seen it", (await photoOf(colgate)).endsWith(V1), await photoOf(colgate));
    check("its ingest_runs row is still finished without the counts column", Number(await sql(`select count(*) from ingest_runs where source = 'college-photos' and finished_at is not null`)) === Number(before) + 1);
  } finally {
    await sql(`alter table public.college_photo_candidates_off rename to college_photo_candidates`);
    if (countsColumn) await sql(`alter table public.ingest_runs rename column counts_off to counts`);
    await sql(`notify pgrst, 'reload schema'`);
  }
}
await sql(`delete from college_photos where college_id in ('${colgate}', '${ithaca}')`);
