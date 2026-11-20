// What a counselor drafts for a student who hasn't joined yet (20261127000001): invitations.info, merged by
// merge_invitation_info, copied into the student's blank fields the moment they accept, never blocking the accept.
import { API, call, check, rest, sql, user } from "./harness.mjs";

// psql prints the command tag ("INSERT 0 1") after a RETURNING row; keep the first line.
const one = async (q) => (await sql(q)).split("\n")[0];

const c = await user("invinfo-counselor");
const other = await user("invinfo-other");

let seq = 0;
/** A pending invitation for `s` with `info` seeded on the service side (the PATCH route comes later). */
async function invite(s, info) {
  const email = await one(`select email from public.profiles where id = '${s.id}'`);
  const token = `invinfo-${Date.now()}-${++seq}-aaaaaaaa`;
  const id = await one(
    `insert into public.invitations (counselor_id, email, token, source, full_name, info)
     values ('${c.id}', '${email}', '${token}', 'intake', 'Invited Student', $j$${JSON.stringify(info)}$j$::jsonb) returning id`
  );
  return { id, token };
}
const accept = (s, token) => call(s.token, "POST", "/invites/accept", { token });

// ---- accept fills blank profile fields --------------------------------------------------------------
const a = await user("invinfo-a", "student");
const invA = await invite(a, {
  email: "ana.contact@example.com",
  phone: "555-0101",
  highSchool: "  Lincoln High  ",
  address: "1 Main St",
  gender: "female",
  birthday: "2008-04-02",
  citizenship: "us-citizen",
  firstGen: true,
  livingWithParent: false,
  maritalStatus: "single",
  collegesPlanned: 12,
  intendedMajors: ["Biology", "Chemistry"],
  gpaWeighted: 4.2,
  gpaUnweighted: 3.9,
  gpaScale: "4.0",
  classRank: "12/400",
  sat: 1450,
  act: 33,
  rigor: "6 APs",
  parentName: "Maria A",
  parentEmail: "maria@example.com",
  parentPhone: "555-0202",
  privateNote: "Strong in science; shy at first.",
});
const accA = await accept(a, invA.token);
check("the student accepts", accA.status === 200, `${accA.status} ${JSON.stringify(accA.body).slice(0, 160)}`);
const prof = await one(`select coalesce(phone,'') || '|' || coalesce(high_school,'') from public.profiles where id = '${a.id}'`);
const details = await one(
  `select concat_ws('|', contact_email, address, gender, birthday, citizenship, first_gen, living_with_parent, marital_status, colleges_planned, array_to_string(intended_majors, ','), updated_by = '${c.id}')
     from public.student_personal_details where student_id = '${a.id}'`
);
const acad = await one(
  `select concat_ws('|', gpa_weighted, gpa_unweighted, gpa_scale, class_rank, sat_superscore, act_composite, rigor_context)
     from public.student_academics where student_id = '${a.id}'`
);
const guard = await one(
  `select concat_ws('|', full_name, email, phone, is_primary, alerts_enabled, added_by = '${c.id}') from public.guardians where student_id = '${a.id}'`
);
const note = await one(`select body from public.student_private_notes where student_id = '${a.id}'`);
check(
  "accept fills blank profile fields",
  prof === "555-0101|Lincoln High" &&
    details === "ana.contact@example.com|1 Main St|female|2008-04-02|us-citizen|t|f|single|12|Biology,Chemistry|t" &&
    acad === "4.200|3.900|4.0|12/400|1450|33|6 APs" &&
    guard === "Maria A|maria@example.com|555-0202|t|t|t" &&
    note === "Strong in science; shy at first.",
  `\n    profile ${prof}\n    details ${details}\n    academics ${acad}\n    guardian ${guard}\n    note ${note}`
);

// ---- what the student already has stays ----------------------------------------------------------
const b = await user("invinfo-b", "student");
await sql(`update public.profiles set phone = '555-9999' where id = '${b.id}'`);
await sql(`insert into public.student_academics (student_id, gpa_weighted) values ('${b.id}', 3.1)`);
await sql(`insert into public.student_private_notes (student_id, body) values ('${b.id}', 'Earlier note')`);
const invB = await invite(b, { phone: "555-0101", highSchool: "Lincoln High", gpaWeighted: 4.4, sat: 1300, parentName: "Name Only", privateNote: "Draft note" });
const accB = await accept(b, invB.token);
check("the second student accepts", accB.status === 200, `${accB.status}`);
const profB = await one(`select coalesce(phone,'') || '|' || coalesce(high_school,'') from public.profiles where id = '${b.id}'`);
const acadB = await one(`select concat_ws('|', gpa_weighted, sat_superscore) from public.student_academics where student_id = '${b.id}'`);
check("accept leaves what the student already has", profB === "555-9999|Lincoln High" && acadB === "3.100|1300", `profile ${profB} academics ${acadB}`);
const gB = await one(`select count(*) from public.guardians where student_id = '${b.id}'`);
check("a parent name alone creates no guardian", gB === "0", `guardians ${gB}`);
const noteB = await one(`select body from public.student_private_notes where student_id = '${b.id}'`);
check("an existing note is not overwritten", noteB === "Earlier note", noteB);

