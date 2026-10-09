-- Import pipeline, step 1: what a valid imported value is (spec §4.2), the
-- value the database holds now (staging reads old_value with this), the
-- fingerprint (§5.10) and the pre-commit validation pass (§5.7 step 3).

create or replace function private.import_num(v jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when v is not null and jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric end;
$$;

create or replace function private.import_str(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when v is not null and jsonb_typeof(v) = 'string' then v #>> '{}' end;
$$;

create or replace function private.import_is_date(p text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  perform p::date;
  return true;
exception when others then
  return false;
end;
$$;

-- A JSON value that is absent or JSON null.
create or replace function private.import_absent(v jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select v is null or jsonb_typeof(v) = 'null';
$$;

create or replace function private.import_text_ok(v jsonb, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select private.import_str(v) is not null
     and length(btrim(private.import_str(v))) between 1 and p_max;
$$;

create or replace function private.import_value_ok(p_type text, v jsonb)
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
    if exists (select 1 from jsonb_object_keys(v) k where k not in
               ('name','position','organization','category','hours_per_week','weeks_per_year','description','grade_levels')) then
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
       and (private.import_absent(v -> 'grade_levels') or private.import_value_ok('text[]', v -> 'grade_levels'));
  end if;
  return false;
end;
$$;

create or replace function private.import_value_hash(v jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(v, 'null'::jsonb)::text, 'UTF8')), 'hex');
$$;

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
begin
  if p_target = 'student_academics' then
    select * into a from public.student_academics where student_id = p_student;
    if not found then return null; end if;
    return case p_field
      when 'gpa_unweighted'   then to_jsonb(a.gpa_unweighted)
      when 'gpa_weighted'     then to_jsonb(a.gpa_weighted)
      when 'gpa_scale'        then to_jsonb(a.gpa_scale)
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
  end if;
  raise exception 'Not a single-row import target: %', p_target using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- Every staged value is checked against import_fields.value_type on write.
-- A cell waiting for cleanup is stored as 'skipped_invalid' and not checked.
-- ---------------------------------------------------------------------------

create or replace function private.import_changes_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_type text;
begin
  if new.new_value is null or new.state = 'skipped_invalid' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.new_value is not distinct from old.new_value
     and new.state is not distinct from old.state then
    return new;
  end if;
  select f.value_type into v_type
  from public.import_fields f
  where f.target_table = new.target_table and f.field = new.field;
  if v_type is null or not private.import_value_ok(v_type, new.new_value) then
    raise exception 'Imported value for %.% is not valid', new.target_table, new.field
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists import_changes_validate on public.import_changes;
create trigger import_changes_validate before insert or update of new_value, state on public.import_changes
  for each row execute function private.import_changes_validate();

-- ---------------------------------------------------------------------------
-- The validation pass (§5.7 step 3): every problem, reported once.
-- ---------------------------------------------------------------------------

create or replace function private.import_validate(p_import uuid, p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c record;
  v_type text;
  v_scale text;
  v_problems jsonb := '[]'::jsonb;
  v_gpa numeric;
  v_date date;
begin
  for c in
    select ch.*, it.student_id as item_student
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    where ch.import_id = p_import
      and ch.state = 'staged'
      and ch.decision in ('auto','accept')
      and (
        (p_item is null and it.match_status in ('matched_email','confirmed'))
        or (p_item is not null and it.id = p_item and it.match_status = 'applying')
      )
    order by ch.created_at
  loop
    select f.value_type into v_type from public.import_fields f
    where f.target_table = c.target_table and f.field = c.field;

    if v_type is null or not private.import_value_ok(v_type, c.new_value) then
      v_problems := v_problems || jsonb_build_object(
        'changeId', c.id, 'sourceRef', c.source_ref,
        'message', format('%s isn''t a valid value for %s', coalesce(c.new_value #>> '{}', 'This'), c.field));
      continue;
    end if;

    if c.target_table = 'student_academics' and c.field in ('gpa_weighted','gpa_unweighted') then
      v_gpa := private.import_num(c.new_value);
      -- The scale in effect after this import: an accepted scale change on the
      -- same item, else what the record holds now.
      select private.import_str(s.new_value) into v_scale
      from public.import_changes s
      where s.item_id = c.item_id and s.field = 'gpa_scale' and s.target_table = 'student_academics'
        and s.state = 'staged' and s.decision in ('auto','accept')
      limit 1;
      if v_scale is null then
        v_scale := private.import_str(private.import_current_value('student_academics', 'gpa_scale', c.item_student));
      end if;
      if v_gpa > 10 and coalesce(v_scale, '') !~ '^\s*100' then
        v_problems := v_problems || jsonb_build_object(
          'changeId', c.id, 'sourceRef', c.source_ref,
          'message', format('GPA %s needs a 100-point scale. Set the GPA scale to 100 or fix the value.', v_gpa));
      end if;
    end if;

    if c.target_table = 'student_personal_details' and c.field = 'birthday' then
      v_date := private.import_str(c.new_value)::date;
      if v_date < date '1980-01-01' or v_date > date '2030-12-31' then
        v_problems := v_problems || jsonb_build_object(
          'changeId', c.id, 'sourceRef', c.source_ref,
          'message', format('Birthday %s is outside 1980–2030', v_date));
      end if;
    end if;
  end loop;
  return v_problems;
end;
$$;

revoke all on function private.import_num(jsonb) from public, anon;
revoke all on function private.import_str(jsonb) from public, anon;
revoke all on function private.import_is_date(text) from public, anon;
revoke all on function private.import_absent(jsonb) from public, anon;
revoke all on function private.import_text_ok(jsonb, integer) from public, anon;
revoke all on function private.import_value_ok(text, jsonb) from public, anon;
revoke all on function private.import_value_hash(jsonb) from public, anon;
revoke all on function private.import_current_value(text, text, uuid) from public, anon, authenticated;
revoke all on function private.import_validate(uuid, uuid) from public, anon, authenticated;
revoke all on function private.import_changes_validate() from public, anon, authenticated;
