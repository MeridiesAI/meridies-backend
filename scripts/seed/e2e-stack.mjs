// Seeds a throwaway LOCAL stack with accounts and fully populated rosters: the
// signed-in end-to-end suite in meridies-app runs against it, and the
// 60-student speed test (test/integration/perf-roster.mjs) builds on it.
//
//   node scripts/seed/e2e-stack.mjs [--students 60] [--roster 12] >> "$GITHUB_ENV"
//
// Needs SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DB_URL and
// API_URL (a running API, for the contact invitation), all on this machine:
// it refuses anything else, with no override (scripts/seed/local-only.mjs).
//
// Prints KEY=value lines on stdout (progress goes to stderr):
//   E2E_COUNSELOR_*   firm owner with a populated roster, pipeline and Management tasks (read sweeps)
//   E2E_MEMBER_*      the same firm, seat 'counselor' (not an admin)
//   E2E_WRITER_*      a second firm owner with 4 students, for specs that change things (Management,
//                     Calendar, pipeline), so they never disturb what the read sweeps count;
//                     E2E_WRITER_MEMBER_* is that firm's non-admin counselor
//   E2E_BILLING_*     a solo counselor holding only the Payment Tracker scenario (billing-scenario.mjs)
//   E2E_STUDENT_*     a student on the counselor's roster, with E2E_STUDENT_ID
//   E2E_JOINER_*      a student on no roster, invited from a pipeline contact (E2E_JOIN_TOKEN, E2E_JOIN_CONTACT_ID)
//   E2E_PERF_*        a firm owner with the 60-student roster (--students)
//   E2E_STACK=local
// Passwords are random per run. The accounts exist only in the local stack,
// which the CI job throws away; never point this at a shared database.
//
// Rows are written through PostgREST as the counselor wherever the app writes
// them that way, so RLS, auth.uid() defaults and triggers behave as they do in
// the app. psql (as postgres) is used only for what no client may write:
// creating auth users in bulk, profiles.counselor_id / role / approval, and
// Meridies-wide Events Hub rows.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BILLING_FAMILIES, shiftDate } from "./billing-scenario.mjs";
import { assertLocalStack, psqlArgs, psqlBinary, psqlEnv } from "./local-only.mjs";