// ---- bad info never blocks accepting -----------------------------------------------------------------
const d = await user("invinfo-d", "student");
const invD = await invite(d, { birthday: "not-a-date", sat: "x" });
const accD = await accept(d, invD.token);
const onRoster = await one(`select counselor_id = '${c.id}' from public.profiles where id = '${d.id}'`);
check("bad info never blocks accepting", accD.status === 200 && onRoster === "t", `${accD.status} roster ${onRoster}`);

// ---- merge_invitation_info -----------------------------------------------------------------------------
const e = await user("invinfo-e", "student");
const invE = await invite(e, {});
const merge = (who, id, set, remove = []) => rest(who.token, "POST", "/rest/v1/rpc/merge_invitation_info", { p_id: id, p_set: set, p_remove: remove });
const m1 = await merge(c, invE.id, { phone: "555-1111" });
const m2 = await merge(c, invE.id, { sat: 1400 });
const merged = await one(`select info from public.invitations where id = '${invE.id}'`);
check(
  "merge_invitation_info keeps both of two writes",
  m1.status === 200 && m2.status === 200 && JSON.parse(merged).phone === "555-1111" && JSON.parse(merged).sat === 1400,
  `${m1.status} ${m2.status} ${merged}`
);
const m3 = await merge(c, invE.id, {}, ["phone"]);
check("merge removes a named key", m3.status === 200 && m3.body?.phone === undefined && m3.body?.sat === 1400, JSON.stringify(m3.body));
const mOther = await merge(other, invE.id, { phone: "1" });
check("another counselor's merge changes nothing", mOther.status === 200 && mOther.body === null, `${mOther.status} ${JSON.stringify(mOther.body)}`);
const mClosed = await merge(c, invA.id, { phone: "555-2222" });
check("merge on a non-pending invitation returns null", mClosed.status === 200 && mClosed.body === null, `${mClosed.status} ${JSON.stringify(mClosed.body)}`);

// ---- the student can't read it --------------------------------------------------------------------------
const peek = await rest(a.token, "GET", `/rest/v1/invitations?id=eq.${invA.id}&select=info`);
check("a student's own token cannot read invitations.info", peek.status === 200 && Array.isArray(peek.body) && peek.body.length === 0, `${peek.status} ${JSON.stringify(peek.body).slice(0, 120)}`);

