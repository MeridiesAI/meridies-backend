-- Questionnaire sync, 1 of 4: widen the import pipeline's allowlist and value
-- functions so the onboarding questionnaire can write through them.
--
-- Why the questionnaire reuses the import code: it is the one place that
-- already knows what a valid value is for every student field
-- (import_value_ok), reads the stored value the way a compare-and-set needs it
-- (import_current_value) and writes one field with a compare-and-set
-- (import_set_field), so a value someone else changed is never overwritten.
-- The questionnaire's own rules (fill only what is empty, update only what it
-- wrote itself) live in 20261023010002 on top of these.
--
-- No behaviour change for imports:
--  - every existing function keeps its signature and its callers;
--  - import_insert_row(text, uuid, jsonb) still stamps source = 'import' (it
--    is now a wrapper over a new 4-argument version that takes the source);
--  - import_row_snapshot returns exactly the shape it did for test scores,
--    courses and activities, because undo_import compares a row's snapshot
--    with the one stored at commit. The new awards branch is additive.
--
-- What is new: the targets profiles.high_school / hometown / grad_year,
-- student_academics.gpa_band and award rows; the value type grad_year; the
-- optional activity keys timing, continuing and uc_description; and a
-- sort_order for inserted activities and awards so new rows land at the end of
-- the sheet instead of at position 0.

-- ---------------------------------------------------------------------------
-- import_fields
-- ---------------------------------------------------------------------------

alter table public.import_fields drop constraint if exists import_fields_target_table_check;
alter table public.import_fields add constraint import_fields_target_table_check
  check (target_table in ('student_academics','student_personal_details','test_scores','courses',
                          'activities','awards','profiles'));

insert into public.import_fields (target_table, field, value_type, sensitivity) values
  ('student_academics', 'gpa_band',    'text:40',   3),
  ('profiles',          'high_school', 'text:200',  1),
  ('profiles',          'hometown',    'text:200',  1),
  ('profiles',          'grad_year',   'grad_year', 1),
  ('awards',            '*',           'row:award', 1)
on conflict (target_table, field) do update
  set value_type = excluded.value_type, sensitivity = excluded.sensitivity;

-- ---------------------------------------------------------------------------
-- What a valid value is. Body copied from 20261014000003; additions marked NEW.
-- ---------------------------------------------------------------------------