const env = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (!v) throw new Error(`${k} is required (see the header of scripts/seed/e2e-stack.mjs)`);
  return v;
};
const SB = env("SUPABASE_URL").replace(/\/+$/, "");
const ANON = env("SUPABASE_ANON_KEY");
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");
const DB_URL = env("DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
export const API = env("API_URL", "http://127.0.0.1:4100").replace(/\/+$/, "");
assertLocalStack({ SUPABASE_URL: SB, DB_URL, API_URL: API });

/** Every seeded counselor works in this zone, so "today" here is the API's today. */
export const SEED_TIME_ZONE = "America/New_York";
export const todayInSeedZone = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: SEED_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const log = (...a) => console.error("[seed]", ...a);
const q = (s) => String(s).replace(/'/g, "''");

export function sql(query) {
  // psqlEnv drops PGHOSTADDR, the service-file variables, PSQLRC and every
  // other PG* setting that could move the connection off the local host the
  // guard checked; -X (psqlArgs) skips the startup files, which could
  // \connect elsewhere before the query runs.
  return execFileSync(psqlBinary(), psqlArgs(DB_URL, query), {
    stdio: ["ignore", "pipe", "pipe"],
    env: psqlEnv(),
  })
    .toString()
    .trim();
}

async function jsonOf(r) {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** PostgREST as a signed-in user (RLS applies). Throws on any non-2xx, naming the call. */
export async function rest(token, method, path, body, headers = {}) {
  const r = await fetch(SB + path, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await jsonOf(r);
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Bulk insert through PostgREST; returns the inserted rows. */
export const insertRows = (token, table, rows) =>
  rows.length === 0 ? Promise.resolve([]) : rest(token, "POST", `/rest/v1/${table}`, rows, { Prefer: "return=representation" });

/** The API as a signed-in user. */
export async function api(token, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await jsonOf(r), headers: r.headers };
}

const password = () => `Seed-${randomBytes(12).toString("base64url")}-9a`;
const runTag = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

/**
 * A confirmed, signed-in account with its role confirmed and onboarding done.
 * Counselors are approved (as Meridies would) unless `approved: false`.
 */
export async function createPersona({ tag, role = "counselor", fullName, approved = true }) {
  const email = `e2e-${tag}-${runTag}@test.local`;
  const pw = password();
  const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
  let r = await fetch(`${SB}/auth/v1/admin/users`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({ email, password: pw, email_confirm: true, user_metadata: { full_name: fullName ?? tag, role } }),
  });
  const u = await jsonOf(r);
  if (!r.ok) throw new Error(`create ${tag}: ${r.status} ${JSON.stringify(u).slice(0, 200)}`);
  const token = await signIn(email, pw);
  // The signup trigger may already have confirmed the role from the metadata;
  // then the call answers 23505 and the profile must say the role we asked for.
  await rest(token, "POST", "/rest/v1/rpc/confirm_user_role", { p_role: role }).catch((err) => {
    if (!String(err.message).includes("23505")) throw err;
  });
  const actual = sql(`select role from public.profiles where id = '${q(u.id)}'`);
  if (actual !== role) throw new Error(`${tag} has role ${actual}, not ${role}`);
  const approval = role === "counselor" && approved ? ", counselor_approved_at = now(), counselor_approved_via = 'team'" : "";
  sql(`update public.profiles set onboarding_complete = true, timezone = '${SEED_TIME_ZONE}'${approval} where id = '${q(u.id)}'`);
  return { id: u.id, email, password: pw, token, fullName: fullName ?? tag };
}

export async function signIn(email, pw) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  const t = await jsonOf(r);
  if (!r.ok) throw new Error(`sign in ${email}: ${r.status}`);
  return t.access_token;
}

/**
 * A firm the way the app makes one: create_firm as the owner, then each member
 * joins through a firm invitation (seat 'counselor') and accept_firm_invitation.
 */
export async function seedFirm(owner, name, members = []) {
  const firmId = await rest(owner.token, "POST", "/rest/v1/rpc/create_firm", { p_name: name });
  for (const m of members) {
    const token = randomBytes(24).toString("base64url");
    await insertRows(owner.token, "firm_invitations", [
      {
        firm_id: firmId,
        email: m.email,
        seat_role: "counselor",
        token_hash: createHash("sha256").update(token).digest("hex"),
        invited_by: owner.id,
      },
    ]);
    await rest(m.token, "POST", "/rest/v1/rpc/accept_firm_invitation", { p_token: token });
  }
  return firmId;
}

const FIRST = ["Avery", "Jordan", "Priya", "Mateo", "Sofia", "Kenji", "Amara", "Liam", "Noor", "Elena", "Theo", "Zara", "Diego", "Hana", "Malik"];
const LAST = ["Nguyen", "Okafor", "Patel", "Rivera", "Kowalski", "Haddad", "Larsen", "Mensah", "Brooks", "Tanaka", "Silva", "Moreau"];
const SCHOOLS = [
  ["Lincoln High School", "Fresno, CA"],
  ["Westbrook Academy", "Portland, OR"],
  ["Cedar Ridge High School", "Austin, TX"],
  ["Harbor View High School", "Boston, MA"],
];

/**
 * `n` student accounts on `counselor`'s roster. Created in auth.users in one
 * statement (the handle_new_user trigger makes the profiles), then linked as
 * postgres: only accept_invitation may write counselor_id from a client. They
 * have no password; the E2E student persona is made separately.
 */
export function createStudents(counselor, n, tag = "student") {
  const stamp = `${tag}-${runTag}`;
  const first = `array[${FIRST.map((x) => `'${x}'`).join(",")}]`;
  const last = `array[${LAST.map((x) => `'${x}'`).join(",")}]`;
  sql(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
    select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      'seed-${stamp}-' || g || '@test.local', '', now(),
      jsonb_build_object('full_name', (${first})[1 + (g - 1) % ${FIRST.length}] || ' ' || (${last})[1 + (g * 5) % ${LAST.length}], 'role', 'student'),
      now(), now()
    from generate_series(1, ${n}) g`);
  return linkStudents(counselor, `u.email like 'seed-${q(stamp)}-%@test.local'`);
}

/** Puts students (matched by a condition on auth.users, aliased `u`) on the roster with class, school and hometown filled. */
export function linkStudents(counselor, where) {
  const schools = SCHOOLS.map(([s, h], i) => `(${i}, '${q(s)}', '${q(h)}')`).join(",");
  sql(`with picked as (
      select u.id, row_number() over (order by u.email) - 1 as k from auth.users u where ${where}
    ), meta(k, school, town) as (values ${schools})
    update public.profiles p set counselor_id = '${q(counselor.id)}', role = 'student', role_confirmed = true,
      onboarding_complete = true, grad_year = (2027 + picked.k % 4)::text,
      high_school = meta.school, hometown = meta.town
    from picked join meta on meta.k = picked.k % ${SCHOOLS.length}
    where p.id = picked.id`);
  return sql(`select string_agg(p.id::text, ',' order by p.full_name, p.id) from public.profiles p join auth.users u on u.id = p.id
    where p.counselor_id = '${q(counselor.id)}' and ${where}`)
    .split(",")
    .filter(Boolean);
}

const iso = (d) => d.toISOString();

/**
 * Fills each student's record the way a working counselor's looks: academics,
 * the default polygon, 3 activities, 2 awards, 2 essays, up to 8 colleges, 4
 * tasks with 2 dated steps each (one overdue, one due this week), 3 deadlines,
 * one meeting this month (half with a second attendee), a guardian and a My
 * Work Queue item. Pins the first five.
 */
export async function seedRoster(counselor, studentIds) {
  const t = counselor.token;
  const today = todayInSeedZone();
  const day = (n) => shiftDate(today, n);
  const ids = studentIds;
  log(`roster: ${ids.length} students for ${counselor.email}`);

  await insertRows(t, "student_academics", ids.map((id, i) => ({
    student_id: id, gpa_unweighted: (3.2 + (i % 8) / 10).toFixed(2), gpa_weighted: (3.6 + (i % 8) / 10).toFixed(2),
    gpa_scale: "4.0", test_status: "taken", sat_ebrw: 600 + (i % 10) * 15, sat_math: 620 + (i % 9) * 15,
    sat_superscore: 1220 + (i % 10) * 30, rigor_count: 4 + (i % 6),
  })));
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map((id) => rest(t, "POST", "/rest/v1/rpc/ensure_default_polygon_axes", { p_student: id })));
  }
  await insertRows(t, "activities", ids.flatMap((id) => [
    { student_id: id, name: "Robotics Club", position: "Captain", organization: "School", category: "Robotics", hours_per_week: 6, weeks_per_year: 30, description: "Led a team of twelve to the regional final.", sort_order: 1 },
    { student_id: id, name: "Library tutoring", position: "Tutor", organization: "Public library", category: "Community Service (Volunteer)", hours_per_week: 3, weeks_per_year: 40, description: "Tutored middle schoolers in algebra every week.", sort_order: 2 },
    { student_id: id, name: "Varsity soccer", position: "Midfielder", organization: "School", category: "Athletics: JV/Varsity", hours_per_week: 10, weeks_per_year: 20, description: "Started every game in the fall season.", sort_order: 3 },
  ]));
  await insertRows(t, "awards", ids.flatMap((id) => [
    { student_id: id, name: "Science Fair Finalist", level: "state", year: "2025", sort_order: 1 },
    { student_id: id, name: "Honor Roll", level: "school", year: "2024", sort_order: 2 },
  ]));
  const body = "I learned to build things by taking them apart first. ".repeat(40).trim();
  await insertRows(t, "essays", ids.flatMap((id, i) => [
    { student_id: id, title: "Personal statement", essay_kind: "personal-statement", prompt: "Describe a challenge", body, word_limit: 650, status: i % 3 ? "drafting" : "review", sort_order: 1 },
    { student_id: id, title: "Why this college", essay_kind: "supplement", prompt: "Why us?", body: null, word_limit: 250, status: "not-started", sort_order: 2 },
  ]));

  const colleges = sql(`select coalesce(json_agg(c order by c.name), '[]') from (select id, name from public.colleges order by name limit 40) c`);
  const catalog = JSON.parse(colleges || "[]");
  const ROUNDS = ["EA", "RD", "ED", "RD", "rolling", "RD", "EA", "RD"];
  const FITS = ["reach", "target", "likely"];
  if (catalog.length) {
    await insertRows(t, "student_colleges", ids.flatMap((id, i) =>
      Array.from({ length: Math.min(8, catalog.length) }, (_, k) => {
        const c = catalog[(i + k * 3) % catalog.length];
        return { student_id: id, college_id: c.id, name: c.name, round: ROUNDS[k], fit: FITS[k % 3], status: k < 2 ? "in-progress" : "not-started", sort_order: k + 1 };
      }).filter((row, k, all) => all.findIndex((r) => r.college_id === row.college_id) === k)
    ));
  }

  const KINDS = ["essay", "document", "test-registration", "custom"];
  const TITLES = ["Draft the personal statement", "Upload the transcript", "Register for the October SAT", "Finish the activities list"];
  const STATUSES = ["in-progress", "not-started", "in-progress", "review"];
  const tasks = await insertRows(t, "deliverables", ids.flatMap((id, i) => KINDS.map((kind, k) => ({
    student_id: id, kind, title: TITLES[k], status: STATUSES[(i + k) % 4], due_date: day(7 + k * 5 + (i % 5)),
    source: "counselor", assigned_by: counselor.id, assigned_at: iso(new Date()), created_by: counselor.id,
    notify_email: false, last_activity_at: iso(new Date(Date.now() - ((i + k) % 12) * 86_400_000)),
  }))));
  await insertRows(t, "deliverable_stages", tasks.flatMap((task) => [
    { deliverable_id: task.id, student_id: task.student_id, name: "First draft", due_date: day(-3), sequence: 1 },
    { deliverable_id: task.id, student_id: task.student_id, name: "Final version", due_date: day(4), sequence: 2 },
  ]));
  await insertRows(t, "deadlines", ids.flatMap((id, i) => [
    { student_id: id, title: "Early action application", type: "application", due_date: day(20 + (i % 10)), created_by: counselor.id },
    { student_id: id, title: "SAT", type: "test", due_date: day(10 + (i % 7)), created_by: counselor.id },
    { student_id: id, title: "CSS Profile", type: "financial", due_date: day(40 + (i % 9)), created_by: counselor.id },
  ]));

  const [y, m] = today.split("-").map(Number);
  const meetings = await insertRows(t, "meetings", ids.map((id, i) => {
    const start = new Date(Date.UTC(y, m - 1, 1 + (i % 28), 14 + (i % 6)));
    return { student_id: id, counselor_id: counselor.id, title: "Check-in", mode: "in-person", location: "Office", starts_at: iso(start), ends_at: iso(new Date(start.getTime() + 45 * 60_000)), created_by: counselor.id };
  }));
  if (ids.length > 1) {
    await insertRows(t, "meeting_attendees", meetings.filter((_, i) => i % 2 === 0).map((mt, k) => ({
      meeting_id: mt.id, student_id: ids[(ids.indexOf(mt.student_id) + 1) % ids.length],
    })).filter((r, k, all) => all.findIndex((o) => o.meeting_id === r.meeting_id) === k));
  }
  await insertRows(t, "guardians", ids.map((id, i) => ({
    student_id: id, full_name: `Parent of student ${i + 1}`, email: `guardian-${i + 1}-${runTag}@test.local`, relationship: "parent", is_primary: true,
  })));
  await insertRows(t, "counselor_work_items", ids.map((id, i) => ({
    student_id: id, kind: "task", title: i % 2 ? "Review the college list" : "Prepare for the check-in", due_date: day((i % 14) - 3),
  })));
  await insertRows(t, "consultant_student_pins", ids.slice(0, 5).map((id) => ({ consultant_id: counselor.id, student_id: id })));
}

/**
 * The practice side: the default pipeline stages (seeded the way the board's
 * first open does), `contacts` contacts across them, `packages` of those billed
 * (2 invoices and 1 payment each), and `tasks` Management tasks spread over
 * the owner and `assignees` (a third of them about one of the owner's
 * students, with a subtask).
 */
export async function seedPractice(owner, { contacts = 60, packages = 20, tasks = 20, assignees = [], studentIds = [] } = {}) {
  const t = owner.token;
  const today = todayInSeedZone();
  await rest(t, "POST", "/rest/v1/rpc/ensure_pipeline_stages", {});
  const [ws] = await rest(t, "POST", "/rest/v1/rpc/crm_my_workspace", {});
  const firmId = ws?.firm_id ?? null;
  const stages = await rest(t, "GET", `/rest/v1/pipeline_stages?select=id,name,position&order=position&${firmId ? `firm_id=eq.${firmId}` : `firm_id=is.null&counselor_id=eq.${owner.id}`}`);
  if (!stages.length) throw new Error("ensure_pipeline_stages left no stages");
  log(`practice: ${contacts} contacts over ${stages.length} stages for ${owner.email}`);
  const rows = await insertRows(t, "pipeline_contacts", Array.from({ length: contacts }, (_, i) => ({
    firm_id: firmId, counselor_id: owner.id, stage_id: stages[i % stages.length].id, position: Math.floor(i / stages.length),
    student_name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`, grad_year: 2027 + (i % 4),
    parent_name: `Parent ${LAST[(i * 7) % LAST.length]}`, parent_email: `family-${i + 1}-${runTag}@test.local`,
    next_step: i % 3 ? "Send the contract proposal" : "Follow up after the intro call", owner_id: owner.id,
  })));
  const billed = rows.slice(0, packages);
  await insertRows(t, "pipeline_packages", billed.map((c, i) => ({ contact_id: c.id, package_name: "Full application package", total_cents: 400_000 + (i % 5) * 50_000, installments: 3, created_by: owner.id })));
  await insertRows(t, "pipeline_invoices", billed.flatMap((c, i) => [
    { contact_id: c.id, label: "Deposit", amount_cents: 100_000, issued_on: shiftDate(today, -60), due_on: shiftDate(today, -45), created_by: owner.id },
    { contact_id: c.id, label: "Installment 2 of 3", amount_cents: 150_000, issued_on: shiftDate(today, -15 + (i % 5)), due_on: shiftDate(today, -5 + i % 15), created_by: owner.id },
  ]));
  await insertRows(t, "pipeline_payments", billed.map((c, i) => ({ contact_id: c.id, amount_cents: 100_000 + (i % 4) * 25_000, received_on: shiftDate(today, -40), method: "check", created_by: owner.id })));

  const people = [owner, ...assignees];
  const parents = await insertRows(t, "consultant_tasks", Array.from({ length: tasks }, (_, i) => {
    const aboutStudent = i % 3 === 0 && studentIds.length > 0;
    const assignee = aboutStudent ? owner : people[i % people.length];
    return {
      firm_id: firmId, assignee_id: assignee.id, assigned_by: owner.id, title: aboutStudent ? "Review this student's list" : `Practice task ${i + 1}`,
      student_id: aboutStudent ? studentIds[i % studentIds.length] : null, due_on: shiftDate(today, (i % 10) - 3), position: i,
    };
  }));
  await insertRows(t, "consultant_tasks", parents.filter((p) => p.student_id).map((p, i) => ({
    firm_id: firmId, assignee_id: p.assignee_id, assigned_by: owner.id, parent_id: p.id, title: "Check the deadlines", position: i,
  })));
}

