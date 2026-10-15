-- Questionnaire sync, 2 of 4: the onboarding questionnaire fills the record.
--
-- The student's answers arrive as profiles.profile.intakeAnswers (PATCH
-- /auth/me from the app's onboarding page). Until now nothing read them. A
-- trigger on that column now copies each answer that has a real field into
-- it, through the import pipeline's own functions (20261023010001):
-- import_value_ok checks the value, import_current_value reads what is
-- stored, import_set_field writes one field with a compare-and-set, and
-- import_insert_row adds a sheet row with source = 'intake'.
--
-- The rules, all decided here so no route can forget them:
--  - Fill only what is empty. A value anyone else entered (the counselor, an
--    import, the student on another screen) is never overwritten.
--  - A re-saved questionnaire may change a value only while it is still
--    exactly what the questionnaire itself last wrote: intake_fills keeps the
--    hash of that value (import_value_hash, as import provenance does), and
--    the compare-and-set runs against the value read. Once someone else edits
--    it, or clears it, the questionnaire never touches it again. A cleared
--    value stays cleared.
--  - Grouped fields move together or not at all: the GPA with its scale, the
--    SAT sections with the total, the class rank with its value. A student's
--    GPA is never written under a counselor's scale that doesn't match it.
--  - A sheet row (activity, honor, AP/IB score, advanced course) is matched
--    by its natural key. Added once; updated while unchanged; removed only
--    while unchanged and gone from the answers; never brought back after
--    someone else deleted it.
--  - The save never fails because of this. Each group runs in its own
--    subtransaction; a failing group is reported (field names and SQLSTATE,
--    never a value) and the rest still run.
--  - Citizenship and financial-need answers are never copied anywhere: they
--    stay only in profiles.profile.intakeAnswers, which no AI feature reads.
--    student_personal_details.citizenship is on the AI allowlist
--    (src/lib/context/ai-allowlist.ts), so the questionnaire does not fill it.

-- ---------------------------------------------------------------------------
-- What the questionnaire wrote
-- ---------------------------------------------------------------------------

create table if not exists public.intake_fills (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  target_table text not null,
  field        text not null,
  -- Sheet rows: the row written (it may have been deleted since) and the hash
  -- of its natural key.
  row_id       uuid,
  row_key      text check (row_key ~ '^[0-9a-f]{64}$'),
  -- import_value_hash of what the questionnaire last left in place (the hash
  -- of null after it cleared its own value). Never the value itself.
  value_hash   text not null check (value_hash ~ '^[0-9a-f]{64}$'),
  run          text not null check (run in ('save','backfill')),
  filled_at    timestamptz not null default now(),
  constraint intake_fills_field_fk foreign key (target_table, field)
    references public.import_fields (target_table, field),
  constraint intake_fills_row_shape check ((field = '*') = (row_key is not null and row_id is not null))
);
create unique index if not exists intake_fills_field_once
  on public.intake_fills (student_id, target_table, field) where field <> '*';
create unique index if not exists intake_fills_row_once
  on public.intake_fills (student_id, target_table, row_key) where field = '*';

alter table public.intake_fills enable row level security;
revoke all on table public.intake_fills from anon, authenticated;
grant select on table public.intake_fills to authenticated;
drop policy if exists intake_fills_select on public.intake_fills;
create policy intake_fills_select on public.intake_fills
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));
select private.attach_approval_gate('public.intake_fills');

comment on table public.intake_fills is
  'What the onboarding questionnaire wrote, one row per field or sheet row, as a hash. Written only by private.sync_intake_answers. Lets a re-saved questionnaire update only its own unchanged values, keeps a cleared or deleted value from coming back, and tells the counselor what came from the questionnaire. Not on the AI allowlist.';

-- ---------------------------------------------------------------------------
-- Small readers over the answers (strings only; anything else is unanswered)
-- ---------------------------------------------------------------------------

