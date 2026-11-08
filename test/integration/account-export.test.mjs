// The batched student export (POST /account/export/students) and the Google
// Sheets roster summary (POST /account/export/drive). Needs an API started with
// DRIVE_EXPORT_FAKE=fixture (no call to Google is ever made here). Set API_LOG
// to the API's log file to also check that no CSV text or token reached it.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { call, check, sql, user } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_MARKER = `ya29.never-log-me-${Date.now()}`;
const NAME_MARKER = `Zyx${Date.now()}`;
const EVIL_HOST = `evil-${Date.now()}.example`;

const c = await user("exp-counselor");
const s1 = await studentOf(c, "exp-s1");
const s2 = await studentOf(c, "exp-s2");
await sql(`update profiles set full_name = '${NAME_MARKER} One', grad_year = '2027' where id = '${s1.id}'`);
const other = await user("exp-other");
const foreign = await studentOf(other, "exp-foreign");

// A formula a family member might type, and an uploaded file.
await sql(`insert into guardians (student_id, full_name, email) values ('${s1.id}', '=HYPERLINK("http://${EVIL_HOST}","x")', 'g@example.com')`);
await sql(`insert into activities (student_id, name, hours_per_week) values ('${s1.id}', 'Robotics, varsity', 4)`);
await sql(`insert into documents (student_id, owner_id, storage_path, filename, title, kind) values ('${s1.id}', '${c.id}', '${s1.id}/doc-transcript.pdf', 'transcript.pdf', 'Transcript', 'transcript')`);

const batchKey = (id) => `account:export-batch:${id}`;
const bucket = async (key) => (await sql(`select coalesce((select count::text from private.rate_limit_buckets where key = '${key}'), 'none')`));