/**
 * The Payment Tracker scenario (billing-scenario.mjs) on `counselor`'s own
 * workspace, which should hold nothing else so the totals strip is exactly the
 * two families. Returns the two contact ids, keyed "A" and "B".
 */
export async function seedBillingScenario(counselor) {
  const t = counselor.token;
  const today = todayInSeedZone();
  await rest(t, "POST", "/rest/v1/rpc/ensure_pipeline_stages", {});
  const [stage] = await rest(t, "GET", `/rest/v1/pipeline_stages?select=id&firm_id=is.null&counselor_id=eq.${counselor.id}&order=position&limit=1`);
  const contactIds = {};
  for (const fam of BILLING_FAMILIES) {
    const [c] = await insertRows(t, "pipeline_contacts", [{
      counselor_id: counselor.id, stage_id: stage.id, student_name: fam.studentName, parent_name: fam.parentName,
      parent_email: `billing-${fam.key.toLowerCase()}-${runTag}@test.local`, owner_id: counselor.id,
    }]);
    contactIds[fam.key] = c.id;
    await insertRows(t, "pipeline_packages", [{ contact_id: c.id, package_name: fam.package.name, total_cents: fam.package.totalCents, installments: fam.package.installments, created_by: counselor.id }]);
    // One at a time, oldest first, so created_at follows issued_on as it would in the app.
    for (const inv of fam.invoices) {
      await insertRows(t, "pipeline_invoices", [{ contact_id: c.id, label: inv.label, amount_cents: inv.amountCents, issued_on: shiftDate(today, -inv.issuedDaysAgo), due_on: shiftDate(today, inv.dueInDays), created_by: counselor.id }]);
    }
    await insertRows(t, "pipeline_payments", fam.payments.map((p) => ({ contact_id: c.id, amount_cents: p.amountCents, received_on: shiftDate(today, -p.daysAgo), method: p.method, created_by: counselor.id })));
  }
  return contactIds;
}

