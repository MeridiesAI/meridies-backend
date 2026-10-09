-- Import pipeline, step 1: the only code that writes imported values into
-- student records. Fixed statements per target and field (no dynamic SQL,
-- spec §6.2). Each single-row write is one compare-and-set UPDATE, so a value
-- a person changed after review is never overwritten (§5.7 step 4).

create or replace function private.import_set_field(
  p_target text, p_field text, p_student uuid, p_expected jsonb, p_new jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  e jsonb := case when private.import_absent(p_expected) then null else p_expected end;
  v jsonb := case when private.import_absent(p_new) then null else p_new end;
begin
  if p_target = 'student_academics' then
    insert into public.student_academics (student_id) values (p_student) on conflict (student_id) do nothing;
    case p_field
      when 'gpa_unweighted' then
        update public.student_academics set gpa_unweighted = (v #>> '{}')::numeric
         where student_id = p_student and gpa_unweighted is not distinct from (e #>> '{}')::numeric;
      when 'gpa_weighted' then
        update public.student_academics set gpa_weighted = (v #>> '{}')::numeric
         where student_id = p_student and gpa_weighted is not distinct from (e #>> '{}')::numeric;
      when 'gpa_scale' then
        update public.student_academics set gpa_scale = v #>> '{}'
         where student_id = p_student and gpa_scale is not distinct from e #>> '{}';
      when 'class_rank' then
        update public.student_academics set class_rank = v #>> '{}'
         where student_id = p_student and class_rank is not distinct from e #>> '{}';
      when 'class_rank_value' then
        update public.student_academics set class_rank_value = v #>> '{}'
         where student_id = p_student and class_rank_value is not distinct from e #>> '{}';
      when 'test_status' then
        update public.student_academics set test_status = v #>> '{}'
         where student_id = p_student and test_status is not distinct from e #>> '{}';
      when 'sat_ebrw' then
        update public.student_academics set sat_ebrw = (v #>> '{}')::integer
         where student_id = p_student and sat_ebrw is not distinct from (e #>> '{}')::integer;
      when 'sat_math' then
        update public.student_academics set sat_math = (v #>> '{}')::integer
         where student_id = p_student and sat_math is not distinct from (e #>> '{}')::integer;
      when 'sat_superscore' then
        update public.student_academics set sat_superscore = (v #>> '{}')::integer
         where student_id = p_student and sat_superscore is not distinct from (e #>> '{}')::integer;
      when 'act_composite' then
        update public.student_academics set act_composite = (v #>> '{}')::integer
         where student_id = p_student and act_composite is not distinct from (e #>> '{}')::integer;
      else
        raise exception 'Not an importable field: student_academics.%', p_field using errcode = '22023';
    end case;
  elsif p_target = 'student_personal_details' then
    insert into public.student_personal_details (student_id) values (p_student) on conflict (student_id) do nothing;
    case p_field
      when 'contact_email' then
        update public.student_personal_details set contact_email = v #>> '{}'
         where student_id = p_student and contact_email is not distinct from e #>> '{}';
      when 'address' then
        update public.student_personal_details set address = v #>> '{}'
         where student_id = p_student and address is not distinct from e #>> '{}';
      when 'gender' then
        update public.student_personal_details set gender = v #>> '{}'
         where student_id = p_student and gender is not distinct from e #>> '{}';
      when 'birthday' then
        update public.student_personal_details set birthday = (v #>> '{}')::date
         where student_id = p_student and birthday is not distinct from (e #>> '{}')::date;
      when 'citizenship' then
        update public.student_personal_details set citizenship = v #>> '{}'
         where student_id = p_student and citizenship is not distinct from e #>> '{}';
      when 'first_gen' then
        update public.student_personal_details set first_gen = (v #>> '{}')::boolean
         where student_id = p_student and first_gen is not distinct from (e #>> '{}')::boolean;
      when 'intended_majors' then
        update public.student_personal_details
           set intended_majors = coalesce(array(select jsonb_array_elements_text(coalesce(v, '[]'::jsonb))), '{}')
         where student_id = p_student
           and intended_majors = coalesce(array(select jsonb_array_elements_text(coalesce(e, '[]'::jsonb))), '{}');
      else
        raise exception 'Not an importable field: student_personal_details.%', p_field using errcode = '22023';
    end case;
  else
    raise exception 'Not a single-row import target: %', p_target using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

create or replace function private.import_text_array(v jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when v is not null and jsonb_typeof(v) = 'array'
              then array(select jsonb_array_elements_text(v)) else '{}'::text[] end;
$$;

-- Duplicate keys are final for v1.0 (spec §4.3). Apply-time dedupe is
-- exact-only; looser matches (same name, missing year, etc.) are suggestions
-- the counselor confirms at staging, never dropped silently here.
create or replace function private.import_insert_row(p_target text, p_student uuid, p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_target = 'test_scores' then
    if exists (
      select 1 from public.test_scores t
      where t.student_id = p_student
        and t.kind = p_row ->> 'kind'
        and lower(btrim(t.exam)) = lower(btrim(p_row ->> 'exam'))
        and (
          (t.taken_on is not null and p_row ->> 'taken_on' is not null
           and t.taken_on = (p_row ->> 'taken_on')::date)
          or ((t.taken_on is null or p_row ->> 'taken_on' is null)
              and t.score is not distinct from (p_row ->> 'score'))
        )
    ) then
      return null;
    end if;
    insert into public.test_scores (student_id, exam, kind, score, taken_on, source)
    values (p_student, p_row ->> 'exam', p_row ->> 'kind', p_row ->> 'score',
            (p_row ->> 'taken_on')::date, 'import')
    returning id into v_id;
  elsif p_target = 'courses' then
    if exists (
      select 1 from public.courses c
      where c.student_id = p_student
        and lower(btrim(c.name)) = lower(btrim(p_row ->> 'name'))
        and c.school_year is not null
        and p_row ->> 'school_year' is not null
        and c.school_year = (p_row ->> 'school_year')
    ) then
      return null;
    end if;
    insert into public.courses (student_id, name, type, grade, status, school_year, source)
    values (p_student, p_row ->> 'name', p_row ->> 'type', p_row ->> 'grade',
            p_row ->> 'status', p_row ->> 'school_year', 'import')
    returning id into v_id;
  elsif p_target = 'activities' then
    if exists (
      select 1 from public.activities a
      where a.student_id = p_student
        and lower(btrim(coalesce(a.name, ''))) = lower(btrim(coalesce(p_row ->> 'name', '')))
        and a.position is not distinct from (p_row ->> 'position')
        and a.organization is not distinct from (p_row ->> 'organization')
        and a.grade_levels is not distinct from private.import_text_array(p_row -> 'grade_levels')
    ) then
      return null;
    end if;
    insert into public.activities (student_id, name, position, organization, category,
                                   hours_per_week, weeks_per_year, description, grade_levels, source)
    values (p_student, p_row ->> 'name', p_row ->> 'position', p_row ->> 'organization', p_row ->> 'category',
            (p_row ->> 'hours_per_week')::numeric, (p_row ->> 'weeks_per_year')::integer,
            p_row ->> 'description', private.import_text_array(p_row -> 'grade_levels'), 'import')
    returning id into v_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  return v_id;
end;
$$;

create or replace function private.import_row_snapshot(p_target text, p_row_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_target = 'test_scores' then
    select jsonb_build_object('exam', exam, 'kind', kind, 'score', score, 'taken_on', taken_on)
      into v from public.test_scores where id = p_row_id;
  elsif p_target = 'courses' then
    select jsonb_build_object('name', name, 'type', type, 'grade', grade, 'status', status, 'school_year', school_year)
      into v from public.courses where id = p_row_id;
  elsif p_target = 'activities' then
    select jsonb_build_object('name', name, 'position', position, 'organization', organization,
                              'category', category, 'hours_per_week', hours_per_week,
                              'weeks_per_year', weeks_per_year, 'description', description,
                              'grade_levels', grade_levels)
      into v from public.activities where id = p_row_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  return v;
end;
$$;

create or replace function private.import_delete_row(p_target text, p_row_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
begin
  if p_target = 'test_scores' then
    delete from public.test_scores where id = p_row_id;
  elsif p_target = 'courses' then
    delete from public.courses where id = p_row_id;
  elsif p_target = 'activities' then
    delete from public.activities where id = p_row_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function private.import_set_field(text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.import_text_array(jsonb) from public, anon;
revoke all on function private.import_insert_row(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.import_row_snapshot(text, uuid) from public, anon, authenticated;
revoke all on function private.import_delete_row(text, uuid) from public, anon, authenticated;
