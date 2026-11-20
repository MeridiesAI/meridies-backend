// An email blast to "both" (migration 20261130000002): the students AND their parents in one send. One message to
// each address, an address a student and a parent share mailed once, a student reached through a parent when they
// have no address of their own, and the scheduled cron doing the same. Students-only and parents-only are checked on
// the same fixture so "both" can't quietly change them. Mail goes to the local catcher only.
//
//   B   a counselor with seven students:
//         a  own address; parent Ann
//         b  own address; parents Cy (shared with c, typed in two cases) and Off (alerts off)
//         c  own address; parent Cy
//         d  own address; a parent who typed the student's OWN address (one address, two people)
//         e  NO own address; parent Eve
//         f  NO own address, no parent (nobody can be reached)
//         g  own address, no parent
import { API, CLIENT, CRON_SECRET, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const tag = Date.now();
const B = await user("blast-both");
// One at a time: seven sign-ups at once can time out GoTrue on a busy machine.
const made = [];
for (const n of ["a", "b", "c", "d", "e", "f", "g"]) made.push(await studentOf(B, `blast-both-${n}`));
const [a, b, c, d, e, f, g] = made;
const names = { a: "Abe Archer", b: "Bea Baker", c: "Cal Baker", d: "Dee Dunn", e: "Eli Evans", f: "Fay Ford", g: "Gus Grant" };
for (const [k, s] of Object.entries({ a, b, c, d, e, f, g })) {
  await sql(`update public.profiles set full_name = '${names[k]}' where id = '${s.id}'`);
}
const ownEmail = (s) => sql(`select email from public.profiles where id = '${s.id}'`);
const dEmail = await ownEmail(d);
await sql(`update public.profiles set email = '' where id in ('${e.id}', '${f.id}')`);

const fam = (n) => `${n}-${tag}@families.test`;
await sql(`insert into public.guardians (student_id, full_name, email) values
  ('${a.id}', 'Ann Archer', '${fam("ann")}'),
  ('${b.id}', 'Cy Baker', '${fam("cy")}'),
  ('${c.id}', 'Cy Baker', '${fam("cy").toUpperCase()}'),
  ('${d.id}', 'Dad Dunn', '${dEmail.toUpperCase()}'),
  ('${e.id}', 'Eve Evans', '${fam("eve")}')`);
await sql(`insert into public.guardians (student_id, full_name, email, alerts_enabled) values ('${b.id}', 'Off Parent', '${fam("off")}', false)`);

const preview = (over) => call(B.token, "POST", "/blasts/preview", over);
const missing = (r) => [...(r.body.missingEmail ?? [])].sort().join(",");
const want = (...ks) => ks.map((k) => names[k]).sort().join(",");
const deliveries = (id) => sql(`select count(*), count(distinct lower(to_email)) from public.message_deliveries where blast_id = '${id}'`);
const mailedTo = (id, address) => sql(`select count(*) from public.message_deliveries where blast_id = '${id}' and lower(to_email) = lower('${address}')`);
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Preview: who each choice reaches, on one roster
// ---------------------------------------------------------------------------
const students = await preview({ recipientType: "students" });
check("students: five have an address of their own, e and f don't", students.body.deliverable === 5 && missing(students) === want("e", "f"), JSON.stringify(students.body));
const parents = await preview({ recipientType: "parents" });
check("parents: four addresses (Cy once), f and g have no parent to write to", parents.body.deliverable === 4 && missing(parents) === want("f", "g"), JSON.stringify(parents.body));

const both = await preview({ recipientType: "both" });
check("both: counts a student address plus each parent address, the shared one once (5 + 4 - 1)", both.body.count === 7 && both.body.deliverable === 8, JSON.stringify(both.body));
check("both: a student with only a parent is reachable, and only a student with nobody is missing", missing(both) === want("f") && both.body.students.find((s) => s.id === e.id)?.reachable === true && both.body.students.find((s) => s.id === f.id)?.reachable === false, JSON.stringify(both.body));

// ---------------------------------------------------------------------------
// Sending now
// ---------------------------------------------------------------------------
const subject = `Both now ${tag}`;
const now = await call(B.token, "POST", "/blasts", { recipientType: "both", subject, body: "Hi {first},\n\nA note about {student} from {me}." });
check("a blast to both goes now, and says who it was for", now.status === 201 && now.body.status === "sent" && now.body.recipientType === "both" && now.body.deliveredCount === 8 && String(now.body.audienceLabel).startsWith("Students & parents · "), JSON.stringify(now.body));

const [rows, distinct] = (await deliveries(now.body.id)).split("|");
check("both: one email per address, nobody twice", rows === "8" && distinct === "8", `${rows}/${distinct}`);
check("both: an address a student and a parent share is mailed once, as the student", (await mailedTo(now.body.id, dEmail)) === "1" && (await sql(`select recipient_kind from public.message_deliveries where blast_id = '${now.body.id}' and lower(to_email) = lower('${dEmail}')`)) === "student");
check("both: siblings who share a parent get one email naming both", (await mailedTo(now.body.id, fam("cy"))) === "1" && (await sql(`select count(*) from public.message_deliveries where blast_id = '${now.body.id}' and lower(to_email) = '${fam("cy")}' and body like '%about Bea and Cal from%'`)) === "1");
check("both: a parent with alerts off gets nothing", (await mailedTo(now.body.id, fam("off"))) === "0");
check("both: a student with only a parent is written to through the parent", (await mailedTo(now.body.id, fam("eve"))) === "1" && (await sql(`select count(*) from public.message_deliveries where blast_id = '${now.body.id}' and to_email in ('${await ownEmail(a)}', '${await ownEmail(g)}')`)) === "2");
check("both: the student nobody can reach is on the record as skipped", (await sql(`select count(*) from public.email_blast_recipients where blast_id = '${now.body.id}' and status = 'skipped' and student_id = '${f.id}'`)) === "1");

// ---------------------------------------------------------------------------
// Scheduled, sent by the cron
// ---------------------------------------------------------------------------
const later = await call(B.token, "POST", "/blasts", { recipientType: "both", subject: `Both later ${tag}`, body: "Hi {first}, a note from {me}.", scheduledFor: day(2) });
check("a blast to both can be scheduled", later.status === 201 && later.body.status === "scheduled" && later.body.recipientType === "both", JSON.stringify(later.body));
await sql(`update public.email_blasts set scheduled_for = now() - interval '1 minute', claimed_at = null where id = '${later.body.id}'`);
const ran = await fetch(`${API}/internal/blasts/dispatch`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
check("the cron runs", ran.status === 200, `${ran.status}`);
const [lrows, ldistinct] = (await deliveries(later.body.id)).split("|");
check("the cron reaches students and parents, not just students", lrows === "8" && ldistinct === "8" && (await mailedTo(later.body.id, fam("ann"))) === "1" && (await mailedTo(later.body.id, await ownEmail(g))) === "1", `${lrows}/${ldistinct}`);
check("the queued blast reads back as both", (await call(B.token, "GET", `/blasts/${later.body.id}`)).body.recipientType === "both");
