-- Import pipeline, step 1: provenance (spec §5.6), compaction (§5.10) and the
-- one database function that copies GPAs somewhere with a 10-point limit.

create or replace function public.import_field_provenance(p_student uuid, p_target text, p_field text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'importId', ch.import_id,
    'sourceSystem', i.source_system,
    'templateId', i.template_id,
    'matchesCurrent', ch.new_value_hash = private.import_value_hash(
                        private.import_current_value(p_target, p_field, p_student))
  )
  from public.import_changes ch
  join public.import_items it on it.id = ch.item_id
  join public.roster_imports i on i.id = ch.import_id
  where it.student_id = p_student
    and ch.target_table = p_target
    and ch.field = p_field
    and ch.op = 'set_field'
    and ch.state = 'applied'
    and ch.new_value_hash is not null
  order by ch.applied_at desc
  limit 1;
$$;

-- After the undo window: drop values, keep fingerprints (personal data,
-- deleted with the student's account by cascade). Held data that is still
-- waiting is left alone; it has its own 30-day clock (§5.8).
create or replace function public.compact_imports()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_deleted integer := 0;
begin
  update public.import_changes ch
     set old_value = null, new_value = null, applied_value = null
    from public.roster_imports i, public.import_items it
   where i.id = ch.import_id
     and it.id = ch.item_id
     and i.undo_until is not null and i.undo_until < now()
     and it.match_status not in ('new_invite','awaiting_counselor','applying')
     and ch.state <> 'staged'
     and (ch.old_value is not null or ch.new_value is not null or ch.applied_value is not null);
  get diagnostics v_n = row_count;

  -- Staged changes nobody applied (kept-old, rejected, unconfirmed): not needed.
  delete from public.import_changes ch
   using public.roster_imports i, public.import_items it
   where i.id = ch.import_id
     and it.id = ch.item_id
     and i.undo_until is not null and i.undo_until < now()
     and it.match_status not in ('new_invite','awaiting_counselor','applying')
     and ch.state = 'staged';
  get diagnostics v_deleted = row_count;

  update public.import_files f
     set profile = null
    from public.roster_imports i
   where i.id = f.import_id and i.undo_until is not null and i.undo_until < now() and f.profile is not null;

  update public.roster_imports
     set compacted_at = now()
   where undo_until is not null and undo_until < now() and compacted_at is null;

  return v_n + v_deleted;
end;
$$;

revoke all on function public.import_field_provenance(uuid, text, text) from public, anon, authenticated;
revoke all on function public.compact_imports() from public, anon, authenticated;
grant execute on function public.import_field_provenance(uuid, text, text) to import_worker, service_role;
grant execute on function public.compact_imports() to import_worker, service_role;

-- ---------------------------------------------------------------------------
-- Close cycle copies GPAs into admission_outcomes, whose columns stay ≤ 10.
-- A 100-point GPA (allowed in student_academics since 20261013000001) is
-- recorded as unknown there rather than failing the whole close.
-- Copied from 20261005010003; the only change is the GPA line in the select.
-- ---------------------------------------------------------------------------
create or replace function public.close_admission_cycle(p_cycle text)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_user       uuid := auth.uid();
  v_class      text;
  v_firm       uuid;
  v_seniors    uuid[];
  v_recorded   integer := 0;
  v_locked     integer := 0;
  v_alumni     integer := 0;
  v_student    uuid;
  v_enrolled   public.admission_outcomes;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if (select role from public.profiles where id = v_user) is distinct from 'counselor' then
    raise exception 'Only counselors can close a cycle' using errcode = '42501';
  end if;
  if p_cycle !~ '^\d{4}-\d{4}$' or right(p_cycle, 4)::int <> left(p_cycle, 4)::int + 1 then
    raise exception 'A cycle reads like 2026-2027' using errcode = '22023';
  end if;
  if exists (select 1 from public.admission_cycles where counselor_id = v_user and cycle = p_cycle) then
    raise exception 'That cycle is already closed' using errcode = '23505';
  end if;

  -- The fall 2026 cycle's seniors are the class of 2027.
  v_class := right(p_cycle, 4);
  select firm_id into v_firm from public.profiles where id = v_user;

  select coalesce(array_agg(p.id), '{}') into v_seniors
  from public.profiles p
  where p.counselor_id = v_user
    and p.role = 'student'
    and p.archived_at is null
    and btrim(coalesce(p.grad_year, '')) = v_class
    and not exists (select 1 from public.alumni_records a where a.student_id = p.id);

  -- Record every decision on the seniors' college lists not already recorded.
  with ins as (
    insert into public.admission_outcomes (
      counselor_id, firm_id, student_id, student_name, high_school_name, cycle,
      college_id, college_name, round, result, enrolled,
      gpa_unweighted, gpa_weighted, sat, act, hooks, intended_major, student_college_id
    )
    select
      v_user, v_firm, p.id, p.full_name,
      coalesce(nullif(btrim(p.high_school), ''), 'Unknown high school'),
      p_cycle, sc.college_id, sc.name,
      coalesce(sc.round, 'RD'),
      case sc.status when 'accepted' then 'admitted' when 'enrolled' then 'admitted' else sc.status end,
      sc.status = 'enrolled',
      case when sa.gpa_unweighted <= 10 then sa.gpa_unweighted end,
      case when sa.gpa_weighted <= 10 then sa.gpa_weighted end,
      sa.sat_superscore, sa.act_composite,
      case when sc.round in ('ED','ED2') or sc.binding then array['ed']::text[] else '{}'::text[] end,
      nullif(btrim(coalesce(p.profile->>'intendedMajor', '')), ''),
      sc.id
    from public.student_colleges sc
    join public.profiles p on p.id = sc.student_id
    left join public.student_academics sa on sa.student_id = p.id
    where sc.student_id = any(v_seniors)
      and sc.status in ('accepted','enrolled','denied','waitlisted','deferred','withdrawn')
      and not exists (
        select 1 from public.admission_outcomes o
        where o.student_college_id = sc.id and o.cycle = p_cycle
      )
    returning 1
  )
  select count(*) into v_recorded from ins;

  with upd as (
    update public.admission_outcomes
       set locked = true
     where counselor_id = v_user and cycle = p_cycle and not locked
       and (student_id is null or student_id = any(v_seniors))
    returning 1
  )
  select count(*) into v_locked from upd;

  foreach v_student in array v_seniors loop
    select * into v_enrolled
    from public.admission_outcomes
    where student_id = v_student and cycle = p_cycle and enrolled
    order by updated_at desc
    limit 1;

    insert into public.alumni_records (student_id, counselor_id, cycle, college_id, institution_name, program, outcome_id)
    values (
      v_student, v_user, p_cycle,
      v_enrolled.college_id, v_enrolled.college_name, v_enrolled.intended_major, v_enrolled.id
    )
    on conflict (student_id) do nothing;
    v_alumni := v_alumni + 1;
    v_enrolled := null;
  end loop;

  insert into public.admission_cycles (counselor_id, cycle, alumni_count, rows_recorded, rows_locked)
  values (v_user, p_cycle, v_alumni, v_recorded, v_locked);

  return jsonb_build_object(
    'cycle', p_cycle,
    'alumniCount', v_alumni,
    'rowsRecorded', v_recorded,
    'rowsLocked', v_locked
  );
end;
$function$;

revoke all on function public.close_admission_cycle(text) from public, anon;
grant execute on function public.close_admission_cycle(text) to authenticated;
