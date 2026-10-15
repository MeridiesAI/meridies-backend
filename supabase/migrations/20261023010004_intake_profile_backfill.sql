-- Questionnaire sync, 4 of 4: fill the record for every student who answered
-- the questionnaire before the trigger existed.
--
-- Runs private.sync_intake_answers (20261023010002) once per student with
-- answers on file, under the same rules as a save: fill only what is empty,
-- never touch an archived student. Safe to re-run by hand, all students
-- (select private.backfill_intake_answers();) or one
-- (select private.backfill_intake_answers('<student id>');): intake_fills and
-- the fill-only-empty rule make a second run change nothing. A student whose
-- sync fails is counted and skipped; the rest still run. One audit_log row
-- per run, counts only.

create or replace function private.backfill_intake_answers(p_only uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v jsonb;
  n_students integer := 0;
  n_changed integer := 0;
  n_failed integer := 0;
  v_result jsonb;
begin
  for r in
    select p.id, p.profile -> 'intakeAnswers' as answers
      from public.profiles p
     where p.role = 'student'
       and p.archived_at is null
       and jsonb_typeof(p.profile -> 'intakeAnswers') = 'object'
       and (p_only is null or p.id = p_only)
     order by p.id
  loop
    begin
      v := private.sync_intake_answers(r.id, r.answers, null, 'backfill');
      n_students := n_students + 1;
      n_changed := n_changed + jsonb_array_length(v -> 'done');
    exception when others then
      n_failed := n_failed + 1;
    end;
  end loop;
  v_result := jsonb_build_object('students', n_students, 'changed', n_changed, 'failed', n_failed);
  insert into public.audit_log (actor_id, student_id, action, entity_type, metadata)
  values (null, p_only, 'intake.backfill', 'profile', v_result);
  return v_result;
end;
$$;
revoke all on function private.backfill_intake_answers(uuid) from public, anon, authenticated;

select private.backfill_intake_answers();
