// The reviewer's ways around the campus photo review gate, each a crowd edit
// timed around the monthly run, and each must leave the app showing what it
// showed before:
//   - CMU: the file is swapped while the run downloads it, then the old
//     version is uploaded back (same sha1), so a later run would never look
//     again. The run asks Commons again after downloading and keeps nothing.
//   - CWRU: the file is swapped after the metadata read, before the downloads.
//   - NYU: the team picks the title Wikidata already shows, and a vandal
//     uploaded a new version over it yesterday. Still a replacement.
//   - RIT: the team's picked title is now a redirect to a vandal's file.
//   - Syracuse: a new version seen and held by a run a month ago, reverted,
//     then uploaded again an hour before this run. The old sighting no longer
//     counts; the wait starts again.
//   - Pitt: the credit changes through a transcluded template (the page's own
//     revision is old, its touched time isn't). The credit shown stays.
//
// The loader runs through scripts/ingest/college-photos.ts on the fixtures in
// test/fixtures/college-photos/attacks (nothing reaches Wikimedia), with
// --now pinning the clock.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { user, call, check, sql } from "./harness.mjs";

const c = await user("counselor-photo-attacks");
const ids = {};
for (const [slug, unitid] of Object.entries({ cmu: 211440, cwru: 201645, nyu: 193900, rit: 195003, syr: 196413, pitt: 215293 })) {
  ids[slug] = await sql(`select id from colleges where unitid = ${unitid} limit 1`);
}
check("the catalog has the six colleges", Object.values(ids).every(Boolean), JSON.stringify(ids));
const all = Object.values(ids).map((id) => `'${id}'`).join(", ");

const repo = new URL("../..", import.meta.url);
const DIR = "test/fixtures/college-photos/attacks";
const NOW = "2026-10-15T01:00:00Z";
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const LICENSE = "CC BY-SA 4.0";
const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0";

function load({ now = NOW, dryRun = false } = {}) {
  const args = ["tsx", "scripts/ingest/college-photos.ts", "--fixture-dir", DIR, "--picks", `${DIR}/picks.csv`, "--only", "211440,201645,193900,195003,196413,215293", "--now", now];
  if (dryRun) args.push("--dry-run");
  try {
    return { ok: true, out: execFileSync("npx", args, { cwd: repo, env: process.env, stdio: "pipe" }).toString() };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}
const hasTable = async () => (await sql(`select to_regclass('public.college_photo_candidates') is not null`)) === "t";
const photoOf = async (id) => sql(`select coalesce(commons_title || '|' || commons_sha1 || '|' || credit, '') from college_photos where college_id = '${id}'`);
const storedRow = (id, unitid, title, sha, credit) =>
  sql(`insert into college_photos (college_id, source, wikidata_id, commons_title, commons_sha1, storage_path, thumb_path, width, height, credit, license, license_url, source_url)
       values ('${id}', 'wikidata', null, '${title}', '${sha}', '${unitid}/${sha}-1280.jpg', '${unitid}/${sha}-500.jpg', 1280, 853, '${credit}', '${LICENSE}', '${LICENSE_URL}',
               'https://commons.wikimedia.org/wiki/${title.replace(/ /g, "_")}')`);

await sql(`delete from college_photos where college_id in (${all})`);
const table = await hasTable();
if (table) await sql(`delete from college_photo_candidates where college_id in (${all})`);

const NYU = "File:NYU Bobst Library.jpg";
const SYR = "File:Syracuse Hall of Languages.jpg";
const PITT = "File:Cathedral of Learning.jpg";
await storedRow(ids.nyu, 193900, NYU, sha1(`${NYU}#v1`), "Bobst Photographer");
await storedRow(ids.syr, 196413, SYR, sha1(`${SYR}#v1`), "Languages Photographer");
await storedRow(ids.pitt, 215293, PITT, sha1(PITT), "Real Photographer");
if (table) {
  // A month ago a run saw Syracuse's version 2 and held it. It was reverted, then uploaded again on 2026-10-14 23:00.
  const textHash = sha1(`${LICENSE}\nLanguages Photographer\n${LICENSE_URL}`);
  await sql(`insert into college_photo_candidates (college_id, source, commons_title, commons_sha1, text_hash, reasons, first_seen_at, last_seen_at)
             values ('${ids.syr}', 'wikidata', '${SYR}', '${sha1(`${SYR}#v2`)}', '${textHash}', '{replacement}', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')`);
}

const run = load();
check("the run goes through", run.ok, run.out.slice(-800));
check("CMU: a file swapped during the downloads and reverted is not stored", (await photoOf(ids.cmu)) === "", await photoOf(ids.cmu));
check("CWRU: a file swapped before the downloads is not stored", (await photoOf(ids.cwru)) === "", await photoOf(ids.cwru));
check("the run counted both as changed during the run", /"changed-during-run": 2/.test(run.out), run.out.slice(-1500));
check("nothing for them reached the bucket", (await sql(`select count(*) from storage.objects where bucket_id = 'college-photos' and (name like '211440/%' or name like '201645/%')`)) === "0");
check("NYU: picking the title Wikidata shows doesn't publish a version uploaded yesterday", (await photoOf(ids.nyu)) === `${NYU}|${sha1(`${NYU}#v1`)}|Bobst Photographer`, await photoOf(ids.nyu));
check("RIT: a picked title that now redirects to another file is not published", (await photoOf(ids.rit)) === "", await photoOf(ids.rit));
check("Syracuse: a version re-applied after its sighting doesn't replace the photo", (await photoOf(ids.syr)) === `${SYR}|${sha1(`${SYR}#v1`)}|Languages Photographer`, await photoOf(ids.syr));
check("Pitt: a credit changed through a template isn't shown", (await photoOf(ids.pitt)) === `${PITT}|${sha1(PITT)}|Real Photographer`, await photoOf(ids.pitt));
if (table) {
  const syrSeen = await sql(`select first_seen_at at time zone 'UTC' from college_photo_candidates where college_id = '${ids.syr}'`);
  check("Syracuse's wait starts again from this run", syrSeen.startsWith("2026-10-15 01:00"), syrSeen);
  const queue = await sql(`select string_agg(commons_title || ':' || array_to_string(reasons, ';'), ',' order by commons_title) from college_photo_candidates where college_id in (${all})`);
  check("the queue says why each waits", /NYU Bobst Library\.jpg:file-recent;replacement/.test(queue) && /RIT vandal target\.jpg:pick-redirected/.test(queue) && /Cathedral of Learning\.jpg:text-changed;page-recent/.test(queue), queue);
}

const pittCard = await call(c.token, "GET", `/colleges/${ids.pitt}`);
check("the app still credits Pitt's photo to its photographer", pittCard.status === 200 && pittCard.body.photo?.credit === "Real Photographer", JSON.stringify(pittCard.body.photo));
const cmuCard = await call(c.token, "GET", `/colleges/${ids.cmu}`);
check("the app shows no photo for CMU", cmuCard.status === 200 && cmuCard.body.photo === null, JSON.stringify(cmuCard.body.photo));

const dry = load({ dryRun: true });
check("a dry run goes through", dry.ok, dry.out.slice(-400));
check("the dry-run CSV lists the held pick and the held credit for the team", /^held-new,195003,.*pick-redirected$/m.test(dry.out) && /^held-text,215293,.*Vandal Template Credit.*text-changed;page-recent$/m.test(dry.out), dry.out.slice(0, 1200));

await sql(`delete from college_photos where college_id in (${all})`);
if (table) await sql(`delete from college_photo_candidates where college_id in (${all})`);