// ---- a bad value's warning never quotes it (a minor's birthday stays out of the server log) ----------------
const { spawnSync } = await import("node:child_process");
const LOG_CHECK = "a bad birthday is warned about by destination and code, not by value";
/** The database's container: the supabase_db_* one publishing DB_URL's port (the harness's own default). */
function dbContainer() {
  const dbUrl = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const port = new URL(dbUrl).port || "5432";
  const r = spawnSync("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split("\n").map((s) => s.trim()).find((s) => s.startsWith("supabase_db_")) ?? null;
}
/**
 * Postgres logs to the container's stderr; keep both streams. Only from `since` on (just before the accept), and with
 * room for a busy database: past spawnSync's default 1 MB the read failed with ENOBUFS and came back as "", which read
 * as "no warning" (Integration slice 3 on PR #204). A failed read is reported, never taken for an empty log.
 */
const dbLog = (name, since) => {
  const r = spawnSync("docker", ["logs", "--since", since, name], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { log: "", error: r.error?.code ?? `docker logs exited ${r.status}: ${String(r.stderr).slice(0, 200)}` };
  return { log: r.stdout + r.stderr, error: null };
};

const container = dbContainer();
if (!container) {
  console.log(`SKIP  ${LOG_CHECK}  (no docker/db container found)`);
} else {
  const f = await user("invinfo-f", "student");
  const invF = await invite(f, {});
  // Built in SQL so the literal never appears in any statement text either.
  await sql(`update public.invitations set info = jsonb_build_object('birthday', '2008-02-' || '30') where id = '${invF.id}'`);
  // A few seconds early: docker compares against the container's own log timestamps.
  const since = new Date(Date.now() - 5000).toISOString();
  const accF = await accept(f, invF.token);
  // Poll until this invitation's warning is flushed to the log (up to 10 s).
  let log = "";
  let readError = null;
  for (let t = 0; t < 20 && !log.includes(invF.id); t++) {
    await new Promise((r) => setTimeout(r, 500));
    ({ log, error: readError } = dbLog(container, since));
    if (readError) break;
  }
  const ours = log.split("\n").filter((l) => l.includes(invF.id));
  check(
    LOG_CHECK,
    accF.status === 200 &&
      !readError &&
      ours.some((l) => l.includes("student_personal_details not filled") && l.includes("sqlstate 22008")) &&
      !log.includes("2008-02-30"),
    `${accF.status} ${container}${readError ? ` (log read failed: ${readError})` : ""}: ${ours.join(" / ").slice(0, 240)}`
  );
}

// ---- GET / PATCH /invites/:id/info ---------------------------------------------------------------------
let nDraft = 0;
/** A pending invitation of the counselor's for an address nobody has joined with; `info` is seeded on the service side. */
async function pending(info = {}) {
  const token = `invinfo-api-${Date.now()}-${++nDraft}-aaaaaaaa`;
  return one(
    `insert into public.invitations (counselor_id, email, token, source, full_name, info)
     values ('${c.id}', 'draft-${Date.now()}-${nDraft}@test.local', '${token}', 'intake', 'Draft Student', $j$${JSON.stringify(info)}$j$::jsonb) returning id`
  );
}
const getInfo = (who, id) => call(who.token, "GET", `/invites/${id}/info`);
const patchInfo = (who, id, body) => call(who.token, "PATCH", `/invites/${id}/info`, body);

const d1 = await pending();
const fresh = await getInfo(c, d1);
check(
  "GET /info on an empty draft answers the card's shape with nothing filled",
  fresh.status === 200 &&
    fresh.body?.info?.phone === null &&
    fresh.body?.info?.fullName === "Draft Student" &&
    Array.isArray(fresh.body?.info?.intendedMajors) &&
    fresh.body?.privateNote === "" &&
    fresh.body?.invitation?.id === d1 &&
    fresh.body?.invitation?.status === "pending" &&
    fresh.body?.invitation?.studentId === null,
  `${fresh.status} ${JSON.stringify(fresh.body).slice(0, 200)}`
);

const p1 = await patchInfo(c, d1, {
  phone: "555-0303",
  gpaUnweighted: 3.8,
  parentName: "Dana Draft",
  parentEmail: "dana@example.com",
  parentPhone: "555-0404",
  privateNote: "Prefers evening calls.",
});
check(
  "PATCH /info answers the same shape, with the new values",
  p1.status === 200 &&
    p1.body?.info?.phone === "555-0303" &&
    p1.body?.info?.gpaUnweighted === 3.8 &&
    p1.body?.info?.parentName === "Dana Draft" &&
    p1.body?.privateNote === "Prefers evening calls." &&
    p1.body?.invitation?.status === "pending",
  `${p1.status} ${JSON.stringify(p1.body).slice(0, 240)}`
);
const g1 = await getInfo(c, d1);
check(
  "GET /info reads back what PATCH stored (phone, GPA, parent, private note)",
  g1.status === 200 &&
    g1.body?.info?.phone === "555-0303" &&
    g1.body?.info?.gpaUnweighted === 3.8 &&
    g1.body?.info?.parentName === "Dana Draft" &&
    g1.body?.info?.parentEmail === "dana@example.com" &&
    g1.body?.info?.parentPhone === "555-0404" &&
    g1.body?.privateNote === "Prefers evening calls." &&
    g1.body?.invitation?.email.startsWith("draft-") &&
    g1.body?.invitation?.fullName === "Draft Student",
  `${g1.status} ${JSON.stringify(g1.body).slice(0, 300)}`
);
const stored = JSON.parse(await one(`select info from public.invitations where id = '${d1}'`));
check("the private note is stored inside info, not as its own column", stored.privateNote === "Prefers evening calls." && stored.phone === "555-0303", JSON.stringify(stored));

const pc = await patchInfo(c, d1, { phone: "", privateNote: null });
check(
  "an empty string or null clears a key",
  pc.status === 200 && pc.body?.info?.phone === null && pc.body?.privateNote === "" && pc.body?.info?.gpaUnweighted === 3.8,
  `${pc.status} ${JSON.stringify(pc.body).slice(0, 200)}`
);

const pg = await patchInfo(c, d1, { gradYear: "2027" });
const gradDb = await one(`select grad_year from public.invitations where id = '${d1}'`);
check(
  "gradYear lands on the invitation's own column and shows on the card",
  pg.status === 200 && gradDb === "2027" && pg.body?.info?.gradYear === "2027" && pg.body?.info?.phone === null && pg.body?.info?.gpaUnweighted === 3.8,
  `${pg.status} db ${gradDb} ${JSON.stringify(pg.body?.info?.gradYear)}`
);
const pgc = await patchInfo(c, d1, { gradYear: null });
check("gradYear null clears the invitation's class year", pgc.status === 200 && (await one(`select grad_year is null from public.invitations where id = '${d1}'`)) === "t", `${pgc.status}`);

const bad = [
  ["a bad email", { email: "nope" }],
  ["an SAT below 400", { sat: 399 }],
  ["an unknown key", { guardianId: "x" }],
  ["a private note over 4000 characters", { privateNote: "x".repeat(4001) }],
];
for (const [label, body] of bad) {
  const r = await patchInfo(c, d1, body);
  check(`PATCH /info refuses ${label} with 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}
const empty = await patchInfo(c, d1, {});
check("an empty patch is 400 Nothing to change", empty.status === 400 && empty.body?.error === "Nothing to change", `${empty.status} ${JSON.stringify(empty.body)}`);
const storedAfterBad = JSON.parse(await one(`select info from public.invitations where id = '${d1}'`));
check("a refused patch stores nothing", storedAfterBad.sat === undefined && storedAfterBad.email === undefined, JSON.stringify(storedAfterBad));

// Two edits to different fields, fired together, both survive (one atomic merge).
const d2 = await pending();
const [r1, r2] = await Promise.all([patchInfo(c, d2, { phone: "555-0505" }), patchInfo(c, d2, { sat: 1500 })]);
const both = await getInfo(c, d2);
check(
  "two quick PATCHes to different fields both survive",
  r1.status === 200 && r2.status === 200 && both.body?.info?.phone === "555-0505" && both.body?.info?.sat === 1500,
  `${r1.status} ${r2.status} ${JSON.stringify(both.body?.info?.phone)} ${JSON.stringify(both.body?.info?.sat)}`
);

// High school: matched to the catalog on every patch that carries a name.
const hsName = `Draftinfo Test High ${Date.now()}`;
const hsId = await one(`with h as (insert into public.high_schools (name) values ('${hsName}') returning id) select id from h`);
const d3 = await pending();
const h1 = await patchInfo(c, d3, { highSchool: hsName.toLowerCase() });
check("a high school typed as a catalog name is linked", h1.status === 200 && h1.body?.info?.highSchoolId === hsId && h1.body?.info?.highSchool === hsName.toLowerCase(), `${h1.status} ${JSON.stringify(h1.body?.info?.highSchoolId)}`);
const h2 = await patchInfo(c, d3, { highSchool: hsName.toLowerCase() });
check("sending the same name again keeps the link", h2.status === 200 && h2.body?.info?.highSchoolId === hsId, `${h2.status} ${JSON.stringify(h2.body?.info?.highSchoolId)}`);
const h3 = await patchInfo(c, d3, { highSchool: "No Such School Anywhere" });
check("a name with no catalog match drops the link but keeps the typed name", h3.status === 200 && h3.body?.info?.highSchoolId === null && h3.body?.info?.highSchool === "No Such School Anywhere", `${h3.status} ${JSON.stringify(h3.body?.info?.highSchoolId)}`);
const h4 = await patchInfo(c, d3, { highSchool: hsName });
const h5 = await patchInfo(c, d3, { highSchool: "" });
check(
  "clearing the name clears the link too",
  h4.body?.info?.highSchoolId === hsId && h5.status === 200 && h5.body?.info?.highSchool === null && h5.body?.info?.highSchoolId === null,
  `${JSON.stringify(h4.body?.info?.highSchoolId)} -> ${h5.status} ${JSON.stringify(h5.body?.info)}`.slice(0, 200)
);
const h6 = await patchInfo(c, d3, { phone: "555-0606" });
const h7 = await patchInfo(c, d3, { highSchool: hsName });
const h8 = await patchInfo(c, d3, { phone: "555-0707" });
check("a patch for another field leaves the school link alone", h7.body?.info?.highSchoolId === hsId && h8.body?.info?.highSchoolId === hsId && h6.status === 200, `${h8.status} ${JSON.stringify(h8.body?.info?.highSchoolId)}`);

// Who may call it.
const x1 = await getInfo(other, d1);
const x2 = await patchInfo(other, d1, { phone: "555-9999" });
check("another counselor's GET is 404", x1.status === 404, `${x1.status} ${JSON.stringify(x1.body).slice(0, 100)}`);
check("another counselor's PATCH is 404 and changes nothing", x2.status === 404 && (await one(`select info ? 'phone' from public.invitations where id = '${d1}'`)) === "f", `${x2.status}`);
const gone = await getInfo(c, "00000000-0000-4000-8000-000000000000");
check("an unknown invitation is 404", gone.status === 404, `${gone.status}`);
const stu = await getInfo(a, d1);
const stuP = await patchInfo(a, d1, { phone: "1" });
check("a student token is 403 on both", stu.status === 403 && stuP.status === 403, `${stu.status} ${stuP.status}`);
const noTok = await fetch(`${API}/invites/${d1}/info`);
const noTokP = await fetch(`${API}/invites/${d1}/info`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
check("no token is 401 on both", noTok.status === 401 && noTokP.status === 401, `${noTok.status} ${noTokP.status}`);
const notUuid = await getInfo(c, "not-a-uuid");
check("a malformed id is 400", notUuid.status === 400, `${notUuid.status}`);

// After the student joins: GET still answers, PATCH is 409.
const afterJoin = await getInfo(c, invA.id);
const patchJoined = await patchInfo(c, invA.id, { phone: "555-1212" });
check(
  "after accept GET answers with status accepted and the student's id",
  afterJoin.status === 200 && afterJoin.body?.invitation?.status === "accepted" && afterJoin.body?.invitation?.studentId === a.id,
  `${afterJoin.status} ${JSON.stringify(afterJoin.body?.invitation)}`
);
check(
  "after accept PATCH is 409 invitation_accepted",
  patchJoined.status === 409 &&
    patchJoined.body?.code === "invitation_accepted" &&
    patchJoined.body?.error === "They've joined, so their details live on their own page now.",
  `${patchJoined.status} ${JSON.stringify(patchJoined.body)}`
);
// A student who is on another counselor's roster is not exposed by id.
await sql(`update public.profiles set counselor_id = '${other.id}' where id = '${b.id}'`);
const moved = await getInfo(c, invB.id);
check("a joined student who is no longer on this roster is not named", moved.status === 200 && moved.body?.invitation?.status === "accepted" && moved.body?.invitation?.studentId === null, JSON.stringify(moved.body?.invitation));

// Revoked.
const d4 = await pending({ phone: "555-1313" });
await sql(`update public.invitations set status = 'revoked' where id = '${d4}'`);
const gRev = await getInfo(c, d4);
const pRev = await patchInfo(c, d4, { phone: "555-1414" });
check("a revoked invitation still answers GET", gRev.status === 200 && gRev.body?.invitation?.status === "revoked" && gRev.body?.invitation?.studentId === null && gRev.body?.info?.phone === "555-1313", `${gRev.status} ${JSON.stringify(gRev.body?.invitation)}`);
check("a revoked invitation's PATCH is 409 invitation_closed and changes nothing", pRev.status === 409 && pRev.body?.code === "invitation_closed" && pRev.body?.error === "That invitation is no longer open." && (await one(`select info->>'phone' from public.invitations where id = '${d4}'`)) === "555-1313", `${pRev.status} ${JSON.stringify(pRev.body)}`);

// The building card's feature flag: infoCount is the stored key count (0 for {}).
const d5 = await pending({ phone: "555-1515", sat: 1400, privateNote: "n" });
const d6 = await pending({});
const building = await call(c.token, "GET", "/invites/building");
const row5 = building.body?.find?.((r) => r.id === d5);
const row6 = building.body?.find?.((r) => r.id === d6);
check("a building card carries infoCount equal to the stored key count", building.status === 200 && row5?.infoCount === 3, `${building.status} ${JSON.stringify(row5?.infoCount)}`);
check("an empty draft's infoCount is 0, not absent", row6?.infoCount === 0 && Object.hasOwn(row6, "infoCount"), JSON.stringify(row6?.infoCount));
await patchInfo(c, d6, { act: 30 });
const building2 = await call(c.token, "GET", "/invites/building");
check("infoCount follows a PATCH", building2.body?.find?.((r) => r.id === d6)?.infoCount === 1, `${building2.body?.find?.((r) => r.id === d6)?.infoCount}`);

// ---- a new invitation that replaces a pending one: whose info follows ------------------------------------------
// The rule: the card's Resend always carries it; a POST /invites carries it only to the same non-blank name.
// Parents often share one address, so a sibling's invitation must never receive another child's details.
let nCarry = 0;
/** A pending draft at `email` (null name = nameless) with `info` seeded on the service side. */
async function draftAt(email, fullName, info) {
  const token = `invinfo-carry-${Date.now()}-${++nCarry}-aaaaaaaa`;
  const name = fullName === null ? "null" : `'${fullName}'`;
  return one(
    `insert into public.invitations (counselor_id, email, token, source, full_name, info)
     values ('${c.id}', '${email}', '${token}', 'intake', ${name}, $j$${JSON.stringify(info)}$j$::jsonb) returning id`
  );
}
/** The row as the database holds it. */
const invRow = async (id) =>
  JSON.parse(await one(`select json_build_object('info', info, 'status', status, 'name', full_name)::text from public.invitations where id = '${id}'`));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const carryTag = Date.now();
const MIA = { phone: "555-0101", birthday: "2012-03-04", parentEmail: "parent@example.com", privateNote: "Mia's private details" };

const rNamed = await draftAt(`carry-named-${carryTag}@test.local`, "Mia Chen", MIA);
const resentNamed = await call(c.token, "POST", `/invites/${rNamed}/resend`);
const rNamedNew = resentNamed.body?.id;
const [oldNamed, newNamed] = [await invRow(rNamed), rNamedNew ? await invRow(rNamedNew) : null];
check(
  "Resend keeps the info",
  [200, 201].includes(resentNamed.status) && rNamedNew !== rNamed && same(newNamed?.info, MIA) && newNamed?.status === "pending",
  `${resentNamed.status} new ${JSON.stringify(newNamed)}`
);
check("...and the revoked invitation keeps its own copy", oldNamed.status === "revoked" && same(oldNamed.info, MIA), JSON.stringify(oldNamed));

const rNameless = await draftAt(`carry-nameless-${carryTag}@test.local`, null, MIA);
const resentNameless = await call(c.token, "POST", `/invites/${rNameless}/resend`);
const newNameless = resentNameless.body?.id ? await invRow(resentNameless.body.id) : null;
check(
  "Resend keeps the info of a draft with no name",
  [200, 201].includes(resentNameless.status) && newNameless?.name === null && same(newNameless?.info, MIA),
  `${resentNameless.status} ${JSON.stringify(newNameless)}`
);

const sameAddr = `carry-same-${carryTag}@test.local`;
const dSame = await draftAt(sameAddr, "Ana Lopez", MIA);
const reSame = await call(c.token, "POST", "/invites", { email: sameAddr, fullName: "  ana   LOPEZ ", source: "intake" });
const newSame = reSame.body?.id ? await invRow(reSame.body.id) : null;
check(
  "a same-name re-invite via POST /invites keeps it",
  reSame.status === 201 && reSame.body?.id !== dSame && same(newSame?.info, MIA) && (await invRow(dSame)).status === "revoked",
  `${reSame.status} ${JSON.stringify(newSame)}`
);

const diffAddr = `carry-diff-${carryTag}@test.local`;
const dDiff = await draftAt(diffAddr, "Mia Chen", MIA);
const reDiff = await call(c.token, "POST", "/invites", { email: diffAddr, fullName: "Leo Chen", source: "intake" });
const newDiff = reDiff.body?.id ? await invRow(reDiff.body.id) : null;
const oldDiff = await invRow(dDiff);
check("a different name at the same address does not receive it", reDiff.status === 201 && same(newDiff?.info, {}), `${reDiff.status} ${JSON.stringify(newDiff)}`);
check("...and the info stays on the revoked row", oldDiff.status === "revoked" && same(oldDiff.info, MIA), JSON.stringify(oldDiff));

const blankAddr = `carry-blank-${carryTag}@test.local`;
const dBlank = await draftAt(blankAddr, "Mia Chen", MIA);
const reBlank = await call(c.token, "POST", "/invites", { email: blankAddr });
const newBlank = reBlank.body?.id ? await invRow(reBlank.body.id) : null;
check(
  "a blank-name re-invite does not receive it",
  reBlank.status === 201 && same(newBlank?.info, {}) && same((await invRow(dBlank)).info, MIA),
  `${reBlank.status} ${JSON.stringify(newBlank)}`
);

const nlAddr = `carry-nl-${carryTag}@test.local`;
const dNl = await draftAt(nlAddr, null, MIA);
const reNl = await call(c.token, "POST", "/invites", { email: nlAddr });
const newNl = reNl.body?.id ? await invRow(reNl.body.id) : null;
check(
  "two nameless invitations are not the same student",
  reNl.status === 201 && same(newNl?.info, {}) && same((await invRow(dNl)).info, MIA),
  `${reNl.status} ${JSON.stringify(newNl)}`
);

// The sibling case: Mia's draft (filled in through the API, as the counselor would) sits at the parents' address;
// the counselor then invites Leo there.
const parentAddr = `parent-${carryTag}@test.local`;
const miaId = await draftAt(parentAddr, "Mia Chen", {});
const miaFill = await patchInfo(c, miaId, { birthday: "2012-03-04", parentName: "Pat Chen", parentEmail: parentAddr, privateNote: "Mia is anxious about tests" });
const leo = await call(c.token, "POST", "/invites", { email: parentAddr, fullName: "Leo Chen", source: "intake" });
const leoRow = leo.body?.id ? await invRow(leo.body.id) : null;
const miaRow = await invRow(miaId);
check(
  "a sibling invited at the same address gets none of Mia's info",
  miaFill.status === 200 && leo.status === 201 && leoRow?.name === "Leo Chen" && same(leoRow?.info, {}) && leoRow?.status === "pending",
  `${miaFill.status} ${leo.status} ${JSON.stringify(leoRow)}`
);
check(
  "...and the revoked Mia row still has hers",
  miaRow.status === "revoked" && miaRow.info?.privateNote === "Mia is anxious about tests" && miaRow.info?.birthday === "2012-03-04" && miaRow.info?.parentName === "Pat Chen",
  JSON.stringify(miaRow)
);
// Resending Leo's invitation carries Leo's own (empty) info, never Mia's from the revoked row.
const leoResend = await call(c.token, "POST", `/invites/${leo.body?.id}/resend`);
check(
  "a Resend of the sibling's invitation carries only the sibling's own info",
  [200, 201].includes(leoResend.status) && same((await invRow(leoResend.body?.id)).info, {}),
  `${leoResend.status}`
);

// ---- the draft refuses a GPA or birthday the student's tables would refuse (final review, Important 1) ---------
// Each refusal is checked against the stored info: nothing is saved.
const infoOf = async (id) => JSON.parse(await one(`select info from public.invitations where id = '${id}'`));
const v1 = await pending();
const r92 = await patchInfo(c, v1, { gpaWeighted: 92 });
check("a GPA of 92 with no scale is 400 and stores nothing", r92.status === 400 && (await infoOf(v1)).gpaWeighted === undefined, `${r92.status} ${JSON.stringify(r92.body)}`);
const r53 = await patchInfo(c, v1, { gpaWeighted: 5.3, gpaScale: "4.0" });
check(
  "weighted 5.3 on a 4.0 scale is 400 in the card's words and stores nothing",
  r53.status === 400 && r53.body?.error === "A weighted GPA can be at most 5 on a 4.0 scale" && same(await infoOf(v1), {}),
  `${r53.status} ${JSON.stringify(r53.body)} ${JSON.stringify(await infoOf(v1))}`
);
const r38 = await patchInfo(c, v1, { gpaUnweighted: 3.8 });
check("unweighted 3.8 alone is saved", r38.status === 200 && (await infoOf(v1)).gpaUnweighted === 3.8, `${r38.status} ${JSON.stringify(r38.body).slice(0, 160)}`);
const v2 = await pending();
const r100 = await patchInfo(c, v2, { gpaWeighted: 92, gpaScale: "100" });
check("weighted 92 on a 100 scale is saved", r100.status === 200 && (await infoOf(v2)).gpaWeighted === 92, `${r100.status} ${JSON.stringify(r100.body).slice(0, 160)}`);
const rScale = await patchInfo(c, v2, { gpaScale: "4.0" });
const v2After = await infoOf(v2);
check(
  "a stored weighted 92 then scale 4.0 is 400 and the scale stays 100",
  rScale.status === 400 && v2After.gpaScale === "100" && v2After.gpaWeighted === 92,
  `${rScale.status} ${JSON.stringify(rScale.body)} ${JSON.stringify(v2After)}`
);
const rOther = await patchInfo(c, v2, { phone: "555-1616" });
check("a patch that doesn't touch the GPA still saves next to a valid stored one", rOther.status === 200 && (await infoOf(v2)).phone === "555-1616", `${rOther.status}`);
const v3 = await pending();
const rOld = await patchInfo(c, v3, { birthday: "1975-05-05" });
check(
  "a birthday before 1980 is 400 in plain words and stores nothing",
  rOld.status === 400 && rOld.body?.error === "Birthday must be between 1980 and 2030." && (await infoOf(v3)).birthday === undefined,
  `${rOld.status} ${JSON.stringify(rOld.body)}`
);
const rLeap = await patchInfo(c, v3, { birthday: "2008-02-29" });
check("a valid birthday is saved", rLeap.status === 200 && (await infoOf(v3)).birthday === "2008-02-29", `${rLeap.status} ${JSON.stringify(rLeap.body).slice(0, 160)}`);

// End to end: a draft filled through the API lands whole.
const g = await user("invinfo-g", "student");
const gEmail = await one(`select email from public.profiles where id = '${g.id}'`);
const gToken = `invinfo-e2e-${Date.now()}-aaaaaaaa`;
const gInv = await one(
  `insert into public.invitations (counselor_id, email, token, source, full_name) values ('${c.id}', '${gEmail}', '${gToken}', 'intake', 'Gia Draft') returning id`
);
const gFill = await patchInfo(c, gInv, { gpaUnweighted: 3.8, gpaScale: "4.0", sat: 1400, birthday: "2008-06-15", phone: "555-1717" });
const gAcc = await accept(g, gToken);
const gAcad = await one(`select concat_ws('|', gpa_unweighted, gpa_scale, sat_superscore) from public.student_academics where student_id = '${g.id}'`);
const gBday = await one(`select birthday from public.student_personal_details where student_id = '${g.id}'`);
const gPhone = await one(`select phone from public.profiles where id = '${g.id}'`);
check(
  "a draft the API accepted lands whole at accept (GPA, scale, SAT, birthday, phone)",
  gFill.status === 200 && gAcc.status === 200 && gAcad === "3.800|4.0|1400" && gBday === "2008-06-15" && gPhone === "555-1717",
  `${gFill.status} ${gAcc.status} academics ${gAcad} birthday ${gBday} phone ${gPhone}`
);

// ---- the GPA group fills only when all three GPA columns are blank (final review, Important 2) -------------------
const h = await user("invinfo-h", "student");
await sql(`insert into public.student_academics (student_id, gpa_unweighted) values ('${h.id}', 3.8)`);
const invH = await invite(h, { gpaScale: "100", gpaWeighted: 95, sat: 1350 });
const accH = await accept(h, invH.token);
const acadH = await one(`select concat_ws('|', coalesce(gpa_weighted::text, '-'), gpa_unweighted, coalesce(gpa_scale, '-'), sat_superscore) from public.student_academics where student_id = '${h.id}'`);
check("a student's own GPA keeps its three columns, and the draft's SAT still fills", accH.status === 200 && acadH === "-|3.800|-|1350", `${accH.status} ${acadH}`);

const k = await user("invinfo-k", "student");
await sql(`insert into public.student_academics (student_id, act_composite) values ('${k.id}', 30)`);
const invK = await invite(k, { gpaScale: "4.0", gpaWeighted: 4.3, gpaUnweighted: 3.9 });
const accK = await accept(k, invK.token);
const acadK = await one(`select concat_ws('|', gpa_weighted, gpa_unweighted, gpa_scale, act_composite) from public.student_academics where student_id = '${k.id}'`);
check("a student with all three GPA columns blank gets all three", accK.status === 200 && acadK === "4.300|3.900|4.0|30", `${accK.status} ${acadK}`);

const l = await user("invinfo-l", "student");
await sql(`insert into public.student_academics (student_id, gpa_scale) values ('${l.id}', '100')`);
const invL = await invite(l, { gpaWeighted: 4.3, gpaUnweighted: 3.9, gpaScale: "4.0" });
const accL = await accept(l, invL.token);
const acadL = await one(`select concat_ws('|', coalesce(gpa_weighted::text, '-'), coalesce(gpa_unweighted::text, '-'), gpa_scale) from public.student_academics where student_id = '${l.id}'`);
check("a scale on its own counts as a GPA on file: none of the three is filled", accL.status === 200 && acadL === "-|-|100", `${accL.status} ${acadL}`);

// ---- the high school and its catalog link (final review, minor 3) ----------------------------------------------
const hsCarryName = `Draftinfo Carry High ${Date.now()}`;
const hsCarryId = await one(`with h as (insert into public.high_schools (name) values ('${hsCarryName}') returning id) select id from h`);
const m = await user("invinfo-m", "student");
await sql(`update public.profiles set high_school = null, high_school_id = null where id = '${m.id}'`);
const invM = await invite(m, { highSchool: hsCarryName, highSchoolId: hsCarryId });
const accM = await accept(m, invM.token);
const schoolM = await one(`select concat_ws('|', high_school, high_school_id) from public.profiles where id = '${m.id}'`);
check("a blank school takes the draft's name and catalog link", accM.status === 200 && schoolM === `${hsCarryName}|${hsCarryId}`, `${accM.status} ${schoolM}`);
const n = await user("invinfo-n", "student");
await sql(`update public.profiles set high_school = 'Own School', high_school_id = null where id = '${n.id}'`);
const invN = await invite(n, { highSchool: hsCarryName, highSchoolId: hsCarryId });
const accN = await accept(n, invN.token);
const schoolN = await one(`select concat_ws('|', high_school, coalesce(high_school_id::text, '-')) from public.profiles where id = '${n.id}'`);
check("a student who has a school keeps it and gets no link", accN.status === 200 && schoolN === "Own School|-", `${accN.status} ${schoolN}`);