create or replace function private.intake_str(a jsonb, k text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(a) = 'object' and jsonb_typeof(a -> k) = 'string'
              then nullif(btrim(regexp_replace(a ->> k, '\s+', ' ', 'g')), '') end;
$$;

-- Trimmed and cut to the sheet's limit, so a long answer is shortened rather
-- than refused.
create or replace function private.intake_text(a jsonb, k text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(rtrim(left(private.intake_str(a, k), p_max)), '');
$$;

create or replace function private.intake_int(s text, lo integer, hi integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when s ~ '^\d{1,4}$' and s::integer between lo and hi then s::integer end;
$$;

-- Equal as stored values: numbers by value (3.86 and 3.860), the rest as JSON.
create or replace function private.intake_same(x jsonb, y jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when x is null or y is null then x is null and y is null
    when jsonb_typeof(x) = 'number' and jsonb_typeof(y) = 'number' then (x #>> '{}')::numeric = (y #>> '{}')::numeric
    else x = y end;
$$;

-- The sheet's activity types (ACTIVITY_TYPES in src/lib/profileUpdates.ts;
-- test/unit/intake-sync.test.ts keeps the two lists equal). The questionnaire
-- offers the Common App's full list, so a type is matched ignoring case and
-- punctuation, a few wordings are read as the sheet's, and anything else is
-- 'Other Club/Activity'.
create or replace function private.intake_activity_type(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  with v(norm) as (select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]+', '', 'g'))),
  types(t) as (
    select unnest(array[ -- ACTIVITY_TYPES begin
      'Academic', 'Art', 'Athletics: Club', 'Athletics: JV/Varsity', 'Career-Oriented',
      'Community Service (Volunteer)', 'Computer/Technology', 'Cultural', 'Dance', 'Debate/Speech',
      'Environmental', 'Family Responsibilities', 'Foreign Exchange', 'Journalism/Publication',
      'Junior R.O.T.C.', 'LGBT', 'Music: Instrumental', 'Music: Vocal', 'Religious', 'Research',
      'Robotics', 'School Spirit', 'Science/Math', 'Student Govt./Politics', 'Theater/Drama',
      'Work (paid)', 'Other Club/Activity'
    ]) -- ACTIVITY_TYPES end
  ),
  aliases(a, t) as (values
    ('communityservice', 'Community Service (Volunteer)'),
    ('volunteer', 'Community Service (Volunteer)'),
    ('jrotc', 'Junior R.O.T.C.'),
    ('juniorrotc', 'Junior R.O.T.C.'),
    ('studentgovernment', 'Student Govt./Politics'),
    ('studentgovernmentpolitics', 'Student Govt./Politics'),
    ('theatredrama', 'Theater/Drama'),
    ('work', 'Work (paid)'),
    ('paidwork', 'Work (paid)'),
    ('other', 'Other Club/Activity')
  )
  select case when (select norm from v) = '' then null else coalesce(
    (select t from types where lower(regexp_replace(t, '[^A-Za-z0-9]+', '', 'g')) = (select norm from v) limit 1),
    (select t from aliases where a = (select norm from v)),
    'Other Club/Activity') end;
$$;

-- The GPA range as the questionnaire labels it, plus the type and scale, so
-- the band reads on its own: '3.7–3.99 unweighted', 'Below 2.5 unweighted',
-- '4.5+ weighted (5.0 scale)'. Null for an option it doesn't know, and for a
-- weighted range on a scale it can't belong to (100-point, unknown).
create or replace function private.intake_gpa_band(p_type text, p_band text, p_scale text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_type = 'unweighted' then
      case p_band
        when '4.0'       then '4.0'
        when '3.7-3.99'  then '3.7–3.99'
        when '3.3-3.69'  then '3.3–3.69'
        when '3.0-3.29'  then '3.0–3.29'
        when '2.5-2.99'  then '2.5–2.99'
        when 'below-2.5' then 'Below 2.5'
      end || ' unweighted'
    when p_type = 'weighted' and p_scale in ('5.0','6.0') then
      case p_band
        when '4.5+'      then '4.5+'
        when '4.2-4.49'  then '4.2–4.49'
        when '4.0-4.19'  then '4.0–4.19'
        when '3.7-3.99'  then '3.7–3.99'
        when '3.3-3.69'  then '3.3–3.69'
        when 'below-3.3' then 'Below 3.3'
      end || ' weighted (' || p_scale || ' scale)'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Report helpers. The report holds field names and reasons, never values.
-- ---------------------------------------------------------------------------

create or replace function private.intake_report()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('done', '[]'::jsonb, 'skipped', '[]'::jsonb);
$$;

create or replace function private.intake_done(g jsonb, p_field text, p_action text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(g, '{done}', (g -> 'done') || jsonb_build_array(jsonb_build_object('field', p_field, 'action', p_action)));
$$;

create or replace function private.intake_skip(g jsonb, p_field text, p_reason text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(g, '{skipped}', (g -> 'skipped') || jsonb_build_array(jsonb_build_object('field', p_field, 'reason', p_reason)));
$$;

create or replace function private.intake_merge(g jsonb, h jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('done', (g -> 'done') || (h -> 'done'), 'skipped', (g -> 'skipped') || (h -> 'skipped'));
$$;

-- ---------------------------------------------------------------------------
-- One field
-- ---------------------------------------------------------------------------

-- Whose value is in the field now, read against what the questionnaire last
-- wrote: 'empty' (nothing, and the questionnaire never wrote here), 'ours'
-- (exactly what the questionnaire left, including an empty it left), 'other'
-- (someone else's value), 'edited' (the questionnaire's value, changed since)
-- or 'cleared' (the questionnaire's value, cleared since).
create or replace function private.intake_field_state(p_student uuid, p_target text, p_field text, p_cur jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h text;
begin
  select f.value_hash into h from public.intake_fills f
   where f.student_id = p_student and f.target_table = p_target and f.field = p_field;
  if not found then
    return case when p_cur is null then 'empty' else 'other' end;
  end if;
  if h = private.import_value_hash(p_cur) then
    return 'ours';
  end if;
  return case when p_cur is null then 'cleared' else 'edited' end;
end;
$$;

create or replace function private.intake_skip_reason(p_state text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_state when 'other' then 'already_set' when 'edited' then 'edited_since'
                      when 'cleared' then 'cleared_since' else p_state end;
$$;

-- Make one field say p_value (null: say nothing), if the rules allow.
-- Raises on a database error; the caller decides what one failure undoes.
create or replace function private.intake_put(
  p_student uuid, p_target text, p_field text, p_value jsonb, p_run text, p_g jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_value jsonb := case when private.import_absent(p_value) then null else p_value end;
  v_cur jsonb;
  v_state text;
  v_name text := p_target || '.' || p_field;
  g jsonb := p_g;
begin
  select f.value_type into v_type from public.import_fields f
   where f.target_table = p_target and f.field = p_field and f.field <> '*';
  if v_type is null then
    raise exception 'Not a questionnaire field: %', v_name using errcode = '22023';
  end if;
  if v_value is not null and not private.import_value_ok(v_type, v_value) then
    return private.intake_skip(g, v_name, 'invalid');
  end if;

  v_cur := private.import_current_value(p_target, p_field, p_student);
  v_state := private.intake_field_state(p_student, p_target, p_field, v_cur);

  if v_value is null then
    -- The answer is gone (or its branch is closed): take back only our own value.
    if v_state = 'ours' and v_cur is not null
       and private.import_set_field(p_target, p_field, p_student, v_cur, null) then
      update public.intake_fills
         set value_hash = private.import_value_hash(null), run = p_run, filled_at = now()
       where student_id = p_student and target_table = p_target and field = p_field;
      g := private.intake_done(g, v_name, 'cleared');
    end if;
    return g;
  end if;

  if v_state not in ('empty','ours') then
    return private.intake_skip(g, v_name, private.intake_skip_reason(v_state));
  end if;
  if private.intake_same(v_cur, v_value) then
    return g;
  end if;
  if not private.import_set_field(p_target, p_field, p_student, v_cur, v_value) then
    -- Someone wrote it between the read and the write: theirs.
    return private.intake_skip(g, v_name, 'already_set');
  end if;

  insert into public.intake_fills (student_id, target_table, field, value_hash, run)
  values (p_student, p_target, p_field,
          private.import_value_hash(private.import_current_value(p_target, p_field, p_student)), p_run)
  on conflict (student_id, target_table, field) where field <> '*'
  do update set value_hash = excluded.value_hash, run = excluded.run, filled_at = now();

  return private.intake_done(g, v_name, case when v_cur is null then 'filled' else 'updated' end);
end;
$$;

-- The same, as its own subtransaction: one field that fails is reported and
-- nothing else is undone.
create or replace function private.intake_put_alone(
  p_student uuid, p_target text, p_field text, p_value jsonb, p_run text, p_g jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    return private.intake_put(p_student, p_target, p_field, p_value, p_run, p_g);
  exception when others then
    return private.intake_skip(p_g, p_target || '.' || p_field, 'error:' || sqlstate);
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sheet rows
-- ---------------------------------------------------------------------------

-- Every column a person can edit on the row (not sort_order: reordering a row
-- is not editing it). "Unchanged since" compares this, by hash.
create or replace function private.intake_row_snapshot(p_target text, p_row_id uuid)
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
                              'category', category, 'grade_levels', grade_levels, 'timing', timing,
                              'hours_per_week', hours_per_week, 'weeks_per_year', weeks_per_year,
                              'continuing', continuing, 'description', description,
                              'uc_description', uc_description, 'uc_category', uc_category,
                              'uc_org_description', uc_org_description)
      into v from public.activities where id = p_row_id;
  elsif p_target = 'awards' then
    select jsonb_build_object('name', name, 'level', level, 'year', year, 'grade_levels', grade_levels,
                              'recognition_levels', recognition_levels, 'uc_type', uc_type,
                              'uc_level', uc_level, 'uc_criteria', uc_criteria, 'uc_earned', uc_earned)
      into v from public.awards where id = p_row_id;
  else
    raise exception 'Not a questionnaire row target: %', p_target using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Rewrite the columns the questionnaire owns on one of its own rows. Fixed
-- statements per target, the same casts as import_insert_row. True when
-- something changed.
create or replace function private.intake_update_row(p_target text, p_row_id uuid, p_row jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
begin
  if p_target = 'test_scores' then
    update public.test_scores
       set exam = p_row ->> 'exam', kind = p_row ->> 'kind', score = p_row ->> 'score'
     where id = p_row_id
       and (exam, kind, score) is distinct from (p_row ->> 'exam', p_row ->> 'kind', p_row ->> 'score');
  elsif p_target = 'courses' then
    update public.courses
       set name = p_row ->> 'name', type = p_row ->> 'type', status = p_row ->> 'status'
     where id = p_row_id
       and (name, type, status) is distinct from (p_row ->> 'name', p_row ->> 'type', p_row ->> 'status');
  elsif p_target = 'activities' then
    update public.activities
       set name = p_row ->> 'name', position = p_row ->> 'position', organization = p_row ->> 'organization',
           category = p_row ->> 'category', grade_levels = private.import_text_array(p_row -> 'grade_levels'),
           timing = private.import_text_array(p_row -> 'timing'),
           hours_per_week = (p_row ->> 'hours_per_week')::numeric,
           weeks_per_year = (p_row ->> 'weeks_per_year')::integer,
           continuing = (p_row ->> 'continuing')::boolean,
           description = p_row ->> 'description', uc_description = p_row ->> 'uc_description'
     where id = p_row_id
       and (name, position, organization, category, grade_levels, timing, hours_per_week, weeks_per_year,
            continuing, description, uc_description)
           is distinct from
           (p_row ->> 'name', p_row ->> 'position', p_row ->> 'organization', p_row ->> 'category',
            private.import_text_array(p_row -> 'grade_levels'), private.import_text_array(p_row -> 'timing'),
            (p_row ->> 'hours_per_week')::numeric, (p_row ->> 'weeks_per_year')::integer,
            (p_row ->> 'continuing')::boolean, p_row ->> 'description', p_row ->> 'uc_description');
  elsif p_target = 'awards' then
    update public.awards
       set name = p_row ->> 'name', level = p_row ->> 'level', year = p_row ->> 'year',
           grade_levels = private.import_text_array(p_row -> 'grade_levels'),
           recognition_levels = private.import_text_array(p_row -> 'recognition_levels'),
           uc_level = p_row ->> 'uc_level', uc_criteria = p_row ->> 'uc_criteria', uc_earned = p_row ->> 'uc_earned'
     where id = p_row_id
       and (name, level, year, grade_levels, recognition_levels, uc_level, uc_criteria, uc_earned)
           is distinct from
           (p_row ->> 'name', p_row ->> 'level', p_row ->> 'year',
            private.import_text_array(p_row -> 'grade_levels'),
            private.import_text_array(p_row -> 'recognition_levels'),
            p_row ->> 'uc_level', p_row ->> 'uc_criteria', p_row ->> 'uc_earned');
  else
    raise exception 'Not a questionnaire row target: %', p_target using errcode = '22023';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- Already on the record under its natural key, whoever added it. Looser than
-- import_insert_row's exact match, because the questionnaire has no dates.
create or replace function private.intake_on_record(p_student uuid, p_target text, p_row jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_target = 'test_scores' then
    return exists (select 1 from public.test_scores t where t.student_id = p_student
                     and t.kind = p_row ->> 'kind' and lower(btrim(t.exam)) = lower(btrim(p_row ->> 'exam')));
  elsif p_target = 'courses' then
    return exists (select 1 from public.courses c where c.student_id = p_student
                     and lower(btrim(c.name)) = lower(btrim(p_row ->> 'name')));
  elsif p_target = 'activities' then
    return exists (select 1 from public.activities x where x.student_id = p_student
                     and lower(btrim(coalesce(x.organization, x.name, '')))
                         = lower(btrim(coalesce(p_row ->> 'organization', p_row ->> 'name', '')))
                     and lower(btrim(coalesce(x.position, ''))) = lower(btrim(coalesce(p_row ->> 'position', ''))));
  elsif p_target = 'awards' then
    return exists (select 1 from public.awards w where w.student_id = p_student
                     and lower(btrim(coalesce(w.name, ''))) = lower(btrim(p_row ->> 'name'))
                     and lower(coalesce(nullif(btrim(w.year), ''), '')) = lower(coalesce(nullif(btrim(p_row ->> 'year'), ''), '')));
  end if;
  raise exception 'Not a questionnaire row target: %', p_target using errcode = '22023';
end;
$$;

-- Make one sheet say what the answers list. p_rows: [{key, row}], in the
-- questionnaire's order. Raises on a database error (the caller's block
-- undoes the whole sheet).
create or replace function private.intake_put_rows(
  p_student uuid, p_target text, p_rows jsonb, p_run text, p_g jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  g jsonb := p_g;
  r record;
  f public.intake_fills;
  v_keys text[] := '{}';
  v_key text;
  v_row jsonb;
  v_snap jsonb;
  v_id uuid;
begin
  select x.value_type into v_type from public.import_fields x where x.target_table = p_target and x.field = '*';
  if v_type is null then
    raise exception 'Not a questionnaire row target: %', p_target using errcode = '22023';
  end if;

  for r in select e, ord from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(e, ord) loop
    v_key := encode(sha256(convert_to(p_target || '|' || lower(r.e ->> 'key'), 'UTF8')), 'hex');
    v_row := r.e -> 'row';
    if v_key = any (v_keys) then
      g := private.intake_skip(g, p_target, 'duplicate');
      continue;
    end if;
    v_keys := v_keys || v_key;
    if not private.import_value_ok(v_type, v_row) then
      g := private.intake_skip(g, p_target, 'invalid');
      continue;
    end if;

    select * into f from public.intake_fills x
     where x.student_id = p_student and x.target_table = p_target and x.row_key = v_key;
    if found then
      v_snap := private.intake_row_snapshot(p_target, f.row_id);
      if v_snap is null then
        -- Someone deleted it: it stays deleted.
        g := private.intake_skip(g, p_target, 'removed_since');
      elsif private.import_value_hash(v_snap) <> f.value_hash then
        g := private.intake_skip(g, p_target, 'edited_since');
      elsif private.intake_update_row(p_target, f.row_id, v_row) then
        update public.intake_fills
           set value_hash = private.import_value_hash(private.intake_row_snapshot(p_target, f.row_id)),
               run = p_run, filled_at = now()
         where id = f.id;
        g := private.intake_done(g, p_target, 'updated');
      end if;
      continue;
    end if;

    if private.intake_on_record(p_student, p_target, v_row) then
      g := private.intake_skip(g, p_target, 'already_on_record');
      continue;
    end if;
    if p_target = 'activities' and (select count(*) from public.activities x where x.student_id = p_student) >= 30
       or p_target = 'awards' and (select count(*) from public.awards x where x.student_id = p_student) >= 30 then
      g := private.intake_skip(g, p_target, 'sheet_full');
      continue;
    end if;
    v_id := private.import_insert_row(p_target, p_student, v_row, 'intake');
    if v_id is null then
      g := private.intake_skip(g, p_target, 'already_on_record');
      continue;
    end if;
    insert into public.intake_fills (student_id, target_table, field, row_id, row_key, value_hash, run)
    values (p_student, p_target, '*', v_id, v_key,
            private.import_value_hash(private.intake_row_snapshot(p_target, v_id)), p_run);
    g := private.intake_done(g, p_target, 'added');
  end loop;

  -- Rows the answers no longer list: take back only our own unchanged ones.
  for f in select * from public.intake_fills x
            where x.student_id = p_student and x.target_table = p_target and x.field = '*'
              and not (x.row_key = any (v_keys)) loop
    v_snap := private.intake_row_snapshot(p_target, f.row_id);
    if v_snap is not null and private.import_value_hash(v_snap) = f.value_hash
       and private.import_delete_row(p_target, f.row_id) then
      delete from public.intake_fills where id = f.id;
      g := private.intake_done(g, p_target, 'removed');
    end if;
  end loop;
  return g;
end;
$$;

-- ---------------------------------------------------------------------------
-- High school: link the catalog row when exactly one school has that name
-- (the rule matchHighSchool in src/lib/studentPage.ts uses), and only when
-- the link is empty or is the one the questionnaire's previous answer made.
-- ---------------------------------------------------------------------------

create or replace function private.intake_school_match(p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 1 then (array_agg(h.id))[1] end
  from (select id from public.high_schools
         where p_name is not null and lower(name) = lower(btrim(p_name)) limit 2) h;
$$;

create or replace function private.intake_link_high_school(p_student uuid, p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur uuid;
begin
  select high_school_id into v_cur from public.profiles where id = p_student;
  if v_cur is null or (p_old is not null and v_cur = private.intake_school_match(p_old)) then
    update public.profiles set high_school_id = private.intake_school_match(p_new)
     where id = p_student and high_school_id is not distinct from v_cur;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The mapping
-- ---------------------------------------------------------------------------

create or replace function private.sync_intake_answers(p_student uuid, p_answers jsonb, p_actor uuid, p_run text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a jsonb := p_answers;
  v_out jsonb := private.intake_report();
  g jsonb;
  -- shared
  v_uc boolean;
  v_award_count integer;
  v_rigor boolean;
  v_ts text;
  -- GPA
  v_type text; v_scale text; v_max numeric; v_exact_s text; v_exact numeric; v_band_s text; v_band text;
  v_col text; v_other text;
  d_u jsonb; d_w jsonb; d_s jsonb;
  c_s jsonb; c_u jsonb; c_w jsonb; st_s text; st_u text; st_w text; st_col text;
  -- SAT / rank
  v_raw text; d_e jsonb; d_m jsonb; d_t jsonb; d_rank jsonb; d_val jsonb;
  st_a text; st_b text; st_c text; v_leave text[];
  -- rows
  v_rows jsonb; e jsonb; v_name text; v_org text; v_pos text; v_cat text; v_exam text; v_kind text;
  v_score text; v_level text; v_year text; v_hours text;
  -- school
  v_old_school text;
  v_changed integer;
begin
  if p_run is null or p_run not in ('save','backfill') then
    raise exception 'Unknown questionnaire run %', p_run using errcode = '22023';
  end if;
  if jsonb_typeof(a) is distinct from 'object' then
    return v_out;
  end if;
  -- Students only, not archived. The row lock serializes a save and the backfill.
  perform 1 from public.profiles p
   where p.id = p_student and p.role = 'student' and p.archived_at is null
   for update;
  if not found then
    return v_out;
  end if;

  v_award_count := private.intake_int(private.intake_str(a, 'awardCount'), 0, 1000);
  -- applyingUC is asked only once there is an award (the app's showIf).
  v_uc := coalesce(v_award_count >= 1, false) and private.intake_str(a, 'applyingUC') = 'yes';
  v_rigor := private.intake_str(a, 'rigorCount') is not null and private.intake_str(a, 'rigorCount') <> '0';
  v_ts := private.intake_str(a, 'testStatus');

  -- 1. High school (and its catalog link), hometown, class year ---------------
  begin
    g := private.intake_report();
    v_old_school := private.import_current_value('profiles', 'high_school', p_student) #>> '{}';
    g := private.intake_put(p_student, 'profiles', 'high_school',
                            to_jsonb(private.intake_text(a, 'highSchool', 200)), p_run, g);
    if jsonb_array_length(g -> 'done') > 0 then
      perform private.intake_link_high_school(p_student, v_old_school,
        private.import_current_value('profiles', 'high_school', p_student) #>> '{}');
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'profiles.high_school', 'error:' || sqlstate);
  end;
  v_out := private.intake_put_alone(p_student, 'profiles', 'hometown',
                                    to_jsonb(private.intake_text(a, 'location', 200)), p_run, v_out);
  v_out := private.intake_put_alone(p_student, 'profiles', 'grad_year',
                                    to_jsonb(private.intake_str(a, 'gradYear')), p_run, v_out);

  -- 2. GPA: kept on its own scale, never converted, never invented ------------
  begin
    g := private.intake_report();
    v_type := private.intake_str(a, 'gpaType');
    if v_type not in ('unweighted','weighted') then v_type := null; end if;
    v_scale := case v_type
                 when 'unweighted' then '4.0'
                 when 'weighted' then case private.intake_str(a, 'gpaScale')
                                        when '5' then '5.0' when '6' then '6.0' when '100' then '100' end
               end;
    v_max := case v_scale when '4.0' then 4 when '5.0' then 5 when '6.0' then 6 when '100' then 110 end;
    v_col := case v_type when 'unweighted' then 'gpa_unweighted' when 'weighted' then 'gpa_weighted' end;
    v_exact_s := private.intake_str(a, 'gpaExact');
    v_band_s := private.intake_str(a, case v_type when 'unweighted' then 'gpaBandUnweighted'
                                                   when 'weighted' then 'gpaBandWeighted' end);
    v_exact := null;
    v_leave := '{}';
    if v_type is not null and v_scale is null and (v_exact_s is not null or v_band_s is not null) then
      -- 'Something else': a GPA without a scale can't be read safely.
      g := private.intake_skip(g, 'student_academics.gpa_scale', 'scale_unknown');
      v_leave := array['gpa'];
    elsif v_type is not null and v_exact_s is not null then
      if v_exact_s !~ '^\d{1,3}(\.\d{1,3})?$' then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'invalid');
        v_leave := array['gpa'];
      elsif v_exact_s::numeric <= 0 or v_exact_s::numeric > v_max then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'out_of_range');
        v_leave := array['gpa'];
      else
        v_exact := v_exact_s::numeric;
      end if;
    end if;
    d_u := case when v_type = 'unweighted' then to_jsonb(v_exact) end;
    d_w := case when v_type = 'weighted' then to_jsonb(v_exact) end;
    d_s := case when v_exact is not null then to_jsonb(v_scale) end;

    c_s := private.import_current_value('student_academics', 'gpa_scale', p_student);
    c_u := private.import_current_value('student_academics', 'gpa_unweighted', p_student);
    c_w := private.import_current_value('student_academics', 'gpa_weighted', p_student);
    st_s := private.intake_field_state(p_student, 'student_academics', 'gpa_scale', c_s);
    st_u := private.intake_field_state(p_student, 'student_academics', 'gpa_unweighted', c_u);
    st_w := private.intake_field_state(p_student, 'student_academics', 'gpa_weighted', c_w);

    if 'gpa' = any (v_leave) then
      null;  -- an unreadable answer leaves the GPA as it is
    elsif st_s in ('empty','ours') and st_u in ('empty','ours') and st_w in ('empty','ours') then
      -- The whole GPA is empty or the questionnaire's: make it say what the
      -- answers say. Stale columns go first; then the scale and the GPA in the
      -- order student_academics_gpa_range accepts (a 100 scale before a GPA
      -- above 10; a GPA before a move off the 100 scale).
      if d_u is null then g := private.intake_put(p_student, 'student_academics', 'gpa_unweighted', null, p_run, g); end if;
      if d_w is null then g := private.intake_put(p_student, 'student_academics', 'gpa_weighted', null, p_run, g); end if;
      if v_exact is null then
        g := private.intake_put(p_student, 'student_academics', 'gpa_scale', null, p_run, g);
      elsif v_scale = '100' then
        g := private.intake_put(p_student, 'student_academics', 'gpa_scale', d_s, p_run, g);
        g := private.intake_put(p_student, 'student_academics', v_col, to_jsonb(v_exact), p_run, g);
      else
        g := private.intake_put(p_student, 'student_academics', v_col, to_jsonb(v_exact), p_run, g);
        g := private.intake_put(p_student, 'student_academics', 'gpa_scale', d_s, p_run, g);
      end if;
    elsif v_exact is not null then
      -- Someone else wrote part of the GPA. Fill an empty (or still our own)
      -- column only on the same scale; never touch their scale or their GPA.
      st_col := case v_col when 'gpa_unweighted' then st_u else st_w end;
      v_other := case v_col when 'gpa_unweighted' then 'gpa_weighted' else 'gpa_unweighted' end;
      if st_col not in ('empty','ours') then
        g := private.intake_skip(g, 'student_academics.' || v_col, private.intake_skip_reason(st_col));
      elsif c_s is null then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'scale_conflict');
      elsif substring(c_s #>> '{}' from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric
            is distinct from substring(v_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric then
        g := private.intake_skip(g, 'student_academics.' || v_col, 'scale_conflict');
      else
        g := private.intake_put(p_student, 'student_academics', v_col, to_jsonb(v_exact), p_run, g);
      end if;
    end if;

    -- The range is its own field: text that names its type and scale.
    v_band := private.intake_gpa_band(v_type, v_band_s, v_scale);
    if v_band_s is not null and v_band is null and v_scale is not null and v_scale <> '100' then
      g := private.intake_skip(g, 'student_academics.gpa_band', 'invalid');
    elsif v_band is not null or v_band_s is null or v_scale is not null then
      g := private.intake_put(p_student, 'student_academics', 'gpa_band', to_jsonb(v_band), p_run, g);
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'student_academics.gpa', 'error:' || sqlstate);
  end;

  -- 3. Class rank and its value move together ---------------------------------
  begin
    g := private.intake_report();
    d_rank := null; d_val := null;
    case private.intake_str(a, 'classRank')
      when 'exact' then
        d_rank := to_jsonb(private.intake_text(a, 'classRankValue', 40));
        d_val := d_rank;
      when 'top-1' then d_rank := to_jsonb('Top 1%'::text);
      when 'top-5' then d_rank := to_jsonb('Top 5%'::text);
      when 'top-10' then d_rank := to_jsonb('Top 10%'::text);
      when 'top-25' then d_rank := to_jsonb('Top 25%'::text);
      when 'top-50' then d_rank := to_jsonb('Top 50%'::text);
      when 'none' then d_rank := to_jsonb('Not ranked'::text);
      else null;
    end case;
    st_a := private.intake_field_state(p_student, 'student_academics', 'class_rank',
              private.import_current_value('student_academics', 'class_rank', p_student));
    st_b := private.intake_field_state(p_student, 'student_academics', 'class_rank_value',
              private.import_current_value('student_academics', 'class_rank_value', p_student));
    if st_a in ('empty','ours') and st_b in ('empty','ours') then
      g := private.intake_put(p_student, 'student_academics', 'class_rank', d_rank, p_run, g);
      g := private.intake_put(p_student, 'student_academics', 'class_rank_value', d_val, p_run, g);
    elsif d_rank is not null then
      g := private.intake_skip(g, 'student_academics.class_rank',
                               private.intake_skip_reason(case when st_a in ('empty','ours') then st_b else st_a end));
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'student_academics.class_rank', 'error:' || sqlstate);
  end;

  -- 4. Testing status ---------------------------------------------------------
  v_out := private.intake_put_alone(p_student, 'student_academics', 'test_status',
    to_jsonb(case
      when v_ts in ('sat','act','both') then 'taken'
      when v_ts = 'optional' then 'test-optional'
      when v_ts = 'notyet' then case when private.intake_str(a, 'testPrepStatus') in ('self','course','diagnostic')
                                     then 'prepping' else 'not-started' end
    end), p_run, v_out);

  -- 5. SAT: the two sections and the total move together ----------------------
  begin
    g := private.intake_report();
    d_e := null; d_m := null; d_t := null; v_leave := '{}';
    if v_ts in ('sat','both') then
      v_raw := private.intake_str(a, 'satEbrw');
      d_e := to_jsonb(private.intake_int(v_raw, 200, 800));
      if v_raw is not null and d_e is null then v_leave := v_leave || 'sat_ebrw'::text;
        g := private.intake_skip(g, 'student_academics.sat_ebrw', 'invalid'); end if;
      v_raw := private.intake_str(a, 'satMath');
      d_m := to_jsonb(private.intake_int(v_raw, 200, 800));
      if v_raw is not null and d_m is null then v_leave := v_leave || 'sat_math'::text;
        g := private.intake_skip(g, 'student_academics.sat_math', 'invalid'); end if;
      v_raw := private.intake_str(a, 'satSuperscore');
      d_t := to_jsonb(private.intake_int(v_raw, 400, 1600));
      if v_raw is not null and d_t is null then v_leave := v_leave || 'sat_superscore'::text;
        g := private.intake_skip(g, 'student_academics.sat_superscore', 'invalid'); end if;
      -- Two sections and no total: that sitting's total is their sum.
      if d_t is null and v_raw is null and d_e is not null and d_m is not null then
        d_t := to_jsonb((d_e #>> '{}')::integer + (d_m #>> '{}')::integer);
      end if;
    end if;
    st_a := private.intake_field_state(p_student, 'student_academics', 'sat_ebrw',
              private.import_current_value('student_academics', 'sat_ebrw', p_student));
    st_b := private.intake_field_state(p_student, 'student_academics', 'sat_math',
              private.import_current_value('student_academics', 'sat_math', p_student));
    st_c := private.intake_field_state(p_student, 'student_academics', 'sat_superscore',
              private.import_current_value('student_academics', 'sat_superscore', p_student));
    if st_a in ('empty','ours') and st_b in ('empty','ours') and st_c in ('empty','ours') then
      if not ('sat_ebrw' = any (v_leave)) then
        g := private.intake_put(p_student, 'student_academics', 'sat_ebrw', d_e, p_run, g); end if;
      if not ('sat_math' = any (v_leave)) then
        g := private.intake_put(p_student, 'student_academics', 'sat_math', d_m, p_run, g); end if;
      if not ('sat_superscore' = any (v_leave)) then
        g := private.intake_put(p_student, 'student_academics', 'sat_superscore', d_t, p_run, g); end if;
    elsif d_e is not null or d_m is not null or d_t is not null then
      g := private.intake_skip(g, 'student_academics.sat', 'already_set');
    end if;
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'student_academics.sat', 'error:' || sqlstate);
  end;

  -- 6. ACT composite ------------------------------------------------------------
  v_raw := case when v_ts in ('act','both') then private.intake_str(a, 'actComposite') end;
  if v_raw is not null and private.intake_int(v_raw, 1, 36) is null then
    v_out := private.intake_skip(v_out, 'student_academics.act_composite', 'invalid');
  else
    v_out := private.intake_put_alone(p_student, 'student_academics', 'act_composite',
                                      to_jsonb(private.intake_int(v_raw, 1, 36)), p_run, v_out);
  end if;

  -- 7. First-generation -----------------------------------------------------------
  v_out := private.intake_put_alone(p_student, 'student_personal_details', 'first_gen',
    case private.intake_str(a, 'firstGen') when 'yes' then 'true'::jsonb when 'no' then 'false'::jsonb end,
    p_run, v_out);

  -- 8. Intended majors (asked when the student is certain or has narrowed it) --
  v_rows := null;
  if private.intake_str(a, 'majorCertainty') in ('certain','narrowed') and jsonb_typeof(a -> 'intendedMajors') = 'array' then
    select jsonb_agg(m order by first_ord) into v_rows from (
      select min(ord) as first_ord, (array_agg(t order by ord))[1] as m
      from (select nullif(rtrim(left(btrim(regexp_replace(x #>> '{}', '\s+', ' ', 'g')), 200)), '') as t, ord
              from jsonb_array_elements(a -> 'intendedMajors') with ordinality as y(x, ord)
             where jsonb_typeof(x) = 'string') z
      where t is not null
      group by lower(t)
      order by min(ord)
      limit 10) q;
  end if;
  v_out := private.intake_put_alone(p_student, 'student_personal_details', 'intended_majors', v_rows, p_run, v_out);

  -- 9. AP / IB scores (asked when the student reports advanced courses) -------
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if v_rigor and jsonb_typeof(a -> 'apScores') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'apScores') with ordinality as y(x, ord) where ord <= 15 order by ord loop
        v_exam := private.intake_text(e, 'exam', 200);
        continue when v_exam is null;
        v_kind := case when v_exam ~* '^\s*IB\M' then 'ib' else 'ap' end;
        -- The option is the AP score; its label reads "5 / 7", the IB score beside it.
        v_score := case private.intake_str(e, 'score')
                     when '5' then case v_kind when 'ib' then '7' else '5' end
                     when '4' then case v_kind when 'ib' then '6' else '4' end
                     when '3' then case v_kind when 'ib' then '5' else '3' end
                     when '2' then case v_kind when 'ib' then '4' else '2' end
                     when '1' then case v_kind when 'ib' then '3' else '1' end
                   end;
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', v_kind || '|' || v_exam,
          'row', jsonb_strip_nulls(jsonb_build_object('exam', v_exam, 'kind', v_kind, 'score', v_score))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'test_scores', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'test_scores', 'error:' || sqlstate);
  end;

  -- 10. Advanced courses. The questionnaire's "grade" is the grade level the
  -- course was taken in; courses.grade is the mark, so it is not copied.
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if v_rigor and jsonb_typeof(a -> 'advancedCourses') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'advancedCourses') with ordinality as y(x, ord) where ord <= 20 order by ord loop
        v_name := private.intake_text(e, 'name', 300);
        continue when v_name is null;
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', v_name,
          'row', jsonb_strip_nulls(jsonb_build_object(
            'name', v_name,
            'type', case private.intake_str(e, 'type')
                      when 'ap' then 'ap' when 'ib' then 'ib' when 'honors' then 'honors'
                      when 'de' then 'dual-enrollment' when 'other' then 'other' end,
            'status', case private.intake_str(e, 'status')
                        when 'completed' then 'completed' when 'inprogress' then 'in-progress'
                        when 'planned' then 'planned' end))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'courses', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'courses', 'error:' || sqlstate);
  end;

  -- 11. Honors (asked when the student counts at least one) -------------------
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if coalesce(v_award_count >= 1, false) and jsonb_typeof(a -> 'awards') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'awards') with ordinality as y(x, ord) where ord <= 25 order by ord loop
        v_name := private.intake_text(e, 'name', 100);
        continue when v_name is null;
        v_level := private.intake_str(e, 'level');
        v_year := private.intake_text(e, 'year', 20);
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', v_name || '|' || coalesce(v_year, ''),
          'row', jsonb_strip_nulls(jsonb_build_object(
            'name', v_name,
            'year', v_year,
            'level', case v_level when 'international' then 'International' when 'national' then 'National'
                                  when 'state' then 'State / Regional' when 'school' then 'School / Local' end,
            'recognition_levels', case v_level when 'international' then '["international"]'::jsonb
                                               when 'national' then '["national"]'::jsonb
                                               when 'state' then '["state-regional"]'::jsonb
                                               when 'school' then '["school"]'::jsonb end,
            'uc_level', case v_level when 'international' then 'international' when 'national' then 'national'
                                     when 'state' then 'state' when 'school' then 'school' end,
            'uc_criteria', case when v_uc then private.intake_text(e, 'ucCriteria', 250) end,
            'uc_earned', case when v_uc then private.intake_text(e, 'ucEarned', 350) end))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'awards', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'awards', 'error:' || sqlstate);
  end;

  -- 12. Activities. Blank rows the form opened in advance are skipped. The
  -- organization is the sheet's name for a row; without one the position or
  -- the type stands in.
  begin
    g := private.intake_report();
    v_rows := '[]'::jsonb;
    if jsonb_typeof(a -> 'activities') = 'array' then
      for e in select x from jsonb_array_elements(a -> 'activities') with ordinality as y(x, ord) where ord <= 20 order by ord loop
        v_org := private.intake_text(e, 'organization', 100);
        v_pos := private.intake_text(e, 'position', 50);
        v_cat := private.intake_activity_type(private.intake_str(e, 'category'));
        continue when v_org is null and v_pos is null and v_cat is null;
        v_hours := private.intake_str(e, 'hoursPerWeek');
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'key', coalesce(v_org, '') || '|' || coalesce(v_pos, '') || '|' || coalesce(v_cat, ''),
          'row', jsonb_strip_nulls(jsonb_build_object(
            'name', coalesce(v_org, v_pos, v_cat),
            'organization', v_org,
            'position', v_pos,
            'category', v_cat,
            'grade_levels', (select jsonb_agg(gl order by case gl when 'PG' then 13 else gl::integer end) from (
                               select distinct case when x #>> '{}' = 'pg' then 'PG' else x #>> '{}' end as gl
                               from jsonb_array_elements(case when jsonb_typeof(e -> 'gradeLevels') = 'array'
                                                              then e -> 'gradeLevels' else '[]'::jsonb end) x
                               where jsonb_typeof(x) = 'string' and x #>> '{}' in ('9','10','11','12','pg')) q),
            'timing', case when private.intake_str(e, 'timing') in ('school','break','year')
                           then jsonb_build_array(private.intake_str(e, 'timing')) end,
            'hours_per_week', case when v_hours ~ '^\d{1,3}(\.\d{1,2})?$' and v_hours::numeric <= 168
                                   then to_jsonb(v_hours::numeric) end,
            'weeks_per_year', to_jsonb(private.intake_int(private.intake_str(e, 'weeksPerYear'), 0, 52)),
            'continuing', case private.intake_str(e, 'continuing') when 'yes' then 'true'::jsonb
                                                                  when 'no' then 'false'::jsonb end,
            'description', private.intake_text(e, 'description', 150),
            'uc_description', case when v_uc then private.intake_text(e, 'ucDescription', 350) end))));
      end loop;
    end if;
    g := private.intake_put_rows(p_student, 'activities', v_rows, p_run, g);
    v_out := private.intake_merge(v_out, g);
  exception when others then
    v_out := private.intake_skip(v_out, 'activities', 'error:' || sqlstate);
  end;

  -- Background answers with no real field (the background note, country,
  -- English test, citizenship, aid need and types, FAFSA status) are not
  -- copied anywhere: they stay in profiles.profile.intakeAnswers only.

  -- The counselor's activity trail: which fields changed and why others were
  -- left alone. Names and reasons only.
  v_changed := jsonb_array_length(v_out -> 'done');
  if v_changed > 0 then
    insert into public.progress_events (student_id, entity_type, event, actor_id, metadata)
    values (p_student, 'intake', 'edited', p_actor, jsonb_build_object('questionnaire', jsonb_build_object(
      'run', p_run,
      'changed', v_changed,
      'fields', (select jsonb_agg(distinct d ->> 'field') from jsonb_array_elements(v_out -> 'done') d),
      'skipped', (select coalesce(jsonb_agg(s), '[]'::jsonb) from (
                    select s from jsonb_array_elements(v_out -> 'skipped') s limit 60) q))));
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- The trigger. It never fails the save.
-- ---------------------------------------------------------------------------

create or replace function private.profiles_fill_from_questionnaire()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.sync_intake_answers(new.id, new.profile -> 'intakeAnswers', (select auth.uid()), 'save');
  exception when others then
    raise warning 'questionnaire sync skipped for a profile (sqlstate %)', sqlstate;
  end;
  return new;
end;
$$;

drop trigger if exists profiles_fill_from_questionnaire on public.profiles;
create trigger profiles_fill_from_questionnaire
  after update of profile on public.profiles
  for each row
  when (old.profile -> 'intakeAnswers' is distinct from new.profile -> 'intakeAnswers')
  execute function private.profiles_fill_from_questionnaire();

-- ---------------------------------------------------------------------------
-- The read: what the questionnaire filled that is still as it left it.
-- ---------------------------------------------------------------------------

create or replace function public.intake_filled_fields(p_student uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_student is null or not private.can_view_student(p_student, (select auth.uid())) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'targetTable', f.target_table,
             'field', f.field,
             'rowId', f.row_id,
             'filledAt', f.filled_at,
             'matchesCurrent', m.ok)
           order by f.target_table, f.field, f.filled_at)
    from public.intake_fills f
    cross join lateral (
      select case
        when f.field = '*' then coalesce(
          private.import_value_hash(private.intake_row_snapshot(f.target_table, f.row_id)) = f.value_hash
          and private.intake_row_snapshot(f.target_table, f.row_id) is not null, false)
        else coalesce(
          private.import_current_value(f.target_table, f.field, p_student) is not null
          and private.import_value_hash(private.import_current_value(f.target_table, f.field, p_student)) = f.value_hash, false)
      end as ok) m
    where f.student_id = p_student
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.intake_filled_fields(uuid) from public, anon;
grant execute on function public.intake_filled_fields(uuid) to authenticated;

revoke all on function private.intake_str(jsonb, text) from public, anon, authenticated;
revoke all on function private.intake_text(jsonb, text, integer) from public, anon, authenticated;
revoke all on function private.intake_int(text, integer, integer) from public, anon, authenticated;
revoke all on function private.intake_same(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.intake_activity_type(text) from public, anon, authenticated;
revoke all on function private.intake_gpa_band(text, text, text) from public, anon, authenticated;
revoke all on function private.intake_report() from public, anon, authenticated;
revoke all on function private.intake_done(jsonb, text, text) from public, anon, authenticated;
revoke all on function private.intake_skip(jsonb, text, text) from public, anon, authenticated;
revoke all on function private.intake_merge(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.intake_field_state(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.intake_skip_reason(text) from public, anon, authenticated;
revoke all on function private.intake_put(uuid, text, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function private.intake_put_alone(uuid, text, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function private.intake_row_snapshot(text, uuid) from public, anon, authenticated;
revoke all on function private.intake_update_row(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.intake_on_record(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.intake_put_rows(uuid, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function private.intake_school_match(text) from public, anon, authenticated;
revoke all on function private.intake_link_high_school(uuid, text, text) from public, anon, authenticated;
revoke all on function private.sync_intake_answers(uuid, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function private.profiles_fill_from_questionnaire() from public, anon, authenticated;