/**
 * A pipeline contact whose student is `joiner`, invited through the API the
 * way "Invite to Meridies" on the card does. The token is read back as postgres
 * because the app's spec can't reach the database; accepting it as the joiner
 * links the contact to the new student.
 */
export async function createJoinInvite(counselor, joiner) {
  const t = counselor.token;
  const [ws] = await rest(t, "POST", "/rest/v1/rpc/crm_my_workspace", {});
  const firmId = ws?.firm_id ?? null;
  const [stage] = await rest(t, "GET", `/rest/v1/pipeline_stages?select=id&order=position&limit=1&${firmId ? `firm_id=eq.${firmId}` : `firm_id=is.null&counselor_id=eq.${counselor.id}`}`);
  const [c] = await insertRows(t, "pipeline_contacts", [{
    firm_id: firmId, counselor_id: counselor.id, stage_id: stage.id, student_name: joiner.fullName, student_email: joiner.email,
    parent_name: "Joiner Parent", owner_id: counselor.id, grad_year: 2028,
  }]);
  const r = await api(t, "POST", `/pipeline/contacts/${c.id}/invite`, {});
  if (r.status !== 200) throw new Error(`invite the joiner: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const token = sql(`select i.token from public.invitations i join public.pipeline_contacts c on c.invitation_id = i.id where c.id = '${q(c.id)}'`);
  if (!token) throw new Error("the joiner's invitation has no token");
  return { contactId: c.id, token };
}

/** Two Meridies-wide Events Hub listings (created_by and firm_id null, as the CSV loader writes them). */
export function seedHubEvents() {
  const today = todayInSeedZone();
  const rows = [
    ["E2E College fair", "college-fair", "Meridies", shiftDate(today, 12), "everyone"],
    ["E2E Aid webinar", "webinar", "Meridies", shiftDate(today, 20), "counselor"],
  ];
  for (const [name, kind, host, date, audience] of rows) {
    sql(`insert into public.hub_events (name, kind, host, start_date, url, audience, source, description)
      select '${q(name)}', '${kind}', '${q(host)}', '${date}', 'https://example.com/events', '${audience}', 'manual', 'Seeded for the end-to-end suite.'
      where not exists (select 1 from public.hub_events where firm_id is null and created_by is null and lower(name) = lower('${q(name)}') and start_date = '${date}')`);
  }
}

/**
 * What the Overview and Calendar show beyond the roster: `invites` pending
 * invitations sent through the API (the Building profile cards; with no Resend
 * key the email is recorded, not sent) and the Meridies-wide Events Hub
 * listings saved to the counselor's calendar. Run seedHubEvents() first.
 */
export async function seedOverviewExtras(counselor, { invites = 3 } = {}) {
  for (let i = 1; i <= invites; i++) {
    const r = await api(counselor.token, "POST", "/invites", {
      email: `invitee-${i}-${counselor.id.slice(0, 8)}-${runTag}@test.local`, fullName: `Invited Student ${i}`, gradYear: 2028, source: "intake",
    });
    if (r.status !== 200 && r.status !== 201) throw new Error(`invite ${i}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const events = await rest(counselor.token, "GET", "/rest/v1/hub_events?select=id&firm_id=is.null&created_by=is.null&name=like.E2E*");
  await insertRows(counselor.token, "hub_event_saves", events.map((e) => ({ profile_id: counselor.id, event_id: e.id, targets: ["meridies"] })));
}

function argNumber(flag, fallback, max) {
  const i = process.argv.indexOf(flag);
  const n = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${flag} must be a whole number from 1 to ${max}`);
  return n;
}

async function main() {
  const perfStudents = argNumber("--students", 60, 500);
  const rosterSize = argNumber("--roster", 12, 200);
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`the API at ${API} isn't answering /health`);

  const counselor = await createPersona({ tag: "counselor", fullName: "Casey Counselor" });
  const member = await createPersona({ tag: "member", fullName: "Morgan Member" });
  const billing = await createPersona({ tag: "billing", fullName: "Blair Billing" });
  const student = await createPersona({ tag: "student", role: "student", fullName: "Sam Student" });
  const joiner = await createPersona({ tag: "joiner", role: "student", fullName: "Jamie Joiner" });
  const writer = await createPersona({ tag: "writer", fullName: "Wren Writer" });
  const writerMember = await createPersona({ tag: "writer-member", fullName: "Drew Member" });
  const perf = await createPersona({ tag: "perf", fullName: "Pat Perf" });
  const perfMembers = [
    await createPersona({ tag: "perf-member-1", fullName: "Riley Consultant" }),
    await createPersona({ tag: "perf-member-2", fullName: "Quinn Consultant" }),
  ];
  log("accounts created");

  await seedFirm(counselor, "E2E Counseling", [member]);
  await seedFirm(writer, "E2E Writes", [writerMember]);
  await seedFirm(perf, "Speed Test Counseling", perfMembers);

  const rosterIds = [...linkStudents(counselor, `u.id = '${q(student.id)}'`), ...createStudents(counselor, rosterSize - 1, "roster")];
  await seedRoster(counselor, rosterIds);
  await seedPractice(counselor, { contacts: 24, packages: 6, tasks: 9, assignees: [member], studentIds: rosterIds });
  seedHubEvents();
  await seedOverviewExtras(counselor);
  await seedBillingScenario(billing);
  const join = await createJoinInvite(counselor, joiner);

  const writerIds = createStudents(writer, 4, "writer");
  await seedRoster(writer, writerIds);
  await seedPractice(writer, { contacts: 6, packages: 0, tasks: 3, assignees: [writerMember], studentIds: writerIds });

  const perfIds = createStudents(perf, perfStudents, "perf");
  await seedRoster(perf, perfIds);
  await seedPractice(perf, { contacts: 60, packages: 20, tasks: 20, assignees: perfMembers, studentIds: perfIds });
  await seedOverviewExtras(perf);
  log("done");

  const out = {
    E2E_STACK: "local",
    E2E_COUNSELOR_EMAIL: counselor.email, E2E_COUNSELOR_PASSWORD: counselor.password,
    E2E_MEMBER_EMAIL: member.email, E2E_MEMBER_PASSWORD: member.password,
    E2E_WRITER_EMAIL: writer.email, E2E_WRITER_PASSWORD: writer.password,
    E2E_WRITER_MEMBER_EMAIL: writerMember.email, E2E_WRITER_MEMBER_PASSWORD: writerMember.password,
    E2E_BILLING_EMAIL: billing.email, E2E_BILLING_PASSWORD: billing.password,
    E2E_STUDENT_EMAIL: student.email, E2E_STUDENT_PASSWORD: student.password, E2E_STUDENT_ID: student.id,
    E2E_JOINER_EMAIL: joiner.email, E2E_JOINER_PASSWORD: joiner.password,
    E2E_JOIN_TOKEN: join.token, E2E_JOIN_CONTACT_ID: join.contactId,
    E2E_PERF_EMAIL: perf.email, E2E_PERF_PASSWORD: perf.password,
  };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
