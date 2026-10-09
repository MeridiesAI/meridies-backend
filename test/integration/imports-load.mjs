// Pre-release load test (spec §9 "Load"): commit and undo the import maximum,
// 5,000 rows in total × every single-row field + one insert per row, through
// the API and the import_worker connection, within the 300 s timeout.
// NOTE: this script leaves its students and data behind; run `supabase db reset` afterwards.
// Not part of `npm run test:integration` (slow). Run: npm run test:imports-load
import { call, check, sql, user } from "./harness.mjs";

const ROWS = Number(process.env.IMPORT_LOAD_ROWS ?? 5000);
const c = await user("imp-load");

const imp = await sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${c.id}', 'load.csv', 'csv', 'review') returning id) select id from i`);
console.log(`creating ${ROWS} students…`);
// Students are created directly in auth.users; the handle_new_user trigger
// creates their profiles. The profile update is a separate statement because a
// data-modifying CTE cannot see rows a trigger inserted in the same statement.
const stamp = Date.now();
await sql(`
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'load-' || g || '-${stamp}@test.local', '', now(),
         jsonb_build_object('full_name', 'Load Student ' || g, 'role', 'student'), now(), now()
  from generate_series(1, ${ROWS}) g`);
await sql(`update public.profiles p set counselor_id = '${c.id}', role = 'student'
  from auth.users u where u.id = p.id and u.email like 'load-%-${stamp}@test.local'`);
const students = Number(await sql(`select count(*) from public.profiles where counselor_id = '${c.id}'`));
check(`${ROWS} students exist`, students === ROWS, String(students));
if (students !== ROWS) process.exit(1);

console.log("staging changes…");
await sql(`insert into public.import_items (import_id, match_status, student_id, match_confidence)
  select '${imp}', 'matched_email', p.id, 'high' from public.profiles p where p.counselor_id = '${c.id}'`);
await sql(`
  insert into public.import_changes (import_id, item_id, target_table, field, op, old_value, new_value, decision)
  select '${imp}', it.id, f.t, f.f, 'set_field', null, f.v, 'accept'
  from public.import_items it
  cross join (values
    ('student_academics','gpa_unweighted','3.7'::jsonb), ('student_academics','gpa_weighted','4.1'::jsonb),
    ('student_academics','gpa_scale','"4.0"'::jsonb), ('student_academics','class_rank','"12/400"'::jsonb),
    ('student_academics','class_rank_value','"top 5%"'::jsonb), ('student_academics','test_status','"taken"'::jsonb),
    ('student_academics','sat_ebrw','720'::jsonb), ('student_academics','sat_math','740'::jsonb),
    ('student_academics','sat_superscore','1460'::jsonb), ('student_academics','act_composite','33'::jsonb),
    ('student_personal_details','contact_email','"load@test.local"'::jsonb), ('student_personal_details','address','"1 Main St"'::jsonb),
    ('student_personal_details','gender','"undisclosed"'::jsonb), ('student_personal_details','birthday','"2008-01-01"'::jsonb),
    ('student_personal_details','citizenship','"us-citizen"'::jsonb), ('student_personal_details','first_gen','false'::jsonb),
    ('student_personal_details','intended_majors','["Biology"]'::jsonb)
  ) as f(t, f, v)
  where it.import_id = '${imp}'`);
await sql(`insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, decision)
  select '${imp}', it.id, 'test_scores', '*', 'insert_row', '{"exam":"AP Biology","kind":"ap","score":"5"}'::jsonb, 'accept'
  from public.import_items it where it.import_id = '${imp}'`);
const total = Number(await sql(`select count(*) from public.import_changes where import_id = '${imp}'`));
console.log(`${total} changes staged`);

const DEADLINE_MS = 300_000;
async function timed(path, waitWhile) {
  const t0 = Date.now();
  const r = await call(c.token, "POST", path);
  if (r.status !== 202) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
  for (;;) {
    const s = await call(c.token, "GET", `/imports/${imp}`);
    if (s.body.status !== waitWhile) return { ms: Date.now() - t0, body: s.body };
    if (Date.now() - t0 > DEADLINE_MS + 10_000) {
      check(`${path} finishes within 300 s`, false, `still ${waitWhile} after ${Date.now() - t0} ms`);
      process.exit(1);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

const count = async (q) => Number(await sql(q));
const mine = `(select id from public.profiles where counselor_id = '${c.id}')`;

const commit = await timed(`/imports/${imp}/commit`, "committing");
console.log(`commit: ${commit.ms} ms`, commit.body.jobResult);
check("commit finishes within 300 s", commit.body.status === "committed" && commit.ms < 300_000, `${commit.ms} ms ${commit.body.status}`);
check("commit applied every change", commit.body.jobResult?.applied === ROWS * 18, `${commit.body.jobResult?.applied} of ${ROWS * 18}`);
check("academics rows written", (await count(`select count(*) from public.student_academics where student_id in ${mine} and sat_superscore = 1460`)) === ROWS);
check("test_scores rows written", (await count(`select count(*) from public.test_scores where student_id in ${mine} and source = 'import'`)) === ROWS);
const undo = await timed(`/imports/${imp}/undo`, "undoing");
console.log(`undo: ${undo.ms} ms`, undo.body.jobResult);
check("undo finishes within 300 s", undo.body.status === "undone" && undo.ms < 300_000, `${undo.ms} ms ${undo.body.status}`);
check("undo reverted every change", undo.body.jobResult?.reverted === ROWS * 18, `${undo.body.jobResult?.reverted}`);
check("imported test_scores gone", (await count(`select count(*) from public.test_scores where student_id in ${mine} and source = 'import'`)) === 0);
check("imported academics values gone", (await count(`select count(*) from public.student_academics where student_id in ${mine} and sat_superscore is not null`)) === 0);
