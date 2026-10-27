// Time saved: the monthly job (finalize, emails, purge) and unsubscribe.
// Needs the API with DEV_MAIL_URL pointing at the local Mailpit (supabase start).
import { check, call, sql, user, API, CRON_SECRET, CLIENT } from "./harness.mjs";
import { firmWith, studentOf } from "./imports-helpers.mjs";

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const job = (q = "") => fetch(`${API}/internal/kpi/monthly${q}`, { method: "POST", headers: { ...CLIENT, Authorization: `Bearer ${CRON_SECRET}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const mailsTo = async (email) => {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return ((await r.json()).messages ?? []);
};
const sends = (u, kind = "consultant") => sql(`select count(*) from public.kpi_email_sends where recipient_id='${u.id}' and kind='${kind}'`);
const MONTH = "2026-09";
const record = (who, student, at) =>
  sql(`with r as (insert into public.family_reports (student_id, counselor_id, title) values ('${student.id}', '${who.id}', 'P') returning id)
       select private.kpi_record_at('${who.id}', 'family_report', '${student.id}', '${student.id}', id::text, 'family_reports', id, '${at}') from r`);
const reportOf = (who) => sql(`select (select id from public.family_reports where counselor_id='${who.id}' order by created_at limit 1)`);

const unauth = await fetch(`${API}/internal/kpi/monthly`, { method: "POST", headers: CLIENT });
check("the job needs the cron secret", unauth.status === 401, `status ${unauth.status}`);

// ---- Consultants -------------------------------------------------------------------
const veteran = await user("kpi-mo-vet");          // first completion 40 days ago
const fresh = await user("kpi-mo-fresh");          // first completion 3 days ago
const idle = await user("kpi-mo-idle");            // nothing this month
const quiet = await user("kpi-mo-quiet");          // unsubscribed
const sv = await studentOf(veteran, "kpi-mo-sv");
await sql(`update public.profiles set full_name = 'Philippa Snodgrass' where id = '${sv.id}'`);
const sf = await studentOf(fresh, "kpi-mo-sf");
const sq = await studentOf(quiet, "kpi-mo-sq");
await record(veteran, sv, "2026-09-10 12:00:00+00");
await sql(`update public.kpi_completions set completed_at = now() - interval '40 days' where counselor_id = '${veteran.id}'`);
await sql(`update public.family_reports set status = 'sent' where counselor_id = '${veteran.id}'`); // as if sent; trigger ignores (source recorded)
await record(fresh, sf, "2026-09-28 12:00:00+00");
await sql(`update public.kpi_completions set completed_at = now() - interval '3 days' where counselor_id = '${fresh.id}'`);
await record(quiet, sq, "2026-09-05 12:00:00+00");
await sql(`update public.kpi_completions set completed_at = now() - interval '50 days' where counselor_id = '${quiet.id}'`);
await sql(`insert into public.kpi_baselines (counselor_id, monthly_email) values ('${quiet.id}', false)`);

// ---- Firms -----------------------------------------------------------------------------
const owner3 = await user("kpi-mo-own3");
const m3a = await user("kpi-mo-m3a");
const m3b = await user("kpi-mo-m3b");
const firm3 = await firmWith(owner3, [m3a, m3b]);
for (const u of [owner3, m3a, m3b]) {
  const s = await studentOf(u, "kpi-mo-fs");
  await record(u, s, "2026-09-15 12:00:00+00");
}
const owner2 = await user("kpi-mo-own2");
const m2 = await user("kpi-mo-m2");
await firmWith(owner2, [m2]);
for (const u of [owner2, m2]) {
  const s = await studentOf(u, "kpi-mo-fs2");
  await record(u, s, "2026-09-15 12:00:00+00");
}

// ---- Purge fixtures ------------------------------------------------------------------
await sql(`insert into public.kpi_task_sessions (counselor_id, task_type, subject_id, active_seconds, last_heartbeat_at, last_active_on)
           values ('${veteran.id}', 'meeting', gen_random_uuid(), 120, now() - interval '25 hours', current_date - 1),
                  ('${veteran.id}', 'college_list', '${sv.id}', 900, now() - interval '15 days', current_date - 15)`);

// ---- Purge only ----------------------------------------------------------------------
const p = await job("?purgeOnly=1");
check("purge-only run", p.status === 200 && p.body.purged !== undefined, JSON.stringify(p.body));
check("raw activity older than 24 hours is cleared", (await sql(`select count(*) from public.kpi_task_sessions where last_heartbeat_at < now() - interval '24 hours'`)) === "0");
check("...the running total stays", (await sql(`select active_seconds from public.kpi_task_sessions where counselor_id='${veteran.id}' and task_type='meeting'`)) === "120");
check("an abandoned task is purged after 14 days", (await sql(`select count(*) from public.kpi_task_sessions where counselor_id='${veteran.id}' and task_type='college_list'`)) === "0");
check("purge-only finalizes nothing", (await sql(`select count(*) from public.kpi_months where counselor_id='${veteran.id}'`)) === "0");

// ---- Full run --------------------------------------------------------------------------
const run1 = await job(`?month=${MONTH}`);
check("full run", run1.status === 200, JSON.stringify(run1.body));
check("months with completions are finalized", (await sql(`select count(*) from public.kpi_months where month = '${MONTH}-01' and counselor_id in ('${veteran.id}', '${fresh.id}')`)) === "2");
check("the veteran gets the email", (await sends(veteran)) === "1");
check("first email held under 14 days of use", (await sends(fresh)) === "0");
check("zero completions → no email", (await sends(idle)) === "0" && (await sql(`select count(*) from public.kpi_months where counselor_id='${idle.id}'`)) === "0");
check("unsubscribed → no email", (await sends(quiet)) === "0");
check("3-consultant firm owner gets the firm email", (await sends(owner3, "firm")) === "1");
check("2-consultant firm owner gets none", (await sends(owner2, "firm")) === "0");

const mail = (await mailsTo(veteran.email))[0];
check("the email reached the inbox", !!mail, JSON.stringify(mail ?? {}).slice(0, 200));
if (mail) {
  const full = await (await fetch(`${MAILPIT}/api/v1/message/${mail.ID}`)).json();
  const body = `${full.Subject}\n${full.Text}\n${full.HTML}`;
  check("no student name in the email", !body.includes("Snodgrass") && !body.includes("Philippa"));
  check("it says estimated (defaults in use)", /estimated/.test(body));
  const unsub = /\/kpi\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(full.Text)?.[1];
  check("it carries an unsubscribe link", !!unsub);
  if (unsub) {
    const page = await fetch(`${API}/kpi/unsubscribe/${unsub}`, { headers: CLIENT });
    check("opening the link changes nothing", page.status === 200 && (await sql(`select coalesce((select monthly_email::text from public.kpi_baselines where counselor_id='${veteran.id}'), 'none')`)) !== "false");
    const post = await fetch(`${API}/kpi/unsubscribe/${unsub}`, { method: "POST", headers: { ...CLIENT, "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    check("posting it unsubscribes", post.status === 200 && (await sql(`select monthly_email::text from public.kpi_baselines where counselor_id='${veteran.id}'`)) === "false", `status ${post.status}`);
  }
  const bogus = await fetch(`${API}/kpi/unsubscribe/not-a-real-token-000000000000000000000`, { method: "POST", headers: CLIENT });
  check("an unknown token is a 404", bogus.status === 404, `status ${bogus.status}`);
}

// ---- An owner who gets both emails in one run: both unsubscribe links work -------------
{
  const mails = await mailsTo(owner3.email);
  check("the firm owner got two emails (their own and the firm's)", mails.length === 2, String(mails.length));
  for (const m of mails) {
    const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const tok = /\/kpi\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(full.Text)?.[1];
    const page = await fetch(`${API}/kpi/unsubscribe/${tok}`, { headers: CLIENT });
    check(`unsubscribe link works in "${full.Subject}"`, page.status === 200, `status ${page.status}`);
  }
}

// ---- Idempotent, and the month is locked ---------------------------------------------
const run2 = await job(`?month=${MONTH}`);
check("job run twice sends once", run2.status === 200 && (await sends(owner3, "firm")) === "1" && (await sends(veteran)) === "1");
const rid = await reportOf(fresh);
await sql(`update public.family_reports set status = 'sent' where id = '${rid}'`);
await sql(`update public.family_reports set status = 'draft' where id = '${rid}'`);
check("undo after finalize changes nothing", (await sql(`select count(*) from public.kpi_completions where counselor_id='${fresh.id}' and month='${MONTH}-01'`)) === "1");
check("the job beats its heartbeat", (await sql(`select (last_ok_at is not null)::text from public.job_heartbeats where job='kpi-monthly'`)) === "true");

// ---- Unsubscribe links never expire, are per recipient and email type, and carry RFC 8058 headers ----
{
  const linkOf = (full) => /\/kpi\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(full.Text)?.[1];
  const full = async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
  const first = await Promise.all((await mailsTo(owner3.email)).map(full));
  const firmMail = first.find((m) => m.Subject.includes("Test firm"));
  const ownMail = first.find((m) => m.Subject.startsWith("Your time saved"));
  const F1 = linkOf(firmMail), O1 = linkOf(ownMail);
  check("the two email types carry different links", !!F1 && !!O1 && F1 !== O1);

  const hdrs = await (await fetch(`${MAILPIT}/api/v1/message/${firmMail.ID}/headers`)).json();
  check("List-Unsubscribe header points at the link", (hdrs["List-Unsubscribe"] ?? []).some((h) => h.includes(`/kpi/unsubscribe/${F1}`)), JSON.stringify(hdrs["List-Unsubscribe"]));
  check("List-Unsubscribe-Post is One-Click", (hdrs["List-Unsubscribe-Post"] ?? []).includes("List-Unsubscribe=One-Click"), JSON.stringify(hdrs["List-Unsubscribe-Post"]));

  // A later month's run sends new emails; the earlier links keep working.
  for (const u of [owner3, m3a, m3b]) {
    const s = await studentOf(u, "kpi-mo-later");
    await record(u, s, "2026-08-15 12:00:00+00");
  }
  const later = await job("?month=2026-08");
  check("a later month's run", later.status === 200 && later.body.firmEmails >= 1, JSON.stringify(later.body));
  const pref = (col) => sql(`select coalesce((select ${col}::text from public.kpi_baselines where counselor_id='${owner3.id}'), 'none')`);
  const g = await fetch(`${API}/kpi/unsubscribe/${O1}`, { headers: CLIENT });
  check("a link from an old email still opens", g.status === 200, `status ${g.status}`);
  check("a GET alone unsubscribes no one", (await pref("monthly_email")) !== "false" && (await pref("firm_email")) !== "false");
  const p = await fetch(`${API}/kpi/unsubscribe/${F1}`, { method: "POST", headers: { ...CLIENT, "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  check("an old firm link still unsubscribes", p.status === 200 && (await pref("firm_email")) === "false", `status ${p.status}`);
  check("...from the firm email only", (await pref("monthly_email")) !== "false");
}

// ---- RFC 8058 one-click, hashed tokens, postal address in the footer ----------------
{
  const { createHash } = await import("node:crypto");
  const full = async (m) => (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
  const mails = await Promise.all((await mailsTo(m3a.email)).map(full));
  const mine = mails.find((m) => m.Subject.startsWith("Your time saved"));
  check("a consultant email reached m3a", !!mine, String(mails.length));
  const T = /\/kpi\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(mine?.Text ?? "")?.[1] ?? "";
  check("the footer carries the postal address", (mine?.Text ?? "").includes("1 Test Way, Testville, NY 10001") && (mine?.HTML ?? "").includes("1 Test Way, Testville, NY 10001"));
  check("the database keeps only a sha256 of the token", (await sql(`select count(*) from public.kpi_unsubscribe_tokens where token_hash = '${createHash("sha256").update(T).digest("hex")}'`)) === "1"
    && (await sql(`select count(*) from information_schema.columns where table_name='kpi_unsubscribe_tokens' and column_name='token'`)) === "0");
  const pref = () => sql(`select coalesce((select monthly_email::text from public.kpi_baselines where counselor_id='${m3a.id}'), 'none')`);
  await fetch(`${API}/kpi/unsubscribe/${T}`, { headers: CLIENT });
  check("a GET of the link does not unsubscribe", (await pref()) !== "false");
  const fd = new FormData();
  fd.append("List-Unsubscribe", "One-Click");
  const one = await fetch(`${API}/kpi/unsubscribe/${T}`, { method: "POST", headers: CLIENT, body: fd });
  check("a one-click POST (multipart, no cookies or auth) unsubscribes at once", one.status === 200 && (await pref()) === "false", `status ${one.status}`);
}
