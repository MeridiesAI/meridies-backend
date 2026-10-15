// Load check for transfer_caseload (spec §7): the 500-student cap in one call,
// each student carrying a typical record (folder, document, meeting, note,
// message, open work item, held import data), through the API under the
// authenticated role's statement timeout (8 s on Supabase).
// NOTE: leaves its students and data behind; reset the stack afterwards.
// Not part of `npm run test:integration` (slow). Run: npm run test:caseload-load
import { call, check, sql, user } from "./harness.mjs";

const N = Number(process.env.CASELOAD_LOAD_STUDENTS ?? 500);
const BUDGET_MS = Number(process.env.CASELOAD_LOAD_BUDGET_MS ?? 8000);

const A = await user("ct-load-owner");
const B = await user("ct-load-from");
const C = await user("ct-load-to");
const D = await user("ct-load-to2");
const created = await call(A.token, "POST", "/firms", { name: `Load firm ${Date.now()}` });
const firmId = created.body.firmId;
for (const u of [B, C, D]) {
  await sql(`insert into public.firm_members (firm_id, profile_id, seat_role) values ('${firmId}', '${u.id}', 'counselor')`);
  await sql(`update public.profiles set firm_id = '${firmId}' where id = '${u.id}'`);
}

async function caseload(counselor, n, label) {
  const stamp = `${label}-${Date.now()}`;
  await sql(`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
    select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'ctload-' || g || '-${stamp}@test.local', '', now(),
           jsonb_build_object('full_name', 'Load Student ' || g, 'role', 'student'), now(), now()
    from generate_series(1, ${n}) g`);
  // Setting the counselor fires the folder trigger, as accepting an invitation would.
  await sql(`update public.profiles p set counselor_id = '${counselor.id}', role = 'student'
    from auth.users u where u.id = p.id and u.email like 'ctload-%-${stamp}@test.local'`);
  const where = `counselor_id = '${counselor.id}'`;
  await sql(`insert into public.meetings (student_id, counselor_id, title, starts_at) select id, '${counselor.id}', 'Check-in', now() + interval '3 days' from public.profiles where ${where}`);
  await sql(`insert into public.meeting_notes (student_id, counselor_id, title) select id, '${counselor.id}', 'Notes' from public.profiles where ${where}`);
  await sql(`insert into public.student_messages (student_id, counselor_id, audience, channel, recipients, subject, body, status) select id, '${counselor.id}', 'student', 'email', '[{"kind":"student","email":"x@test.local"}]', 'Hi', 'Hello', 'sent' from public.profiles where ${where}`);
  await sql(`insert into public.counselor_work_items (counselor_id, student_id, title) select '${counselor.id}', id, 'Follow up' from public.profiles where ${where}`);
  await sql(`insert into public.documents (owner_id, student_id, folder_id, bucket, storage_path, filename, kind)
    select '${counselor.id}', p.id, f.id, 'student-documents', '${counselor.id}/' || p.id || '/t.pdf', 't.pdf', 'transcript'
      from public.profiles p join public.folders f on f.student_id = p.id and f.owner_id = '${counselor.id}' and f.kind = 'student'
     where p.${where}`);
  const imp = await sql(`with i as (insert into public.roster_imports (counselor_id, filename, source, status) values ('${counselor.id}', 'load.csv', 'csv', 'complete') returning id) select id from i`);
  await sql(`insert into public.import_items (import_id, match_status, student_id, match_confidence, held_until)
    select '${imp}', 'awaiting_counselor', id, 'high', now() + interval '20 days' from public.profiles where ${where}`);
  await sql(`insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, decision)
    select '${imp}', it.id, 'student_academics', 'sat_superscore', 'set_field', '1400'::jsonb, 'keep_old' from public.import_items it where it.import_id = '${imp}'`);
  return Number(await sql(`select count(*) from public.profiles where ${where}`));
}

console.log(`creating ${N} students with their records…`);
const made = await caseload(B, N, "one");
check(`${N} students on B's caseload`, made === N, String(made));

let t0 = Date.now();
let r = await call(A.token, "POST", `/management/consultants/${B.id}/transfer`, { mode: "one_person", toId: C.id, notifyStudents: false });
let ms = Date.now() - t0;
check(`one_person: ${N} students in one call (${ms} ms)`, r.status === 200 && r.body.studentCount === N, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
check(`…inside ${BUDGET_MS} ms`, ms < BUDGET_MS, `${ms} ms`);
check("every student and their records moved",
  Number(await sql(`select count(*) from public.profiles where counselor_id = '${C.id}'`)) === N
  && Number(await sql(`select count(*) from public.meetings where counselor_id = '${B.id}'`)) === 0
  && Number(await sql(`select count(*) from public.documents where owner_id = '${B.id}'`)) === 0
  && Number(await sql(`select count(*) from public.import_items it join public.roster_imports i on i.id = it.import_id where i.counselor_id = '${C.id}' and it.match_status = 'awaiting_counselor'`)) === N);

// per_student: the same caseload split across C and D.
const ids = (await sql(`select id from public.profiles where counselor_id = '${C.id}' order by id`)).split("\n").filter(Boolean);
const assignments = ids.map((id, i) => ({ studentId: id, toId: i % 2 ? D.id : B.id }));
t0 = Date.now();
r = await call(A.token, "POST", `/management/consultants/${C.id}/transfer`, { mode: "per_student", assignments, notifyStudents: false });
ms = Date.now() - t0;
check(`per_student: ${N} assignments in one call (${ms} ms)`, r.status === 200 && r.body.studentCount === N, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
check(`…inside ${BUDGET_MS} ms`, ms < BUDGET_MS, `${ms} ms`);
