// What a counselor drafts for a student who hasn't joined yet (20261127000001): invitations.info, merged by
// merge_invitation_info, copied into the student's blank fields the moment they accept, never blocking the accept.
import { call, check, rest, sql, user } from "./harness.mjs";

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
check("a student's own token cannot read invitations.info", !(Array.isArray(peek.body) && peek.body.length > 0), `${peek.status} ${JSON.stringify(peek.body).slice(0, 120)}`);

// ---- a bad value's warning never quotes it (a minor's birthday stays out of the server log) ----------------
const { spawnSync } = await import("node:child_process");
const f = await user("invinfo-f", "student");
const invF = await invite(f, {});
// Built in SQL so the literal never appears in any statement text either.
await sql(`update public.invitations set info = jsonb_build_object('birthday', '2008-02-' || '30') where id = '${invF.id}'`);
// A wide window: Docker Desktop's clock can trail the host's; the invitation id keeps the match to this accept.
const since = new Date(Date.now() - 60000).toISOString();
const accF = await accept(f, invF.token);
await new Promise((r) => setTimeout(r, 1000));
let log = null;
try {
  // Postgres logs to the container's stderr; spawnSync keeps both streams.
  const r = spawnSync("docker", ["logs", "supabase_db_draftinfo", "--since", since], { encoding: "utf8" });
  log = r.status === 0 ? r.stdout + r.stderr : null;
} catch {
  log = null; // no docker here (CI): the log can't be read, so this check is skipped
}
if (log !== null) {
  const ours = log.split("\n").filter((l) => l.includes(invF.id));
  check(
    "a bad birthday is warned about by destination and code, not by value",
    accF.status === 200 &&
      ours.some((l) => l.includes("student_personal_details not filled") && l.includes("sqlstate 22008")) &&
      !log.includes("2008-02-30"),
    `${accF.status} ${ours.join(" / ").slice(0, 240)}`
  );
}
