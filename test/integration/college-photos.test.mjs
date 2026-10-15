// Campus photos (migration 20261023070001): any signed-in user reads
// college_photos, nobody but service_role writes it or the public
// college-photos bucket, a pending counselor reads nothing, and the database
// refuses a non-free license on its own. Real accounts on a local Supabase
// (see harness.mjs). No test here reaches Wikidata or Commons.
import { user, check, sql, rest, SB, ANON, API, CRON_SECRET } from "./harness.mjs";

const c = await user("counselor-photos");
const s = await user("student-photos", "student");
const pending = await user("counselor-photos-pending", "counselor", { approved: false });

const mit = await sql(`select id from colleges where unitid = 166683 limit 1`);
const yale = await sql(`select id from colleges where unitid = 130794 limit 1`);
check("the catalog has MIT and Yale", Boolean(mit && yale), `${mit} ${yale}`);

const sha = "a".repeat(40);
const insertRow = (collegeId, unitid) =>
  `insert into college_photos (college_id, source, wikidata_id, commons_title, commons_sha1, storage_path, thumb_path, width, height, credit, license, license_url, source_url)
   values ('${collegeId}', 'wikidata', 'Q49108', 'File:Test photo.jpg', '${sha}', '${unitid}/${sha}-1280.jpg', '${unitid}/${sha}-500.jpg', 1280, 853,
           'Example Photographer', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0', 'https://commons.wikimedia.org/wiki/File:Test_photo.jpg')
   on conflict (college_id) do update set credit = excluded.credit`;
await sql(insertRow(mit, 166683));

// ---- Reads -------------------------------------------------------------------
const asCounselor = await rest(c.token, "GET", `/rest/v1/college_photos?select=college_id,credit&college_id=eq.${mit}`);
check("an approved counselor reads a photo row", asCounselor.status === 200 && asCounselor.body.length === 1, JSON.stringify(asCounselor.body));
const asStudent = await rest(s.token, "GET", `/rest/v1/college_photos?select=college_id&college_id=eq.${mit}`);
check("a student reads a photo row", asStudent.status === 200 && asStudent.body.length === 1);
const asPending = await rest(pending.token, "GET", `/rest/v1/college_photos?select=college_id&college_id=eq.${mit}`);
check("a pending counselor reads nothing (the approval gate)", asPending.status === 200 && asPending.body.length === 0, JSON.stringify(asPending.body));
const anon = await fetch(`${SB}/rest/v1/college_photos?select=college_id`, { headers: { apikey: ANON } });
const anonBody = await anon.json();
check("anon reads nothing", !anon.ok || (Array.isArray(anonBody) && anonBody.length === 0), `${anon.status} ${JSON.stringify(anonBody).slice(0, 200)}`);
check("the approval gate is on the table", (await sql(`select count(*) from pg_policy where polrelid = 'public.college_photos'::regclass and polname = 'approval_gate' and not polpermissive`)) === "1");

// ---- Writes ------------------------------------------------------------------
const ins = await rest(c.token, "POST", "/rest/v1/college_photos", {
  college_id: yale, source: "pick", commons_title: "File:X.jpg", commons_sha1: sha,
  storage_path: `130794/${sha}-1280.jpg`, thumb_path: `130794/${sha}-500.jpg`, credit: "x", license: "CC0",
  source_url: "https://commons.wikimedia.org/wiki/File:X.jpg",
});
check("a counselor can't insert a photo", ins.status >= 400, `status ${ins.status}`);
const upd = await rest(c.token, "PATCH", `/rest/v1/college_photos?college_id=eq.${mit}`, { credit: "Someone else" }, { Prefer: "return=representation" });
check("a counselor can't change a credit", upd.status >= 400 || (Array.isArray(upd.body) && upd.body.length === 0), `status ${upd.status}`);
const del = await rest(s.token, "DELETE", `/rest/v1/college_photos?college_id=eq.${mit}`, undefined, { Prefer: "return=representation" });
check("a student can't delete a photo", del.status >= 400 || (Array.isArray(del.body) && del.body.length === 0), `status ${del.status}`);
check("the row is unchanged", (await sql(`select credit from college_photos where college_id = '${mit}'`)) === "Example Photographer");

// ---- The database's own license rule -------------------------------------------
const refused = async (label, column, value) => {
  let ok = false;
  try {
    await sql(`update college_photos set ${column} = ${value} where college_id = '${mit}'`);
  } catch {
    ok = true;
  }
  check(label, ok);
};
await refused("a non-commercial license is refused", "license", "'CC BY-NC-SA 2.0'");
await refused("a no-derivatives license is refused", "license", "'CC BY-ND 4.0'");
await refused("GFDL alone is refused", "license", "'GFDL'");
await refused("an empty credit is refused", "credit", "'  '");
await refused("a credit over 500 characters is refused", "credit", `repeat('x', 501)`);
await refused("a storage path outside <unitid>/<sha1>-1280.jpg is refused", "storage_path", "'../other/x.jpg'");
await refused("a source outside Commons is refused", "source_url", "'https://example.com/x.jpg'");
await sql(`update college_photos set license = 'Public domain' where college_id = '${mit}'`);
check("public domain is allowed", (await sql(`select license from college_photos where college_id = '${mit}'`)) === "Public domain");
const before = await sql(`select updated_at from college_photos where college_id = '${mit}'`);
await sql(`update college_photos set license = 'CC BY-SA 4.0' where college_id = '${mit}'`);
check("updated_at moves on update", (await sql(`select updated_at > '${before}'::timestamptz from college_photos where college_id = '${mit}'`)) === "t");

// ---- The bucket ----------------------------------------------------------------
check("the college-photos bucket is public and JPEG-only", (await sql(`select public::text || ',' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'college-photos'`)) === "true,image/jpeg");
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
for (const [label, who] of [["counselor", c], ["student", s]]) {
  const up = await rest(who.token, "POST", `/storage/v1/object/college-photos/166683/${"b".repeat(40)}-500.jpg`, jpeg, { "Content-Type": "image/jpeg" });
  // Storage answers 400 with the policy's 403 inside: refused by RLS, not by the file.
  check(`a ${label} can't upload to the photos bucket`, up.status === 403 || String(up.body?.statusCode) === "403", `${up.status} ${JSON.stringify(up.body)}`);
}
check("labels: ingest_runs and job_heartbeats accept college-photos", (await sql(`select count(*) from job_heartbeats where job = 'college-photos'`)) === "1");

// ---- The monthly cron route --------------------------------------------------------
// Never started for real here: CI has no business calling Wikidata or Commons.
// Without the secret it's 401; with the lease already held it's 409 and nothing runs.
const noSecret = await fetch(`${API}/internal/ingest/college-photos`, { method: "POST" });
check("the photo cron needs the secret", noSecret.status === 401 || noSecret.status === 503, `status ${noSecret.status}`);
const holder = `test-${Date.now()}`;
const held = await sql(`select public.acquire_job_lease('college-photos', '${holder}', 120)`);
if (held === "t") {
  const busy = await fetch(`${API}/internal/ingest/college-photos`, { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  check("while a load holds the lease, the cron answers 409", busy.status === 409, `status ${busy.status}`);
  await sql(`select public.release_job_lease('college-photos', '${holder}')`);
} else {
  check("the test could take the photo lease", false, "skipped the 409 check rather than start a real run");
}
