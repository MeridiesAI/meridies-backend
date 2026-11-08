// Cited catalog proposals (item 16b): the proposer reads a school's own pages and writes PENDING proposals only;
// a catalog editor's approval is what writes college_supplements / college_policies, with the source and
// source_verified_at, in one transaction with the status change. Needs an API with RESEARCH_FAKE=fixture (the
// stack default and CI's), so no page is fetched and no model is called (src/lib/catalogProposalsFake.ts).
// Uses its own fake college (unitid 999161, t16b-fixture.edu) and deletes it, and everything under it, at the end.
import { execFileSync } from "node:child_process";
import { API, CLIENT, CRON_SECRET, call, check, rest, sql, sqlAsync, user } from "./harness.mjs";

const UNITID = 999161;
/** `insert ... returning id` prints the id, then the command tag: keep the id. */
const returning = async (q) => (await sql(q)).split("\n")[0].trim();
const SITE = "https://www.t16b-fixture.edu";
const cron = async (body, secret = CRON_SECRET) => {
  const r = await fetch(`${API}/internal/catalog/propose`, {
    method: "POST",
    headers: { ...CLIENT, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const repo = new URL("../..", import.meta.url);
function script(args, extraEnv = {}) {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/ingest/propose-catalog.ts", ...args], {
      cwd: repo,
      env: { ...process.env, RESEARCH_FAKE: "fixture", NODE_ENV: "test", ...extraEnv },
      stdio: "pipe",
    });
    return { ok: true, out: out.toString() };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}
const cycle = (() => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const s = d.getUTCMonth() >= 7 ? y : y - 1;
  return `${s}-${s + 1}`;
})();

await sql(`delete from public.colleges where unitid = ${UNITID}`);
const college = await returning(
  `insert into public.colleges (name, slug, website, unitid, catalog_source) values ('T16B Fixture University', 't16b-fixture-university', '${SITE}', ${UNITID}, 'scorecard') returning id`
);
const noSite = await returning(
  `insert into public.colleges (name, slug, unitid, catalog_source) values ('T16B No Site College', 't16b-no-site-college', ${UNITID + 1}, 'scorecard') returning id`
);
const editor = await user("t16b-editor");
const counselor = await user("t16b-counselor");
await sql(`insert into public.catalog_editors (profile_id) values ('${editor.id}')`);
const propRows = () => sql(`select string_agg(field || ':' || status, ',' order by field) from public.catalog_change_proposals where college_id = '${college}'`);
const propId = (field) => sql(`select id from public.catalog_change_proposals where college_id = '${college}' and field = '${field}' and status = 'pending' limit 1`);

try {
  // ---- The machine route ----------------------------------------------------------------
  check("no secret, no run", (await cron({ collegeId: college }, "wrong-secret-wrong-secret-wrong-secret")).status === 401);
  check("a college that isn't in the catalog is a 404", (await cron({ collegeId: "00000000-0000-4000-8000-000000000000" })).status === 404);
  check("a college with no website is a 400", (await cron({ collegeId: noSite })).status === 400);

  const dry = await cron({ unitid: UNITID, dryRun: true });
  check("a dry run says what it would propose", dry.status === 200 && dry.body.candidates?.length === 3 && dry.body.proposed === 0, JSON.stringify(dry.body));
  check("a dry run writes nothing", (await propRows()) === "");

  // ---- The script: local stack only ---------------------------------------------------------
  const prod = script(["--unitid", String(UNITID), "--dry-run"], { SUPABASE_URL: "https://kerstlpuvpmstiavxblv.supabase.co" });
  check("the script refuses the production project", !prod.ok && /Refusing to run/.test(prod.out), prod.out);
  const remote = script(["--unitid", String(UNITID), "--dry-run"], { SUPABASE_URL: "https://db.example.com" });
  check("the script refuses any address that isn't this machine", !remote.ok && /not a localhost address/.test(remote.out), remote.out);
  const sDry = script(["--unitid", String(UNITID), "--dry-run"]);
  check("the script's dry run lists the three facts and writes nothing", sDry.ok && /Dry run, nothing written/.test(sDry.out) && (sDry.out.match(/^ {2}\S/gm) ?? []).length === 3 && (await propRows()) === "", sDry.out);

  const first = await cron({ collegeId: college });
  check("a run proposes the three facts the pages support", first.status === 200 && first.body.proposed === 3, JSON.stringify(first.body));
  check("the made-up quote is dropped and counted", first.body.droppedNoQuote === 1);
  check("the candidate cited from another domain is dropped and counted", first.body.droppedOffDomain === 1);
  check(
    "only the school's own pages were read",
    Array.isArray(first.body.pagesRead) && first.body.pagesRead.length === 3 && first.body.pagesRead.every((u) => /^https:\/\/(www\.|apply\.)t16b-fixture\.edu\//.test(u)),
    JSON.stringify(first.body.pagesRead)
  );
  check("all three are pending", (await propRows()) === "personal_statement_read:pending,supplement:pending,test_reporting:pending", await propRows());
  check(
    "each carries an https source, its quote, the cycle and no proposer",
    Number(await sql(`select count(*) from public.catalog_change_proposals where college_id = '${college}' and source_url like 'https://%' and length(evidence) >= 12 and admission_cycle = '${cycle}' and proposed_by is null and fact_key is not null`)) === 3
  );
  check("nothing reached the curated tables", (await sql(`select count(*) from public.college_supplements where college_id = '${college}'`)) === "0" && (await sql(`select count(*) from public.college_policies where college_id = '${college}'`)) === "0");

  const again = await cron({ collegeId: college });
  check("a second run proposes nothing new", again.status === 200 && again.body.proposed === 0 && again.body.duplicates === 3, JSON.stringify(again.body));
  check("...and the table still has three", Number(await sql(`select count(*) from public.catalog_change_proposals where college_id = '${college}'`)) === 3);

  // ---- The database refuses a malformed proposal ------------------------------------------------
  let refused = false;
  try {
    // sqlAsync keeps psql's expected ERROR line out of the output.
    await sqlAsync(`insert into public.catalog_change_proposals (college_id, field, proposed_value, source_url, evidence, admission_cycle, fact_key, payload)
               values ('${college}', 'supplement', '${cycle}#9', 'http://www.t16b-fixture.edu/x', 'a quote that is long enough', '${cycle}', repeat('a', 64), '{"cycle":"${cycle}","sortOrder":9,"title":"t","prompt":"p","wordLimit":null}')`);
  } catch {
    refused = true;
  }
  check("a new-kind proposal with an http source is refused by the table", refused);
  check("a counselor can't write a proposal", (await rest(counselor.token, "POST", "/rest/v1/catalog_change_proposals", { college_id: college, field: "superscore", proposed_value: "both", source_url: "https://x.edu" })).status >= 400);

  // ---- Who sees them ----------------------------------------------------------------------------
  const cList = await call(counselor.token, "GET", "/colleges/proposals?status=pending");
  check("a counselor doesn't see system proposals", cList.status === 200 && !cList.body.some((p) => p.collegeId === college), JSON.stringify(cList.body).slice(0, 200));
  const eList = await call(editor.token, "GET", "/colleges/proposals?status=pending");
  const mine = Array.isArray(eList.body) ? eList.body.filter((p) => p.collegeId === college) : [];
  check("an editor sees all three pending", eList.status === 200 && mine.length === 3, JSON.stringify(eList.body).slice(0, 300));
  const supp = mine.find((p) => p.field === "supplement");
  check(
    "the supplement carries its payload and cycle",
    supp?.admissionCycle === cycle && supp?.payload?.sortOrder === 0 && supp?.payload?.wordLimit === 250 && /^Why do you want to attend/.test(supp?.payload?.prompt ?? ""),
    JSON.stringify(supp)
  );

  // ---- Review ----------------------------------------------------------------------------------
  const suppId = await propId("supplement");
  const nonEditor = await call(counselor.token, "POST", `/colleges/proposals/${suppId}/review`, { decision: "approve" });
  check("a non-editor can't review", nonEditor.status === 403, JSON.stringify(nonEditor.body));
  check("...and nothing changed", (await sql(`select status from public.catalog_change_proposals where id = '${suppId}'`)) === "pending" && (await sql(`select count(*) from public.college_supplements where college_id = '${college}'`)) === "0");
  const rpc = await rest(counselor.token, "POST", "/rest/v1/rpc/review_catalog_proposal", { p_id: suppId, p_decision: "approve" });
  check("a non-editor can't call the review function directly either", rpc.status >= 400 && (await sql(`select status from public.catalog_change_proposals where id = '${suppId}'`)) === "pending", JSON.stringify(rpc.body));

  const ok = await call(editor.token, "POST", `/colleges/proposals/${suppId}/review`, { decision: "approve", note: "checked the page" });
  check("an editor approves the supplement", ok.status === 200 && ok.body.status === "approved", JSON.stringify(ok.body));
  const row = await sql(
    `select concat_ws('|', admission_cycle, sort_order, word_limit, source_url like 'https://apply.t16b-fixture.edu/essays%', source_verified_at > now() - interval '5 minutes', prompt like 'Why do you want to attend%')
       from public.college_supplements where college_id = '${college}'`
  );
  check("the college_supplements row appears, at slot 0 for a school with none, with its source and verified time", row === `${cycle}|0|250|t|t|t`, row);
  check(
    "the proposal records the editor and the time",
    (await sql(`select concat_ws('|', status, reviewed_by, reviewed_at is not null, review_note) from public.catalog_change_proposals where id = '${suppId}'`)) === `approved|${editor.id}|t|checked the page`
  );
  const twice = await call(editor.token, "POST", `/colleges/proposals/${suppId}/review`, { decision: "approve" });
  check("approving twice is a clear error", twice.status === 400 && /already reviewed/i.test(twice.body.message ?? twice.body.error ?? ""), JSON.stringify(twice.body));
  check("...and writes nothing more", (await sql(`select count(*) from public.college_supplements where college_id = '${college}'`)) === "1");

  // ---- Reject writes nothing --------------------------------------------------------------------
  const trId = await propId("test_reporting");
  const rej = await call(editor.token, "POST", `/colleges/proposals/${trId}/review`, { decision: "reject" });
  check("an editor rejects the test-reporting proposal", rej.status === 200 && rej.body.status === "rejected", JSON.stringify(rej.body));
  check("a rejected proposal writes nothing", (await sql(`select count(*) from public.college_policies where college_id = '${college}'`)) === "0");
  check("...and records who rejected it", (await sql(`select reviewed_by from public.catalog_change_proposals where id = '${trId}'`)) === editor.id);

  // ---- A flag updates only its column ------------------------------------------------------------
  await sql(`insert into public.college_policies (college_id, superscore, self_report_scores, sources) values ('${college}', 'both', true, '{"superscore":{"url":"https://www.t16b-fixture.edu/old","checkedAt":"2026-01-01"}}')`);
  const psrId = await propId("personal_statement_read");
  const flag = await call(editor.token, "POST", `/colleges/proposals/${psrId}/review`, { decision: "approve" });
  check("an editor approves the personal-statement flag", flag.status === 200 && flag.body.status === "approved", JSON.stringify(flag.body));
  const pol = await sql(
    `select concat_ws('|', personal_statement_read, superscore, self_report_scores, coalesce(test_reporting, '-'), sources->'superscore'->>'url',
                      sources->'personal_statement_read'->>'url' like 'https://apply.t16b-fixture.edu/essays%',
                      (sources->'personal_statement_read'->>'verifiedAt')::timestamptz > now() - interval '5 minutes',
                      sources->'personal_statement_read'->>'verifiedBy', provenance)
       from public.college_policies where college_id = '${college}'`
  );
  check(
    "only that column changes, stamped with its source, verified time and editor",
    pol === `t|both|t|-|https://www.t16b-fixture.edu/old|t|t|${editor.id}|curated`,
    pol
  );

  // ---- The research route's fields go through the same function --------------------------------
  const ssId = await returning(
    `insert into public.catalog_change_proposals (college_id, field, current_value, proposed_value, source_url, evidence) values ('${college}', 'superscore', 'both', 'sat', 'https://www.t16b-fixture.edu/testing', 'We superscore the SAT.') returning id`
  );
  const ss = await call(editor.token, "POST", `/colleges/proposals/${ssId}/review`, { decision: "approve" });
  check("an older field still approves", ss.status === 200 && (await sql(`select superscore from public.college_policies where college_id = '${college}'`)) === "sat", JSON.stringify(ss.body));

  // ---- A bad payload never reaches the table -----------------------------------------------------
  const badId = await returning(
    `insert into public.catalog_change_proposals (college_id, field, proposed_value, source_url, evidence, admission_cycle, fact_key, payload)
     values ('${college}', 'supplement', '${cycle}#7', 'https://apply.t16b-fixture.edu/essays', 'a quote that is long enough', '${cycle}', repeat('b', 64),
             '{"cycle":"${cycle}","sortOrder":7,"title":"t","prompt":"p","wordLimit":99999}') returning id`
  );
  const bad = await call(editor.token, "POST", `/colleges/proposals/${badId}/review`, { decision: "approve" });
  check("approving a proposal with an invalid payload is refused", bad.status === 400, JSON.stringify(bad.body));
  check("...and writes nothing", (await sql(`select count(*) from public.college_supplements where college_id = '${college}'`)) === "1" && (await sql(`select status from public.catalog_change_proposals where id = '${badId}'`)) === "pending");

  // ---- An approval never overwrites a different prompt -------------------------------------------------
  const slotRow = () => sql(`select concat_ws('|', prompt, source_url) from public.college_supplements where college_id = '${college}' and admission_cycle = '${cycle}' and sort_order = 0`);
  const before = await slotRow();
  const clashId = await returning(
    `insert into public.catalog_change_proposals (college_id, field, proposed_value, source_url, evidence, admission_cycle, fact_key, payload)
     values ('${college}', 'supplement', '${cycle}#0', 'https://apply.t16b-fixture.edu/other', 'a quote that is long enough', '${cycle}', repeat('c', 64),
             '{"cycle":"${cycle}","sortOrder":0,"title":"Other","prompt":"Describe a different thing entirely.","wordLimit":100}') returning id`
  );
  const clash = await call(editor.token, "POST", `/colleges/proposals/${clashId}/review`, { decision: "approve" });
  check("approving a prompt onto a slot that holds a different prompt is refused", clash.status === 400 && /different prompt/i.test(clash.body.error ?? ""), JSON.stringify(clash.body));
  check("...and the curated prompt there is untouched", (await slotRow()) === before && (await sql(`select status from public.catalog_change_proposals where id = '${clashId}'`)) === "pending", await slotRow());
  const dupId = await returning(
    `insert into public.catalog_change_proposals (college_id, field, proposed_value, source_url, evidence, admission_cycle, fact_key, payload)
     values ('${college}', 'supplement', '${cycle}#5', 'https://apply.t16b-fixture.edu/essays', 'a quote that is long enough', '${cycle}', repeat('d', 64),
             '{"cycle":"${cycle}","sortOrder":5,"title":"Again","prompt":"why do you want to attend  our university, and what would you add to it?","wordLimit":250}') returning id`
  );
  const dup = await call(editor.token, "POST", `/colleges/proposals/${dupId}/review`, { decision: "approve" });
  check("approving a prompt that is already on file at another slot is refused", dup.status === 400 && /already on file/i.test(dup.body.error ?? ""), JSON.stringify(dup.body));
  check("...and writes no second copy", (await sql(`select count(*) from public.college_supplements where college_id = '${college}'`)) === "1");
  await sql(`delete from public.catalog_change_proposals where id in ('${clashId}', '${dupId}', '${badId}')`);

  // ---- After approval, the same fact isn't proposed again -----------------------------------------
  const third = await cron({ collegeId: college });
  check(
    "a run after review proposes only what isn't on file: test reporting again (a rejected fact may come back)",
    third.status === 200 && third.body.proposed === 1 && third.body.unchanged === 2,
    JSON.stringify(third.body)
  );
} finally {
  await sql(`delete from public.colleges where unitid in (${UNITID}, ${UNITID + 1})`);
  await sql(`delete from public.catalog_editors where profile_id = '${editor.id}'`);
}
