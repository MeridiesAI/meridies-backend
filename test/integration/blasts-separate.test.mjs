// An email blast reaches many families, but every family gets a message of its own: one address on the To line,
// nothing on Cc or Bcc, and no other family's address anywhere in it. A consultant's families must never see who
// else the consultant works with. Sending now (routes/blasts.ts) and the scheduled cron (lib/blasts.ts dispatch)
// both go through deliverBlast, so both are checked.
//
// MAILPIT_URL: where the API's DEV_MAIL_URL delivers, so the headers checked are the ones a recipient would get.
//
//   S   a counselor with four students: p1, p2, p3 and p4. p1 and p2 each have their own parent; p3 and p4
//       are siblings who share one parent (the address typed in two cases).
import { API, CLIENT, CRON_SECRET, call, check, sql, user } from "./harness.mjs";
import { studentOf } from "./imports-helpers.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const tag = Date.now();
const S = await user("blast-sep");
const [p1, p2, p3, p4] = await Promise.all(["p1", "p2", "p3", "p4"].map((n) => studentOf(S, `blast-sep-${n}`)));

const family = (n) => `family${n}-${tag}@families.test`;
await sql(`insert into public.guardians (student_id, full_name, email) values
  ('${p1.id}', 'Ann One', '${family(1)}'),
  ('${p2.id}', 'Bo Two', '${family(2)}'),
  ('${p3.id}', 'Cy Three', '${family(3)}'),
  ('${p4.id}', 'Cy Three', '${family(3).toUpperCase()}')`);
const expected = [family(1), family(2), family(3)];

/** Every message a search finds for this subject, in full, once `count` have arrived (or after ~5 seconds). */
async function mailFor(subject, count) {
  let found = [];
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`);
    const list = (await r.json()).messages ?? [];
    found = await Promise.all(list.map(async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()));
    if (found.length >= count) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  return found;
}

const lower = (s) => String(s).toLowerCase();

/** The checks that must hold for a blast, however it was sent. */
async function assertSeparate(how, blastId, subject) {
  const rows = (await sql(`select lower(to_email) from public.message_deliveries where blast_id = '${blastId}' order by 1`)).split("\n").filter(Boolean);
  check(`${how}: one logged send per family (3 families, 4 students)`, rows.join(",") === expected.join(","), rows.join(","));
  check(`${how}: each logged address is a single address`, rows.every((r) => !/[,;\s]/.test(r)), rows.join(" | "));

  const mails = await mailFor(subject, expected.length);
  check(`${how}: three separate messages went out, not one`, mails.length === expected.length, `${mails.length}`);
  check(
    `${how}: each message has exactly one person on the To line`,
    mails.every((m) => (m.To ?? []).length === 1),
    JSON.stringify(mails.map((m) => (m.To ?? []).map((t) => t.Address)))
  );
  check(
    `${how}: nobody is on Cc or Bcc`,
    mails.every((m) => (m.Cc ?? []).length === 0 && (m.Bcc ?? []).length === 0),
    JSON.stringify(mails.map((m) => [m.Cc, m.Bcc]))
  );
  check(
    `${how}: every family is reached, once`,
    mails.map((m) => lower(m.To?.[0]?.Address)).sort().join(",") === expected.join(","),
    JSON.stringify(mails.map((m) => m.To?.[0]?.Address))
  );
  check(
    `${how}: no message mentions another family's address`,
    mails.every((m) => {
      const mine = lower(m.To?.[0]?.Address);
      const text = lower(`${m.Text ?? ""}${m.HTML ?? ""}`);
      return expected.filter((e) => e !== mine).every((e) => !text.includes(e));
    })
  );
}

// ---------------------------------------------------------------------------
// Sending now
// ---------------------------------------------------------------------------
const nowSubject = `Separate now ${tag}`;
const now = await call(S.token, "POST", "/blasts", { recipientType: "parents", subject: nowSubject, body: "Hi {first},\n\nA note from {me}." });
check("a blast to every family goes now", now.status === 201 && now.body.status === "sent" && now.body.deliveredCount === 3, JSON.stringify(now.body));
await assertSeparate("sent now", now.body.id, nowSubject);

// ---------------------------------------------------------------------------
// Scheduled, sent by the cron
// ---------------------------------------------------------------------------
const laterSubject = `Separate later ${tag}`;
const later = await call(S.token, "POST", "/blasts", {
  recipientType: "parents",
  subject: laterSubject,
  body: "Hi {first},\n\nA note from {me}.",
  scheduledFor: new Date(Date.now() + 2 * 86_400_000).toISOString(),
});
check("a blast to every family can be scheduled", later.status === 201 && later.body.status === "scheduled", JSON.stringify(later.body));
await sql(`update public.email_blasts set scheduled_for = now() - interval '1 minute', claimed_at = null where id = '${later.body.id}'`);
const ran = await fetch(`${API}/internal/blasts/dispatch`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } });
check("the cron sends it", ran.status === 200, `${ran.status}`);
await assertSeparate("sent by the cron", later.body.id, laterSubject);