// ---- Batch: shape, CSV, files -------------------------------------------------------------------
const random = randomUUID();
const r = await call(c.token, "POST", "/account/export/students", { studentIds: [s1.id, foreign.id, random, s2.id] });
check("a counselor exports a batch", r.status === 200, `status ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
const byId = Object.fromEntries((r.body.students ?? []).map((s) => [s.id, s]));
check("students come back in request order", JSON.stringify((r.body.students ?? []).map((s) => s.id)) === JSON.stringify([s1.id, foreign.id, random, s2.id]));
check("own students are exported", byId[s1.id]?.status === "ok" && byId[s2.id]?.status === "ok");
check("the JSON is the per-student export", byId[s1.id]?.json?.kind === "student" && byId[s1.id]?.json?.profile?.id === s1.id && byId[s1.id]?.json?.records?.guardians?.length === 1);
check(
  "another counselor's student is not_found, exactly like a random uuid",
  JSON.stringify(byId[foreign.id]) === JSON.stringify({ id: foreign.id, status: "not_found" }) &&
    JSON.stringify(byId[random]) === JSON.stringify({ id: random, status: "not_found" }),
  JSON.stringify([byId[foreign.id], byId[random]])
);
check("nothing of the foreign student leaks anywhere in the answer", !JSON.stringify(r.body).includes(foreign.email));
const gcsv = byId[s1.id]?.csv?.guardians ?? "";
check("each table with rows has a CSV with a header", gcsv.startsWith("id,") && gcsv.includes("full_name") && typeof byId[s1.id]?.csv?.profile === "string", gcsv.slice(0, 200));
check("a formula in a cell is neutralised", gcsv.includes(`"'=HYPERLINK(""http://${EVIL_HOST}"",""x"")"`), gcsv);
check("a comma is quoted", (byId[s1.id]?.csv?.activities ?? "").includes('"Robotics, varsity"'));
check("a table without rows has no CSV", byId[s2.id]?.csv?.guardians === undefined);
check("file bytes are not included, and the answer says so", r.body.filesIncluded === false && /not included/i.test(r.body.filesNote ?? ""));
const docs = byId[s1.id]?.documents ?? [];
check("the student's documents are listed by name", docs.length === 1 && docs[0].filename === "transcript.pdf" && docs[0].storagePath === `${s1.id}/doc-transcript.pdf`, JSON.stringify(docs));
check("the cost is one unit per id asked for (4)", (await bucket(batchKey(c.id))) === "4", await bucket(batchKey(c.id)));
check("the per-student export's bucket isn't touched", (await bucket(`account:student-export:${c.id}`)) === "none");

// ---- Validation, roles, approval ----------------------------------------------------------------
const tooMany = await call(c.token, "POST", "/account/export/students", { studentIds: Array.from({ length: 26 }, () => randomUUID()) });
check("more than 25 ids is a 400", tooMany.status === 400, `status ${tooMany.status}`);
const none = await call(c.token, "POST", "/account/export/students", { studentIds: [] });
check("no ids is a 400", none.status === 400, `status ${none.status}`);
const bad = await call(c.token, "POST", "/account/export/students", { studentIds: ["not-a-uuid"] });
check("a non-uuid is a 400", bad.status === 400, `status ${bad.status}`);
const asStudent = await call(s1.token, "POST", "/account/export/students", { studentIds: [s1.id] });
check("a student can't use the batch export", asStudent.status === 403, `status ${asStudent.status}`);
const pending = await user("exp-pending", "counselor", { approved: false });
const asPending = await call(pending.token, "POST", "/account/export/students", { studentIds: [s1.id] });
check("an unapproved counselor can't (same as the per-student export)", asPending.status === 403 && asPending.body?.code === "account_pending", JSON.stringify(asPending.body));

// ---- Firm: a member sees only their own caseload -----------------------------------------------
const owner = await user("exp-owner");
const member = await user("exp-member");
await firmWith(owner, [member]);
const ownerStudent = await studentOf(owner, "exp-owner-s");
const memberStudent = await studentOf(member, "exp-member-s");
const fm = await call(member.token, "POST", "/account/export/students", { studentIds: [ownerStudent.id, memberStudent.id] });
const fmById = Object.fromEntries((fm.body.students ?? []).map((s) => [s.id, s]));
check("a firm member exports their own student", fm.status === 200 && fmById[memberStudent.id]?.status === "ok", `status ${fm.status}`);
check("…but not a colleague's", JSON.stringify(fmById[ownerStudent.id]) === JSON.stringify({ id: ownerStudent.id, status: "not_found" }));
await sql(`insert into student_collaborators (student_id, counselor_id, access) values ('${ownerStudent.id}', '${member.id}', 'read')`);
const shared = await call(member.token, "POST", "/account/export/students", { studentIds: [ownerStudent.id] });
check("…unless it is shared with them", shared.body?.students?.[0]?.status === "ok", JSON.stringify(shared.body).slice(0, 200));

// ---- Cost-based rate limit -----------------------------------------------------------------------
const rl = await user("exp-rl");
const rlStudent = await studentOf(rl, "exp-rl-s");
await sql(`insert into private.rate_limit_buckets (key, window_start, count) values ('${batchKey(rl.id)}', now(), 190)`);
const ten = await call(rl.token, "POST", "/account/export/students", { studentIds: [rlStudent.id, ...Array.from({ length: 9 }, () => randomUUID())] });
check("190 spent + 10 asked fits the 200 an hour", ten.status === 200, `status ${ten.status}`);
const one = await call(rl.token, "POST", "/account/export/students", { studentIds: [rlStudent.id] });
check("one more is a 429", one.status === 429 && one.body?.code === "export_rate_limited", `status ${one.status}`);
check("…with an hour-based retry hint", Number.isInteger(one.body?.retryAfterSeconds) && one.body.retryAfterSeconds > 0 && one.body.retryAfterSeconds <= 3600, JSON.stringify(one.body));
const single = await call(rl.token, "GET", `/account/students/${rlStudent.id}/export`);
check("the per-student export still works when the batch bucket is spent", single.status === 200, `status ${single.status}`);
const loop = await user("exp-loop");
const loopIds = [];
for (let i = 0; i < 25; i++) loopIds.push((await studentOf(loop, `exp-loop-${i}`)).id);
let okBatches = 0;
let firstRefused = null;
for (let i = 0; i < 10; i++) {
  const b = await call(loop.token, "POST", "/account/export/students", { studentIds: loopIds });
  if (b.status === 200) okBatches++;
  else if (firstRefused === null) firstRefused = b.status;
}
check("a loop of 25-student batches stops after 8 (200 units)", okBatches === 8 && firstRefused === 429, `ok ${okBatches}, refused ${firstRefused}`);

// ---- Paging past PostgREST's 1,000 rows, the per-table cap, and size ------------------------------
const pager = await user("exp-pager");
const p1200 = await studentOf(pager, "exp-p1200");
await sql(`insert into activities (student_id, name) select '${p1200.id}', 'a' || g from generate_series(1, 1200) g`);
const pCap = await studentOf(pager, "exp-pcap");
await sql(`insert into courses (student_id, name) select '${pCap.id}', 'c' || g from generate_series(1, 5001) g`);
const paged = await call(pager.token, "POST", "/account/export/students", { studentIds: [p1200.id, pCap.id] });
const pById = Object.fromEntries((paged.body.students ?? []).map((s) => [s.id, s]));
const acts = pById[p1200.id]?.json?.records?.activities ?? [];
check("a table over 1,000 rows comes back whole (1,200)", paged.status === 200 && acts.length === 1200 && new Set(acts.map((a) => a.id)).size === 1200, `status ${paged.status} rows ${acts.length}`);
check("…its CSV has all 1,200 rows", (pById[p1200.id]?.csv?.activities ?? "").split("\r\n").filter(Boolean).length === 1201);
check("…and nothing is marked truncated", pById[p1200.id]?.truncated === undefined && pById[p1200.id]?.json?.truncated === undefined);
check("a table past the 5,000 cap gives 5,000 rows", (pById[pCap.id]?.json?.records?.courses ?? []).length === 5000);
check("…and says it was truncated, in the JSON and on the student", JSON.stringify(pById[pCap.id]?.json?.truncated) === '["courses"]' && JSON.stringify(pById[pCap.id]?.truncated) === '["courses"]', JSON.stringify(pById[pCap.id]?.truncated));
check("…and at the batch level", JSON.stringify(paged.body.truncated) === JSON.stringify([{ id: pCap.id, tables: ["courses"] }]), JSON.stringify(paged.body.truncated));
const single1200 = await call(pager.token, "GET", `/account/students/${p1200.id}/export`);
check("the per-student export pages too (1,200 rows, no truncated)", single1200.status === 200 && single1200.body.records?.activities?.length === 1200 && single1200.body.truncated === undefined, `rows ${single1200.body.records?.activities?.length}`);
const singleCap = await call(pager.token, "GET", `/account/students/${pCap.id}/export`);
check("…and reports a cap hit", JSON.stringify(singleCap.body.truncated) === '["courses"]', JSON.stringify(singleCap.body.truncated));
const selfEx = await call(pager.token, "GET", "/account/export");
check("the counselor's own export still works", selfEx.status === 200 && selfEx.body.kind === "counselor" && selfEx.body.roster?.length === 2, `status ${selfEx.status}`);

// One student too big for any batch: about 6 MB of JSON (under the old 20 MB JSON-only cap) and twice that with
// its CSV, over the 10 MB batch answer. They come back too_large and the rest of the batch goes on.
const heavy = await user("exp-heavy");
const huge = await studentOf(heavy, "exp-huge");
const light = await studentOf(heavy, "exp-light");
const longText = (ch) => `repeat('${ch}', 2000)`;
await sql(`insert into activities (student_id, name, description, uc_description, uc_org_description) select '${huge.id}', 'h' || g, ${longText("d")}, ${longText("u")}, ${longText("o")} from generate_series(1, 1000) g`);
const mixed = await call(heavy.token, "POST", "/account/export/students", { studentIds: [huge.id, light.id] });
const mById = Object.fromEntries((mixed.body.students ?? []).map((s) => [s.id, s]));
check("a student over the size cap alone is too_large and the batch goes on", mixed.status === 200 && JSON.stringify(mById[huge.id]) === JSON.stringify({ id: huge.id, status: "too_large" }) && mById[light.id]?.status === "ok", `status ${mixed.status} ${JSON.stringify(mById[huge.id]).slice(0, 120)}`);
const hugeSingle = await call(heavy.token, "GET", `/account/students/${huge.id}/export`);
check("…and the per-student export (no batch cap) still has them", hugeSingle.status === 200 && hugeSingle.body.records?.activities?.length === 1000);

// Students that each fit but together pass 10 MB: 413, asking for a smaller batch.
const crowd = await user("exp-crowd");
const crowdIds = [];
for (let i = 0; i < 3; i++) crowdIds.push((await studentOf(crowd, `exp-crowd-${i}`)).id);
await sql(`insert into activities (student_id, name, description) select s.id, 'c' || g, ${longText("x")} from unnest(array[${crowdIds.map((id) => `'${id}'::uuid`).join(",")}]) s(id), generate_series(1, 1000) g`);
const oneCrowd = await call(crowd.token, "POST", "/account/export/students", { studentIds: [crowdIds[0]] });
check("each of them fits a batch alone", oneCrowd.status === 200 && oneCrowd.body.students?.[0]?.status === "ok", `status ${oneCrowd.status}`);
const allCrowd = await call(crowd.token, "POST", "/account/export/students", { studentIds: crowdIds });
check("three together (JSON + CSV over 10 MB) are a 413 export_too_large", allCrowd.status === 413 && allCrowd.body?.code === "export_too_large", `status ${allCrowd.status} ${JSON.stringify(allCrowd.body).slice(0, 200)}`);

// ---- Google Sheets (fake client) -----------------------------------------------------------------
const noGoogle = await call(c.token, "POST", "/account/export/drive", { studentIds: [s1.id] });
check("without Google connected: 409 drive_not_granted", noGoogle.status === 409 && noGoogle.body?.code === "drive_not_granted", JSON.stringify(noGoogle.body));
await sql(`insert into integration_tokens (owner_id, provider, account_email, access_token_enc, scopes) values ('${c.id}', 'google', 'c@example.com', '${TOKEN_MARKER}', array['https://www.googleapis.com/auth/calendar.events'])`);
const noScope = await call(c.token, "POST", "/account/export/drive", { studentIds: [s1.id] });
check("Google without drive.file: 409 drive_not_granted", noScope.status === 409 && noScope.body?.code === "drive_not_granted", JSON.stringify(noScope.body));
await sql(`update integration_tokens set scopes = array['${DRIVE_FILE}'] where owner_id = '${c.id}' and provider = 'google'`);
const sheet = await call(c.token, "POST", "/account/export/drive", { studentIds: [s1.id, s2.id, foreign.id] });
check("a Sheet is made and its link returned", sheet.status === 200 && /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(sheet.body?.webViewLink ?? ""), JSON.stringify(sheet.body));
check("…one row per caseload student, the foreign id skipped", sheet.body?.rows === 2 && sheet.body?.title?.startsWith("Meridies export "), JSON.stringify(sheet.body));
const roster = await call(c.token, "POST", "/account/export/drive", { scope: "roster-summary" });
check("the whole roster as a summary Sheet", roster.status === 200 && roster.body?.rows === 2, JSON.stringify(roster.body));
const both = await call(c.token, "POST", "/account/export/drive", { scope: "roster-summary", studentIds: [s1.id] });
check("studentIds and scope together is a 400", both.status === 400, `status ${both.status}`);
const sDrive = await call(s1.token, "POST", "/account/export/drive", { scope: "roster-summary" });
check("a student can't export to Drive", sDrive.status === 403, `status ${sDrive.status}`);
await sql(`update integration_tokens set account_email = 'drive-fail@example.com' where owner_id = '${c.id}' and provider = 'google'`);
const fail = await call(c.token, "POST", "/account/export/drive", { studentIds: [s1.id] });
check("Google failing is a calm 502 drive_failed", fail.status === 502 && fail.body?.code === "drive_failed" && !JSON.stringify(fail.body).includes(TOKEN_MARKER), JSON.stringify(fail.body));
for (const resp of [noGoogle, noScope, sheet, roster, fail]) {
  if (JSON.stringify(resp.body).includes(TOKEN_MARKER) || JSON.stringify(resp.body).includes(NAME_MARKER)) check("no token or CSV text in a Drive answer", false, JSON.stringify(resp.body));
}

// A shared student's profile row isn't readable to the collaborator, so the Sheet leaves them out and says how many.
await sql(`insert into integration_tokens (owner_id, provider, account_email, access_token_enc, scopes) values ('${member.id}', 'google', 'm@example.com', '${TOKEN_MARKER}', array['${DRIVE_FILE}'])`);
const mSheet = await call(member.token, "POST", "/account/export/drive", { studentIds: [ownerStudent.id, memberStudent.id] });
check("the Sheet counts students it had to skip", mSheet.status === 200 && mSheet.body?.rows === 1 && mSheet.body?.skipped === 1, JSON.stringify(mSheet.body));
check("…and a full Sheet skips none", sheet.body?.skipped === 0, JSON.stringify(sheet.body));

// A caseload over 250 can't be one roster summary: its own calm code.
const busy = await user("exp-busy");
const tag = `bulk-${Date.now()}`;
await sql(`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${tag}-' || g || '@test.local', '{"full_name":"Bulk","role":"student"}'::jsonb, now(), now() from generate_series(1, 251) g`);
await sql(`update profiles set counselor_id = '${busy.id}' where email like '${tag}-%'`);
const busyRoster = await call(busy.token, "POST", "/account/export/drive", { scope: "roster-summary" });
check("a roster summary over 250 students is 413 roster_too_large", busyRoster.status === 413 && busyRoster.body?.code === "roster_too_large" && !/fewer students/i.test(busyRoster.body?.error ?? ""), JSON.stringify(busyRoster.body));

if (process.env.API_LOG) {
  const log = readFileSync(process.env.API_LOG, "utf8");
  check("the API log has no token and no exported text", !log.includes(TOKEN_MARKER) && !log.includes(NAME_MARKER) && !log.includes(EVIL_HOST));
}
