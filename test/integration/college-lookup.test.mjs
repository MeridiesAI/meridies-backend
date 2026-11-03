// Look up info & photo (POST /colleges/:id/lookup) and what it saves, college_site_info
// (migration 20261104000002). Real accounts on a local Supabase (see harness.mjs).
//
// Nothing here reaches a college's website, Wikimedia or a model: the route is only
// asked for answers it can give from a saved row (a fresh row for a school that already
// has a photo costs no fetch at all), plus the refusals that come before any work. The
// reading, the grounding and the deadline are unit tested with stand-ins
// (test/unit/college-site-info.test.ts, college-lookup-run.test.ts).
import { user, call, check, sql, rest, SB, ANON, API, CLIENT } from "./harness.mjs";

const c = await user("counselor-siteinfo");
const s = await user("student-siteinfo", "student");
const pending = await user("counselor-siteinfo-pending", "counselor", { approved: false });

check("the migration is applied", (await sql(`select to_regclass('public.college_site_info') is not null`)) === "t");

// A school the other college suites leave alone, with a website and a federal id.
const college = await sql(
  `select id from colleges where website is not null and unitid is not null and unitid not in (166683, 130794, 243744) order by unitid desc limit 1`
);
check("the catalog has a school with a website to look up", Boolean(college));
const unitid = await sql(`select unitid from colleges where id = '${college}'`);

const sha = "c".repeat(40);
const reset = async () => {
  await sql(`delete from college_site_info where college_id = '${college}'`);
  await sql(`delete from college_photos where college_id = '${college}'`);
};
await reset();
await sql(
  `insert into college_photos (college_id, source, wikidata_id, commons_title, commons_sha1, storage_path, thumb_path, width, height, credit, license, license_url, source_url)
   values ('${college}', 'pick', null, 'File:Siteinfo test.jpg', '${sha}', '${unitid}/${sha}-1280.jpg', '${unitid}/${sha}-500.jpg', 1280, 853,
           'Test photographer', 'CC0', null, 'https://commons.wikimedia.org/wiki/File:Siteinfo_test.jpg')`
);
const deadlines = JSON.stringify([{ plan: "ED", date: "November 1", evidence: "Early Decision applications are due November 1." }]);
const insertInfo = (days = 2, model = "'claude-haiku-4-5'") =>
  sql(
    `insert into college_site_info (college_id, source_url, pages, about, deadlines, test_policy, essays_recs, programs, fetched_at, model)
     values ('${college}', 'https://www.example.edu/', '["https://www.example.edu/", "https://www.example.edu/admissions"]', 'A small college.',
             '${deadlines}'::jsonb, 'Test-optional.', null, '["Biology", "Economics"]', now() - interval '${days} days', ${model})`
  );
await insertInfo();