create or replace function private.import_value_ok_raw(p_type text, v jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  n numeric;
  s text;
begin
  if private.import_absent(v) then
    return false;
  end if;

  if p_type = 'gpa' then
    n := private.import_num(v);
    return n is not null and n between 0 and 110;
  elsif p_type = 'sat_total' then
    n := private.import_num(v);
    return n is not null and n = trunc(n) and n between 400 and 1600;
  elsif p_type = 'sat_section' then
    n := private.import_num(v);
    return n is not null and n = trunc(n) and n between 200 and 800;
  elsif p_type = 'act_composite' then
    n := private.import_num(v);
    return n is not null and n = trunc(n) and n between 1 and 36;
  elsif p_type = 'date' then
    return private.import_is_date(private.import_str(v));
  elsif p_type = 'email' then
    s := private.import_str(v);
    return s is not null and length(s) <= 320 and s ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$';
  elsif p_type = 'bool' then
    return jsonb_typeof(v) = 'boolean';
  elsif p_type = 'grad_year' then
    -- NEW: profiles.grad_year is text; a class year reads like 2027.
    return coalesce(private.import_str(v) ~ '^20\d\d$', false);
  elsif p_type like 'text:%' then
    return private.import_text_ok(v, split_part(p_type, ':', 2)::integer);
  elsif p_type = 'text[]' then
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 10 then
      return false;
    end if;
    return not exists (
      select 1 from jsonb_array_elements(v) e where not private.import_text_ok(e, 200)
    );
  elsif p_type = 'enum:gender' then
    return private.import_str(v) in ('female','male','non-binary','undisclosed');
  elsif p_type = 'enum:citizenship' then
    return private.import_str(v) in ('us-citizen','permanent-resident','international');
  elsif p_type = 'enum:test_status' then
    return private.import_str(v) in ('not-started','prepping','scheduled','taken','retaking','test-optional');
  elsif p_type = 'row:test_score' then
    if jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) k where k not in ('exam','kind','score','taken_on')) then
      return false;
    end if;
    return private.import_text_ok(v -> 'exam', 200)
       and private.import_str(v -> 'kind') in ('ap','sat','act','ib','toefl','ielts','other')
       and (private.import_absent(v -> 'score') or private.import_text_ok(v -> 'score', 40))
       and (private.import_absent(v -> 'taken_on') or private.import_is_date(private.import_str(v -> 'taken_on')));
  elsif p_type = 'row:course' then
    if jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) k where k not in ('name','type','grade','status','school_year')) then
      return false;
    end if;
    return private.import_text_ok(v -> 'name', 300)
       and (private.import_absent(v -> 'type')
            or private.import_str(v -> 'type') in ('ap','ib','honors','dual-enrollment','college','other'))
       and (private.import_absent(v -> 'grade') or private.import_text_ok(v -> 'grade', 40))
       and (private.import_absent(v -> 'status')
            or private.import_str(v -> 'status') in ('planned','in-progress','completed'))
       and (private.import_absent(v -> 'school_year') or private.import_text_ok(v -> 'school_year', 40));
  elsif p_type = 'row:activity' then
    if jsonb_typeof(v) <> 'object' then return false; end if;
    -- NEW keys: timing, continuing, uc_description.
    if exists (select 1 from jsonb_object_keys(v) k where k not in
               ('name','position','organization','category','hours_per_week','weeks_per_year','description','grade_levels',
                'timing','continuing','uc_description')) then
      return false;
    end if;
    return private.import_text_ok(v -> 'name', 300)
       and (private.import_absent(v -> 'position') or private.import_text_ok(v -> 'position', 200))
       and (private.import_absent(v -> 'organization') or private.import_text_ok(v -> 'organization', 200))
       and (private.import_absent(v -> 'category') or private.import_text_ok(v -> 'category', 100))
       and (private.import_absent(v -> 'hours_per_week')
            or coalesce(private.import_num(v -> 'hours_per_week') between 0 and 168, false))
       and (private.import_absent(v -> 'weeks_per_year')
            or coalesce(private.import_num(v -> 'weeks_per_year') = trunc(private.import_num(v -> 'weeks_per_year'))
                        and private.import_num(v -> 'weeks_per_year') between 0 and 52, false))
       and (private.import_absent(v -> 'description') or private.import_text_ok(v -> 'description', 2000))
       and (private.import_absent(v -> 'grade_levels') or private.import_value_ok('text[]', v -> 'grade_levels'))
       -- NEW
       and (private.import_absent(v -> 'timing')
            or (jsonb_typeof(v -> 'timing') = 'array' and jsonb_array_length(v -> 'timing') <= 3
                and not exists (select 1 from jsonb_array_elements(v -> 'timing') e
                                where private.import_str(e) is null
                                   or private.import_str(e) not in ('school','break','year'))))
       and (private.import_absent(v -> 'continuing') or jsonb_typeof(v -> 'continuing') = 'boolean')
       and (private.import_absent(v -> 'uc_description') or private.import_text_ok(v -> 'uc_description', 2000));
  elsif p_type = 'row:award' then
    -- NEW: an Awards & Honors sheet row (public.awards).
    if jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) k where k not in
               ('name','level','year','grade_levels','recognition_levels','uc_level','uc_criteria','uc_earned')) then
      return false;
    end if;
    return private.import_text_ok(v -> 'name', 300)
       and (private.import_absent(v -> 'level') or private.import_text_ok(v -> 'level', 100))
       and (private.import_absent(v -> 'year') or private.import_text_ok(v -> 'year', 20))
       and (private.import_absent(v -> 'grade_levels')
            or (jsonb_typeof(v -> 'grade_levels') = 'array'
                and not exists (select 1 from jsonb_array_elements(v -> 'grade_levels') e
                                where private.import_str(e) is null
                                   or private.import_str(e) not in ('9','10','11','12','PG'))))
       and (private.import_absent(v -> 'recognition_levels')
            or (jsonb_typeof(v -> 'recognition_levels') = 'array'
                and not exists (select 1 from jsonb_array_elements(v -> 'recognition_levels') e
                                where private.import_str(e) is null
                                   or private.import_str(e) not in ('school','state-regional','national','international'))))
       and (private.import_absent(v -> 'uc_level')
            or private.import_str(v -> 'uc_level') in ('school','city-community','state','regional','national','international'))
       and (private.import_absent(v -> 'uc_criteria') or private.import_text_ok(v -> 'uc_criteria', 2000))
       and (private.import_absent(v -> 'uc_earned') or private.import_text_ok(v -> 'uc_earned', 2000));
  end if;
  return false;
