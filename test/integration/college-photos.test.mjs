// Campus photos (migration 20261023070001): any signed-in user reads
// college_photos, nobody but service_role writes it or the public
// college-photos bucket, a pending counselor reads nothing, and the database
// refuses a non-free license on its own. Real accounts on a local Supabase
// (see harness.mjs). No test here reaches Wikidata or Commons.
import { user, call, check, sql, rest, SB, ANON, API, CRON_SECRET } from "./harness.mjs";

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

// ---- The loader on recorded answers, then every surface that shows a college ---------
// The fixture run is the real store against this database and bucket, with
// Wikidata and Commons replaced by test/fixtures/college-photos.
const { execFileSync } = await import("node:child_process");
const repo = new URL("../..", import.meta.url);
let loaded = false;
try {
  execFileSync("npx", ["tsx", "scripts/ingest/college-photos.ts", "--fixture-dir", "test/fixtures/college-photos", "--picks", "test/fixtures/college-photos/picks.csv", "--only", "166683,243744,130794"], { cwd: repo, env: process.env, stdio: "pipe" });
  loaded = true;
} catch (err) {
  console.log(String(err.stdout ?? ""), String(err.stderr ?? ""));
}
check("the fixture load runs", loaded);
check("MIT has its Wikidata photo, Stanford the team's pick, Yale none",
  (await sql(`select string_agg(c.slug || ':' || p.source, ',' order by c.slug) from college_photos p join colleges c on c.id = p.college_id where c.unitid in (166683, 243744, 130794)`)) === "mit:wikidata,stanford:pick");

const stanford = await sql(`select id from colleges where unitid = 243744 limit 1`);
const detail = await call(c.token, "GET", `/colleges/${mit}`);
const photo = detail.body.photo;
check("GET /colleges/:id carries the photo, both sizes", detail.status === 200 && /-1280\.jpg$/.test(photo?.url ?? "") && /-500\.jpg$/.test(photo?.thumbUrl ?? ""), JSON.stringify(photo));
check("with the attribution", photo?.credit === "José & Co." && photo?.license === "CC BY-SA 4.0" && photo?.licenseUrl === "https://creativecommons.org/licenses/by-sa/4.0" && /^https:\/\/commons\.wikimedia\.org\//.test(photo?.sourceUrl ?? "") && photo?.title === "File:Great dome of MIT, Feb 2021.jpg");
const img = await fetch(photo?.thumbUrl ?? "http://127.0.0.1:1/");
check("the thumbnail is public: no token needed", img.status === 200 && (img.headers.get("content-type") ?? "").startsWith("image/jpeg"), `status ${img.status}`);
const noPhoto = await call(c.token, "GET", `/colleges/${yale}`);
check("a college without a photo says null", noPhoto.status === 200 && noPhoto.body.photo === null);

const search = await call(c.token, "GET", `/colleges/search?q=${encodeURIComponent("Massachusetts Institute of Technology")}`);
const hit = Array.isArray(search.body) ? search.body.find((r) => r.id === mit) : null;
check("search cards carry the photo", /-500\.jpg$/.test(hit?.photo?.thumbUrl ?? ""), JSON.stringify(search.body).slice(0, 300));
const slug = await call(s.token, "GET", `/colleges/slug/mit`);
check("a card by slug carries it, for a student too", slug.status === 200 && slug.body.photo?.credit === "José & Co.");
const cmp = await call(c.token, "GET", `/colleges/compare?ids=${mit},${yale}`);
check("compare columns carry it, or null", cmp.status === 200 && cmp.body[0]?.college?.photo?.title === "File:Great dome of MIT, Feb 2021.jpg" && cmp.body[1]?.college?.photo === null);
const credits = await call(c.token, "GET", `/colleges/photo-credits?limit=500`);
check("the credits list names every photo with its full attribution", credits.status === 200 && credits.body.some((r) => r.collegeId === mit && r.photo.sourceUrl && r.photo.license), `status ${credits.status}`);
const pendingCredits = await call(pending.token, "GET", `/colleges/photo-credits`);
check("a pending counselor is refused", pendingCredits.status === 403, `status ${pendingCredits.status}`);

// The student's college list: the board, and the rows add and update answer with.
const token = `photos-${Date.now()}`;
await sql(`insert into invitations (counselor_id, email, token, source) values ('${c.id}', '${s.email}', '${token}', 'single')`);
const accepted = await fetch(`${SB}/rest/v1/rpc/accept_invitation`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_token: token }),
});
check("the student joins the roster", accepted.ok, `status ${accepted.status}`);
const added = await call(c.token, "POST", `/application/college-list`, { studentId: s.id, collegeId: mit });
check("adding a school answers with its photo", added.status === 201 && /-500\.jpg$/.test(added.body.collegePhoto?.thumbUrl ?? ""), JSON.stringify(added.body).slice(0, 300));
const patched = await call(c.token, "PATCH", `/application/college-list/${added.body.id}`, { notes: "photo check" });
check("an update keeps the photo", patched.status === 200 && patched.body.collegePhoto?.credit === "José & Co.");
await call(c.token, "POST", `/application/college-list`, { studentId: s.id, collegeId: yale });
const board = await call(s.token, "GET", `/application/college-list?studentId=${s.id}`);
const rowFor = (id) => board.body.rows?.find((r) => r.collegeId === id);
check("the board carries each school's photo, or null", board.status === 200 && rowFor(mit)?.collegePhoto?.title === "File:Great dome of MIT, Feb 2021.jpg" && rowFor(yale)?.collegePhoto === null, JSON.stringify(board.body).slice(0, 300));

// Events: an MIT listing on the student's Events tab and the counselor's hub.
const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
await sql(`insert into hub_events (name, kind, host, start_date, start_time, end_time, time_zone, place, url, college_id, audience, source)
  values ('MIT Info Session ${token}', 'virtual-visit', 'MIT', '${d(9)}', '19:00', '20:00', 'America/New_York', 'Online', 'https://mitadmissions.org/visit/', '${mit}', 'everyone', 'csv')`);
const mine = await call(s.token, "GET", `/me/events`);
const ev = (mine.body.forYourColleges ?? []).find((e) => e.name === `MIT Info Session ${token}`);
check("the student's Events tab carries the college's photo", /-500\.jpg$/.test(ev?.college?.photo?.thumbUrl ?? ""), JSON.stringify(mine.body).slice(0, 300));
const hub = await call(c.token, "GET", `/events`);
const hubItems = JSON.stringify(hub.body);
check("the Events Hub carries it too", hub.status === 200 && hubItems.includes(`MIT Info Session ${token}`) && hubItems.includes("-500.jpg"), `status ${hub.status}`);

// Alumni: where an alum enrolled.
await sql(`insert into alumni_records (student_id, counselor_id, cycle, college_id, institution_name) values ('${s.id}', '${c.id}', '2025-2026', '${mit}', 'Massachusetts Institute of Technology') on conflict (student_id) do nothing`);
const alumni = await call(c.token, "GET", `/alumni`);
const alum = Array.isArray(alumni.body) ? alumni.body.find((a) => a.studentId === s.id) : null;
check("an alum's college carries its photo", alum?.institution?.photo?.credit === "José & Co.", JSON.stringify(alum));