try {
  // ---- Reads ---------------------------------------------------------------------
  const asCounselor = await rest(c.token, "GET", `/rest/v1/college_site_info?select=college_id,about&college_id=eq.${college}`);
  check("an approved counselor reads a saved row", asCounselor.status === 200 && asCounselor.body.length === 1, JSON.stringify(asCounselor.body));
  const asStudent = await rest(s.token, "GET", `/rest/v1/college_site_info?select=college_id&college_id=eq.${college}`);
  check("a student reads a saved row", asStudent.status === 200 && asStudent.body.length === 1);
  const asPending = await rest(pending.token, "GET", `/rest/v1/college_site_info?select=college_id&college_id=eq.${college}`);
  check("a pending counselor reads nothing (the approval gate)", asPending.status === 200 && asPending.body.length === 0, JSON.stringify(asPending.body));
  const anon = await fetch(`${SB}/rest/v1/college_site_info?select=college_id`, { headers: { apikey: ANON } });
  const anonBody = await anon.json();
  check("anon reads nothing", !anon.ok || (Array.isArray(anonBody) && anonBody.length === 0), `${anon.status} ${JSON.stringify(anonBody).slice(0, 200)}`);
  check(
    "the approval gate is on the table",
    (await sql(`select count(*) from pg_policy where polrelid = 'public.college_site_info'::regclass and polname = 'approval_gate' and not polpermissive`)) === "1"
  );

  // ---- Writes: service_role only ---------------------------------------------------
  const ins = await rest(c.token, "POST", "/rest/v1/college_site_info", {
    college_id: college, source_url: "https://www.example.edu/", pages: ["https://www.example.edu/"], about: "Forged",
  });
  check("a counselor can't insert a row", ins.status >= 400, `status ${ins.status}`);
  const upd = await rest(c.token, "PATCH", `/rest/v1/college_site_info?college_id=eq.${college}`, { about: "Someone else" }, { Prefer: "return=representation" });
  check("a counselor can't change a row", upd.status >= 400 || (Array.isArray(upd.body) && upd.body.length === 0), `status ${upd.status}`);
  const del = await rest(s.token, "DELETE", `/rest/v1/college_site_info?college_id=eq.${college}`, undefined, { Prefer: "return=representation" });
  check("a student can't delete a row", del.status >= 400 || (Array.isArray(del.body) && del.body.length === 0), `status ${del.status}`);
  check("the row is unchanged", (await sql(`select about from college_site_info where college_id = '${college}'`)) === "A small college.");

  // ---- The database's own shape rules ------------------------------------------------
  const refused = async (label, column, value) => {
    let ok = false;
    try {
      await sql(`update college_site_info set ${column} = ${value} where college_id = '${college}'`);
    } catch {
      ok = true;
    }
    check(label, ok);
  };
  await refused("an empty about is refused", "about", "'  '");
  await refused("an about over 1200 characters is refused", "about", `repeat('x', 1201)`);
  await refused("pages that are not a list are refused", "pages", `'{}'::jsonb`);
  await refused("no pages at all is refused", "pages", `'[]'::jsonb`);
  await refused("more than six pages is refused", "pages", `'["a","b","c","d","e","f","g"]'::jsonb`);
  await refused("deadlines that are not a list are refused", "deadlines", `'"soon"'::jsonb`);
  await refused("more than twelve deadlines is refused", "deadlines", `(select jsonb_agg(i) from generate_series(1, 13) i)`);
  await refused("more than twenty programs is refused", "programs", `(select jsonb_agg('p' || i) from generate_series(1, 21) i)`);
  await refused("a source that isn't a web address is refused", "source_url", "'javascript:alert(1)'");
  await refused("a model name over 100 characters is refused", "model", `repeat('m', 101)`);
  const before = await sql(`select updated_at from college_site_info where college_id = '${college}'`);
  await sql(`update college_site_info set test_policy = 'Test-flexible.' where college_id = '${college}'`);
  check("updated_at moves on update", (await sql(`select updated_at > '${before}'::timestamptz from college_site_info where college_id = '${college}'`)) === "t");
  await sql(`update college_site_info set test_policy = 'Test-optional.' where college_id = '${college}'`);

  // ---- GET /colleges/:id/extras carries it, scraped and apart from the curated facts ---
  for (const [label, who] of [["counselor", c], ["student", s]]) {
    const extras = await call(who.token, "GET", `/colleges/${college}/extras`);
    const info = extras.body?.siteInfo;
    check(
      `a ${label}'s extras carry the saved info`,
      extras.status === 200 && info?.about === "A small college." && info?.scraped === true && info?.testPolicy === "Test-optional." && info?.programs?.join() === "Biology,Economics",
      JSON.stringify(info)
    );
    check(
      `a ${label} reads the deadlines with their quote, the pages and an ISO time`,
      info?.deadlines?.[0]?.plan === "ED" && info?.deadlines?.[0]?.date === "November 1" && /^Early Decision/.test(info?.deadlines?.[0]?.evidence ?? "") &&
        info?.pages?.length === 2 && info?.sourceUrl === "https://www.example.edu/" && !Number.isNaN(Date.parse(info?.fetchedAt ?? "")) && info?.fetchedAt?.endsWith("Z"),
      JSON.stringify(info)
    );
    check(`a ${label}'s extras still carry the curated rounds, apart from it`, Array.isArray(extras.body?.rounds));
  }
  const extrasPending = await call(pending.token, "GET", `/colleges/${college}/extras`);
  check("a pending counselor is refused the extras", extrasPending.status === 403, `status ${extrasPending.status}`);

  // ---- POST /colleges/:id/lookup: the answer a saved row gives, and the refusals -----------
  // A fresh row (2 days) and a school that already has a photo: nothing is fetched.
  const empty = await call(c.token, "POST", `/colleges/${college}/lookup`);
  check("an empty body is a plain lookup", empty.status === 200, `status ${empty.status} ${JSON.stringify(empty.body).slice(0, 200)}`);
  check("it answers from the saved row: cached, the facts, no new photo", empty.body?.cached === true && empty.body?.info?.about === "A small college." && empty.body?.photo === null && empty.body?.collegeId === college, JSON.stringify(empty.body));
  check("the site block carries the saved page and description", empty.body?.site?.url === "https://www.example.edu/" && empty.body?.site?.description === "A small college.", JSON.stringify(empty.body?.site));
  check("with no note when nothing went wrong", empty.body?.photoNote === null && empty.body?.infoNote === null);
  const braces = await call(c.token, "POST", `/colleges/${college}/lookup`, {});
  check("{} is a plain lookup too", braces.status === 200 && braces.body?.cached === true, `status ${braces.status}`);
  const falseRefresh = await call(c.token, "POST", `/colleges/${college}/lookup`, { refresh: false });
  check("refresh: false is a plain lookup", falseRefresh.status === 200 && falseRefresh.body?.cached === true, `status ${falseRefresh.status}`);

  const badRefresh = await call(c.token, "POST", `/colleges/${college}/lookup`, { refresh: "yes" });
  check("a refresh that isn't a boolean is a 400", badRefresh.status === 400, `status ${badRefresh.status}`);
  const extraKey = await call(c.token, "POST", `/colleges/${college}/lookup`, { refresh: true, url: "http://169.254.169.254/" });
  check("an unknown field is a 400 (the body names no address to read)", extraKey.status === 400, `status ${extraKey.status}`);
  const unknown = await call(c.token, "POST", `/colleges/00000000-0000-4000-8000-00000000c011/lookup`);
  check("a college that isn't in the catalog is a 404", unknown.status === 404, `status ${unknown.status}`);
  const notUuid = await call(c.token, "POST", `/colleges/not-a-uuid/lookup`);
  check("an id that isn't a uuid is refused", notUuid.status === 400 || notUuid.status === 404, `status ${notUuid.status}`);
  const asStudentPost = await call(s.token, "POST", `/colleges/${college}/lookup`);
  check("a student can't look a school up", asStudentPost.status === 403, `status ${asStudentPost.status}`);
  const asPendingPost = await call(pending.token, "POST", `/colleges/${college}/lookup`);
  check("a pending counselor can't look a school up", asPendingPost.status === 403, `status ${asPendingPost.status}`);
  const noToken = await fetch(`${API}/colleges/${college}/lookup`, { method: "POST", headers: { ...CLIENT } });
  check("nobody signed out can", noToken.status === 401, `status ${noToken.status}`);
  check("none of that changed the saved row", (await sql(`select about || '|' || coalesce(model, 'null') from college_site_info where college_id = '${college}'`)) === "A small college.|claude-haiku-4-5");

  // ---- A school with nothing saved says null, never an error ---------------------------------
  await sql(`delete from college_site_info where college_id = '${college}'`);
  const bare = await call(c.token, "GET", `/colleges/${college}/extras`);
  check("without a saved row the extras say siteInfo: null", bare.status === 200 && bare.body?.siteInfo === null, JSON.stringify(bare.body?.siteInfo));
} finally {
  await reset().catch(() => {});
}