end;
$$;
revoke all on function private.import_value_ok_raw(text, jsonb) from public, anon;

-- ---------------------------------------------------------------------------
-- The value the database holds now. Copied from 20261014000003; NEW: gpa_band
-- and the profiles target. Blank text reads as empty for both: a client can
-- write '' to these columns, and '' is not an answer.
-- ---------------------------------------------------------------------------

create or replace function private.import_current_value(p_target text, p_field text, p_student uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.student_academics;
  d public.student_personal_details;
  p public.profiles;
begin
  if p_target = 'student_academics' then
    select * into a from public.student_academics where student_id = p_student;
    if not found then return null; end if;
    return case p_field
      when 'gpa_unweighted'   then to_jsonb(a.gpa_unweighted)
      when 'gpa_weighted'     then to_jsonb(a.gpa_weighted)
      when 'gpa_scale'        then to_jsonb(a.gpa_scale)
      when 'gpa_band'         then to_jsonb(nullif(btrim(a.gpa_band), ''))
      when 'class_rank'       then to_jsonb(a.class_rank)
      when 'class_rank_value' then to_jsonb(a.class_rank_value)
      when 'test_status'      then to_jsonb(a.test_status)
      when 'sat_ebrw'         then to_jsonb(a.sat_ebrw)
      when 'sat_math'         then to_jsonb(a.sat_math)
      when 'sat_superscore'   then to_jsonb(a.sat_superscore)
      when 'act_composite'    then to_jsonb(a.act_composite)
    end;
  elsif p_target = 'student_personal_details' then
    select * into d from public.student_personal_details where student_id = p_student;
    if not found then return null; end if;
    return case p_field
      when 'contact_email'   then to_jsonb(d.contact_email)
      when 'address'         then to_jsonb(d.address)
      when 'gender'          then to_jsonb(d.gender)
      when 'birthday'        then to_jsonb(d.birthday)
      when 'citizenship'     then to_jsonb(d.citizenship)
      when 'first_gen'       then to_jsonb(d.first_gen)
      when 'intended_majors' then case when cardinality(d.intended_majors) = 0 then null
                                       else to_jsonb(d.intended_majors) end
    end;
  elsif p_target = 'profiles' then
    select * into p from public.profiles where id = p_student;
    if not found then return null; end if;
    return case p_field
      when 'high_school' then to_jsonb(nullif(btrim(p.high_school), ''))
      when 'hometown'    then to_jsonb(nullif(btrim(p.hometown), ''))
      when 'grad_year'   then to_jsonb(nullif(btrim(p.grad_year), ''))
    end;
  end if;
  raise exception 'Not a single-row import target: %', p_target using errcode = '22023';
end;
$$;
revoke all on function private.import_current_value(text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- One compare-and-set per field. Copied from 20261014000004; NEW: gpa_band and
-- the profiles target (the row always exists, so no insert first). The
-- comparison for those reads blank as empty, matching import_current_value.
-- ---------------------------------------------------------------------------

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
      when 'gpa_band' then
        update public.student_academics set gpa_band = v #>> '{}'
         where student_id = p_student and nullif(btrim(gpa_band), '') is not distinct from e #>> '{}';
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
  elsif p_target = 'profiles' then
    case p_field
      when 'high_school' then
        update public.profiles set high_school = v #>> '{}'
         where id = p_student and nullif(btrim(high_school), '') is not distinct from e #>> '{}';
      when 'hometown' then
        update public.profiles set hometown = v #>> '{}'
         where id = p_student and nullif(btrim(hometown), '') is not distinct from e #>> '{}';
      when 'grad_year' then
        update public.profiles set grad_year = v #>> '{}'
         where id = p_student and nullif(btrim(grad_year), '') is not distinct from e #>> '{}';
      else
        raise exception 'Not an importable field: profiles.%', p_field using errcode = '22023';
    end case;
  else
    raise exception 'Not a single-row import target: %', p_target using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke all on function private.import_set_field(text, text, uuid, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Inserting a row. The body of 20261014000004's import_insert_row, now taking
-- the source ('import' or 'intake'). NEW: awards; timing, continuing and
-- uc_description on activities; sort_order at the end of the student's sheet
-- for activities and awards. Apply-time dedupe stays exact-only.
-- ---------------------------------------------------------------------------

create or replace function private.import_insert_row(p_target text, p_student uuid, p_row jsonb, p_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_source is null or p_source not in ('import','intake') then
    raise exception 'Not an import source: %', p_source using errcode = '22023';
  end if;
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
            (p_row ->> 'taken_on')::date, p_source)
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
            p_row ->> 'status', p_row ->> 'school_year', p_source)
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
                                   hours_per_week, weeks_per_year, description, grade_levels,
                                   timing, continuing, uc_description, source, sort_order)
    values (p_student, p_row ->> 'name', p_row ->> 'position', p_row ->> 'organization', p_row ->> 'category',
            (p_row ->> 'hours_per_week')::numeric, (p_row ->> 'weeks_per_year')::integer,
            p_row ->> 'description', private.import_text_array(p_row -> 'grade_levels'),
            private.import_text_array(p_row -> 'timing'), (p_row ->> 'continuing')::boolean,
            p_row ->> 'uc_description', p_source,
            (select coalesce(max(x.sort_order), -1) + 1 from public.activities x where x.student_id = p_student))
    returning id into v_id;
  elsif p_target = 'awards' then
    if exists (
      select 1 from public.awards w
      where w.student_id = p_student
        and lower(btrim(coalesce(w.name, ''))) = lower(btrim(coalesce(p_row ->> 'name', '')))
        and nullif(btrim(w.year), '') is not distinct from nullif(btrim(p_row ->> 'year'), '')
    ) then
      return null;
    end if;
    insert into public.awards (student_id, name, level, year, grade_levels, recognition_levels,
                               uc_level, uc_criteria, uc_earned, source, sort_order)
    values (p_student, p_row ->> 'name', p_row ->> 'level', p_row ->> 'year',
            private.import_text_array(p_row -> 'grade_levels'),
            private.import_text_array(p_row -> 'recognition_levels'),
            p_row ->> 'uc_level', p_row ->> 'uc_criteria', p_row ->> 'uc_earned', p_source,
            (select coalesce(max(x.sort_order), -1) + 1 from public.awards x where x.student_id = p_student))
    returning id into v_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  return v_id;
end;
$$;
revoke all on function private.import_insert_row(text, uuid, jsonb, text) from public, anon, authenticated;

-- The import's own entry point, unchanged for commit_import, apply_held_item
-- and every test: an imported row says source = 'import'.
create or replace function private.import_insert_row(p_target text, p_student uuid, p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.import_insert_row(p_target, p_student, p_row, 'import');
end;
$$;
revoke all on function private.import_insert_row(text, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Snapshot and delete: NEW awards branches. The other branches are copied
-- unchanged (undo compares against snapshots stored at commit).
-- ---------------------------------------------------------------------------

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
  elsif p_target = 'awards' then
    select jsonb_build_object('name', name, 'level', level, 'year', year, 'grade_levels', grade_levels,
                              'recognition_levels', recognition_levels, 'uc_level', uc_level,
                              'uc_criteria', uc_criteria, 'uc_earned', uc_earned)
      into v from public.awards where id = p_row_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function private.import_row_snapshot(text, uuid) from public, anon, authenticated;

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
  elsif p_target = 'awards' then
    delete from public.awards where id = p_row_id;
  else
    raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke all on function private.import_delete_row(text, uuid) from public, anon, authenticated;
