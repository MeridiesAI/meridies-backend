-- Import pipeline, step 2: the functions the import worker runs (register a
-- file, store the parse plan, read the roster for matching, stage) and the
-- helpers staging and review share (equality, risk, duplicates, counts).
-- Spec §5.1-§5.6. All SECURITY DEFINER with an empty search_path and
-- qualified names; no dynamic SQL.
--
-- Worker functions take p_actor (the counselor whose request this is) and
-- re-check private.can_manage_import themselves; EXECUTE goes to
-- import_worker and service_role only. Only an import started by
-- start_import (permission_confirmed_at set) is a new-pipeline import; the
-- old roster flow's rows never reach these functions.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Lock a new-pipeline import the actor may manage, in one of these statuses.
create or replace function private.import_v2_lock(p_import uuid, p_actor uuid, p_statuses text[])
returns public.roster_imports
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
begin
  if p_actor is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_manage_import(p_import, p_actor) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import for update;
  if not found or v.permission_confirmed_at is null then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  if not (v.status = any (p_statuses)) then
    raise exception '%', case v.status
        when 'staging' then 'This import is being matched. Try again in a moment.'
        when 'committing' then 'That import is already being saved'
        when 'undoing' then 'That import is being undone'
        when 'expired' then 'This import has expired. Start a new one.'
        else 'That can''t be done at this step of the import' end
      using errcode = '55000';
  end if;
  return v;
end;
$$;

-- May this import write this student, for this actor? The student must be on
-- the uploader's own caseload (spec §2, §5.6: matching is scoped to the
-- import's counselor, never to an admin's wider reach), and the actor must
-- be allowed to write them.
create or replace function private.import_student_allowed(p_import uuid, p_student uuid, p_counselor uuid, p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_student is not null
     and exists (select 1 from public.profiles s where s.id = p_student and s.role = 'student')
     and private.can_edit_student(p_student, p_counselor)
     and private.import_can_write_student(p_import, p_student, p_actor);
$$;

-- Equal for the purpose of "is this a change": numbers by value (3.8 = 3.800),
-- strings ignoring surrounding space, everything else as JSON.
create or replace function private.import_values_equal(a jsonb, b jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when private.import_absent(a) and private.import_absent(b) then true
    when private.import_absent(a) or private.import_absent(b) then false
    when jsonb_typeof(a) = 'number' and jsonb_typeof(b) = 'number'
      then (a #>> '{}')::numeric = (b #>> '{}')::numeric
    when jsonb_typeof(a) = 'string' and jsonb_typeof(b) = 'string'
      then btrim(a #>> '{}') = btrim(b #>> '{}')
    else a = b
  end;
$$;

-- Risk (§5.6) = sensitivity x old-value source x change size x match confidence.
-- Size: a fill is 1; numbers |delta| / range; a changed date 1; text 1 minus
-- trigram similarity (no new extension); anything else 1.
create or replace function private.import_risk(
  p_sensitivity smallint, p_old_source text, p_value_type text, p_old jsonb, p_new jsonb, p_confidence text
)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_size numeric := 1;
  v_o numeric;
  v_n numeric;
  v_range numeric;
begin
  if not private.import_absent(p_old) and not private.import_absent(p_new) then
    if p_value_type in ('gpa','sat_total','sat_section','act_composite')
       and jsonb_typeof(p_old) = 'number' and jsonb_typeof(p_new) = 'number' then
      v_o := (p_old #>> '{}')::numeric;
      v_n := (p_new #>> '{}')::numeric;
      v_range := case p_value_type
        when 'sat_total' then 1200
        when 'sat_section' then 600
        when 'act_composite' then 35
        else case when greatest(v_o, v_n) <= 5 then 4 when greatest(v_o, v_n) <= 10 then 10 else 110 end
      end;
      v_size := least(1, greatest(0.05, abs(v_n - v_o) / v_range));
    elsif p_value_type = 'date' then
      v_size := 1;
    elsif jsonb_typeof(p_old) = 'string' and jsonb_typeof(p_new) = 'string' then
      v_size := least(1, greatest(0.05, 1 - extensions.similarity(lower(p_old #>> '{}'), lower(p_new #>> '{}'))));
    end if;
  end if;
  return round(
    coalesce(p_sensitivity, 1)
    * case p_old_source when 'student' then 3 when 'counselor' then 2 when 'intake' then 2 else 1 end
    * v_size
    * case p_confidence when 'low' then 3 when 'medium' then 2 else 1 end,
    3);
end;
$$;

-- Is this row already on the student's record (§4.3)? 'present' (the same
-- keys import_insert_row refuses), 'similar' (shown as a possible duplicate,
-- never dropped or added silently), or null.
create or replace function private.import_row_presence(p_target text, p_student uuid, p_row jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      return 'present';
    end if;
    return null;
  elsif p_target = 'courses' then
    if exists (
      select 1 from public.courses c
      where c.student_id = p_student
        and lower(btrim(c.name)) = lower(btrim(p_row ->> 'name'))
        and c.school_year is not null and p_row ->> 'school_year' is not null
        and c.school_year = p_row ->> 'school_year'
    ) then
      return 'present';
    end if;
    if exists (
      select 1 from public.courses c
      where c.student_id = p_student
        and lower(btrim(c.name)) = lower(btrim(p_row ->> 'name'))
        and (c.school_year is null or p_row ->> 'school_year' is null)
    ) then
      return 'similar';
    end if;
    return null;
  elsif p_target = 'activities' then
    if exists (
      select 1 from public.activities a
      where a.student_id = p_student
        and lower(btrim(coalesce(a.name, ''))) = lower(btrim(coalesce(p_row ->> 'name', '')))
        and a.position is not distinct from (p_row ->> 'position')
        and a.organization is not distinct from (p_row ->> 'organization')
        and a.grade_levels is not distinct from private.import_text_array(p_row -> 'grade_levels')
    ) then
      return 'present';
    end if;
    if exists (
      select 1 from public.activities a
      where a.student_id = p_student
        and regexp_replace(lower(coalesce(a.name, '')), '[^a-z0-9]+', '', 'g')
          = regexp_replace(lower(coalesce(p_row ->> 'name', '')), '[^a-z0-9]+', '', 'g')
    ) then
      return 'similar';
    end if;
    return null;
  end if;
  raise exception 'Not a multi-row import target: %', p_target using errcode = '22023';
end;
$$;

-- Review counts (counts only; the stored stats keep staging's own counters).
create or replace function private.import_stats(p_import uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select jsonb_build_object(
       'items',     count(*),
       'matched',   count(*) filter (where match_status in ('matched_email','confirmed')),
       'suggested', count(*) filter (where match_status = 'suggested'),
       'toInvite',  count(*) filter (where match_status = 'new_invite'),
       'skipped',   count(*) filter (where match_status = 'skipped'))
     from public.import_items where import_id = p_import)
    ||
    (select jsonb_build_object(
       'changes',   count(*) filter (where ch.state = 'staged' and ch.decision in ('auto','accept')
                                       and it.match_status in ('matched_email','confirmed')),
       'autoFills', count(*) filter (where ch.state = 'staged' and ch.decision = 'auto'
                                       and it.match_status in ('matched_email','confirmed')),
       'keepOld',   count(*) filter (where ch.state = 'staged' and ch.decision = 'keep_old'
                                       and it.match_status in ('matched_email','confirmed')),
       'rejected',  count(*) filter (where ch.state = 'staged' and ch.decision = 'reject'
                                       and it.match_status in ('matched_email','confirmed')),
       'conflicts', count(*) filter (where ch.state = 'staged' and 'conflict_in_file' = any (ch.flags)
                                       and it.match_status not in ('skipped','expired')),
       'problems',  count(*) filter (where ch.state = 'skipped_invalid'
                                       and it.match_status not in ('skipped','expired')),
       'possibleDuplicates', count(*) filter (where ch.state = 'staged' and 'possible_duplicate' = any (ch.flags)
                                       and it.match_status not in ('skipped','expired')),
       'students',  count(distinct it.student_id) filter (where ch.state = 'staged' and ch.decision in ('auto','accept')
                                       and it.match_status in ('matched_email','confirmed')))
     from public.import_changes ch
     join public.import_items it on it.id = ch.item_id
     where ch.import_id = p_import);
$$;

-- Old value, duplicate rows, source, default decision and risk for the staged
-- changes of matched items (all of them, or one just confirmed). Set-based so
-- 5,000 rows stage inside the statement timeout. Returns how many rows were
-- already on the record and so were dropped.
create or replace function private.import_assess(p_import uuid, p_item uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  v_present integer := 0;
begin
  select * into v from public.roster_imports where id = p_import;

  -- 1. What each field holds now (§5.6: staging reads old_value this way so the
  --    compare-and-set at commit matches what the database holds).
  update public.import_changes ch
     set old_value = private.import_current_value(ch.target_table, ch.field, it.student_id)
    from public.import_items it
   where it.id = ch.item_id and ch.import_id = p_import and (p_item is null or it.id = p_item)
     and it.match_status in ('matched_email','confirmed')
     and ch.op = 'set_field' and ch.state = 'staged';

  -- 2. A value equal to what is there is not a change. A value in conflict
  --    with another row stays, so the counselor still picks.
  delete from public.import_changes ch
   using public.import_items it
   where it.id = ch.item_id and ch.import_id = p_import and (p_item is null or it.id = p_item)
     and it.match_status in ('matched_email','confirmed')
     and ch.op = 'set_field' and ch.state = 'staged'
     and not ('conflict_in_file' = any (ch.flags))
     and private.import_values_equal(ch.old_value, ch.new_value);

  -- 3. Rows already on the record are dropped and counted; a near match is
  --    kept back and flagged for the counselor (§4.3).
  with p as (
    select ch.id, private.import_row_presence(ch.target_table, it.student_id, ch.new_value) as presence
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    where ch.import_id = p_import and (p_item is null or it.id = p_item)
      and it.match_status in ('matched_email','confirmed')
      and ch.op = 'insert_row' and ch.state = 'staged'
  ), gone as (
    delete from public.import_changes ch using p
     where p.id = ch.id and p.presence = 'present'
    returning 1
  ), near as (
    update public.import_changes ch
       set flags = array_append(array_remove(ch.flags, 'possible_duplicate'), 'possible_duplicate')
      from p
     where p.id = ch.id and p.presence = 'similar'
    returning 1
  )
  select count(*) into v_present from gone;

  -- 4. Source, default decision (§5.6 table) and risk.
  with a as (
    select ch.id, ch.op, ch.flags, ch.old_value, ch.new_value, it.match_status, it.match_confidence,
           f.sensitivity, f.value_type,
           case when ch.op = 'set_field' and not private.import_absent(ch.old_value)
                then public.import_field_provenance(it.student_id, ch.target_table, ch.field) end as prov
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    join public.import_fields f on f.target_table = ch.target_table and f.field = ch.field
    where ch.import_id = p_import and (p_item is null or it.id = p_item)
      and it.match_status in ('matched_email','confirmed')
      and ch.state = 'staged'
  ), b as (
    select a.*,
           case when a.op = 'insert_row' or private.import_absent(a.old_value) then 'empty'
                when coalesce((a.prov ->> 'matchesCurrent')::boolean, false) then 'import'
                -- Nothing says who typed it; the safest reading (plan decision).
                else 'student' end as src,
           coalesce((a.prov ->> 'matchesCurrent')::boolean, false)
             and ((v.source_system <> 'unknown' and a.prov ->> 'sourceSystem' = v.source_system)
                  or (v.template_id is not null and a.prov ->> 'templateId' = v.template_id::text)) as same_source
    from a
  )
  update public.import_changes ch
     set old_source = case when b.op = 'insert_row' then null else b.src end,
         decision = case
           when 'conflict_in_file' = any (b.flags) or 'possible_duplicate' = any (b.flags) then 'keep_old'
           when b.op = 'insert_row' or b.src = 'empty' then
             case when b.match_status = 'matched_email' and b.match_confidence = 'high' then 'auto' else 'accept' end
           when b.same_source then 'accept'
           else 'keep_old' end,
         risk = private.import_risk(b.sensitivity, b.src, b.value_type, b.old_value, b.new_value, b.match_confidence)
    from b
   where b.id = ch.id;

  return v_present;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker: files
-- ---------------------------------------------------------------------------

-- Record a file the backend downloaded, checked (size, magic bytes, sha256)
-- and profiled. The import stays in 'draft' so further uploads still pass the
-- bucket's insert policy; POST /imports/:id/plan moves it on.
create or replace function public.import_register_file(p_import uuid, p_actor uuid, p_file jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  v_id uuid := (p_file ->> 'id')::uuid;
  v_path text := p_file ->> 'storagePath';
  v_status text := p_file ->> 'status';
  v_error text := left(p_file ->> 'error', 500);
  v_sha text := p_file ->> 'sha256';
  v_row public.import_files;
  v_types text[];
begin
  v := private.import_v2_lock(p_import, p_actor, array['draft']);
  if v_id is null or v_path is null then
    raise exception 'A file id and path are required' using errcode = '22023';
  end if;
  if v_status not in ('profiled','failed') then
    raise exception 'Unknown file status' using errcode = '22023';
  end if;
  -- Only the uploader's own folder for this import (the bucket's insert
  -- policy put it there), and only an object that exists.
  if left(v_path, length(v.counselor_id::text || '/' || p_import::text || '/' || v_id::text || '-'))
       <> v.counselor_id::text || '/' || p_import::text || '/' || v_id::text || '-' then
    raise exception 'That file isn''t part of this import' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'imports' and o.name = v_path) then
    raise exception 'That file hasn''t finished uploading' using errcode = 'P0002';
  end if;

  select * into v_row from public.import_files where id = v_id;
  if found then
    if v_row.import_id <> p_import then
      raise exception 'That file isn''t part of this import' using errcode = '42501';
    end if;
    -- Registering twice is harmless: the first answer stands.
    return to_jsonb(v_row) - 'profile' - 'counselor_id';
  end if;

  if (select count(*) from public.import_files where import_id = p_import and status <> 'excluded') >= 20 then
    raise exception 'An import holds at most 20 files' using errcode = '55000';
  end if;
  if v_status = 'profiled' and v_sha is not null and exists (
    select 1 from public.import_files
    where import_id = p_import and sha256 = v_sha and status = 'profiled'
  ) then
    v_status := 'failed';
    v_error := 'This file is already in the import';
  end if;
  if v_status = 'profiled'
     and coalesce((select sum(row_count) from public.import_files where import_id = p_import and status = 'profiled'), 0)
         + coalesce((p_file ->> 'rowCount')::integer, 0) > 5000 then
    v_status := 'failed';
    v_error := 'This would take the import over 5,000 rows';
  end if;

  insert into public.import_files (id, import_id, counselor_id, storage_path, filename, mime_type, detected_type,
                                   size_bytes, sha256, kind, status, error, profile, row_count)
  values (v_id, p_import, v.counselor_id, v_path, left(coalesce(nullif(btrim(p_file ->> 'filename'), ''), 'file'), 300),
          left(p_file ->> 'mimeType', 200),
          case when p_file ->> 'detectedType' in ('csv','xlsx','pdf','unknown') then p_file ->> 'detectedType' else 'unknown' end,
          (p_file ->> 'sizeBytes')::bigint, v_sha, 'sheet', v_status, v_error,
          case when v_status = 'profiled' then p_file -> 'profile' end,
          case when v_status = 'profiled' then (p_file ->> 'rowCount')::integer end)
  returning * into v_row;

  select array_agg(distinct detected_type) into v_types
  from public.import_files where import_id = p_import and status = 'profiled';
  update public.roster_imports
     set filename = coalesce((select f.filename from public.import_files f
                               where f.import_id = p_import and f.status = 'profiled'
                               order by f.created_at limit 1), filename),
         source = case when v_types is null then source
                       when cardinality(v_types) > 1 then 'mixed'
                       when v_types[1] = 'xlsx' then 'xlsx' else 'csv' end
   where id = p_import;

  return to_jsonb(v_row) - 'profile' - 'counselor_id';
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker: the parse plan and templates
-- ---------------------------------------------------------------------------

-- Store the confirmed plan (validated in lib/imports/plan.ts). From review it
-- throws away what was staged: a new mapping means matching again.
create or replace function public.import_set_plan(
  p_import uuid, p_actor uuid, p_plan jsonb, p_source_system text, p_template uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  v_template uuid;
begin
  v := private.import_v2_lock(p_import, p_actor, array['draft','mapping','review']);
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' or pg_column_size(p_plan) > 262144 then
    raise exception 'That mapping isn''t valid' using errcode = '22023';
  end if;
  if p_source_system not in ('naviance','scoir','cialfo','hubspot','collegeplannerpro',
                             'counselmore','gradbetter','other','unknown') then
    raise exception 'Unknown source system' using errcode = '22023';
  end if;
  if v.status = 'draft' and not exists (
    select 1 from public.import_files where import_id = p_import and status = 'profiled'
  ) then
    raise exception 'Add a file that can be read first' using errcode = '55000';
  end if;
  if p_template is not null then
    select id into v_template from public.import_templates where id = p_template and counselor_id = p_actor;
  end if;
  if v.status = 'review' then
    delete from public.import_items where import_id = p_import;
  end if;
  update public.roster_imports
     set status = 'mapping', plan = p_plan, source_system = p_source_system,
         template_id = coalesce(v_template, case when v.status = 'draft' then null else template_id end),
         stats = null, staged_at = null, job_error = null
   where id = p_import;
  if v_template is not null then
    update public.import_templates set use_count = use_count + 1, last_used_at = now() where id = v_template;
  end if;
end;
$$;

-- "Remember this layout": one template per counselor and header fingerprint.
-- No import id, so the approval gate is asked here directly.
create or replace function public.import_save_template(
  p_actor uuid, p_name text, p_source_system text, p_fingerprint text, p_plan jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_actor is null or not private.is_counselor(p_actor) then
    raise exception 'Only an approved counselor can save a layout' using errcode = '42501';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' or pg_column_size(p_plan) > 131072 then
    raise exception 'That layout isn''t valid' using errcode = '22023';
  end if;
  if (select count(*) from public.import_templates where counselor_id = p_actor) >= 200
     and not exists (select 1 from public.import_templates where counselor_id = p_actor and fingerprint = p_fingerprint) then
    raise exception 'You have 200 saved layouts. Delete one first.' using errcode = '55000';
  end if;
  insert into public.import_templates (counselor_id, name, source_system, fingerprint, parse_plan, use_count, last_used_at)
  values (p_actor, left(btrim(p_name), 200), p_source_system, p_fingerprint, p_plan, 1, now())
  on conflict (counselor_id, fingerprint) do update
     set name = excluded.name, source_system = excluded.source_system, parse_plan = excluded.parse_plan,
         use_count = public.import_templates.use_count + 1, last_used_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

-- AI spend for this import, in cents (§5.3: capped per import by the API).
create or replace function public.import_add_ai_spend(p_import uuid, p_actor uuid, p_cents integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  perform private.import_v2_lock(p_import, p_actor, array['draft','mapping','review']);
  update public.roster_imports
     set ai_spend_cents = least(ai_spend_cents + greatest(coalesce(p_cents, 0), 0), 1000000)
   where id = p_import
  returning ai_spend_cents into v_total;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker: matching and staging
-- ---------------------------------------------------------------------------

-- The students this import may match: the uploader's own caseload (their
-- students and write collaborations), intersected with what the actor may
-- write. Never anyone else's, so an upload can't learn who has an account.
create or replace function public.import_roster_for_matching(p_import uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
begin
  if p_actor is null or not private.can_manage_import(p_import, p_actor) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import;
  if v.permission_confirmed_at is null then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id,
             'name', s.full_name,
             'email', lower(s.email),
             'gradYear', s.grad_year,
             'highSchool', s.high_school,
             'birthday', d.birthday,
             'archived', s.archived_at is not null)), '[]'::jsonb)
    from public.profiles s
    left join public.student_personal_details d on d.student_id = s.id
    where s.role = 'student'
      and (s.counselor_id = v.counselor_id
           or exists (select 1 from public.student_collaborators c
                      where c.student_id = s.id and c.counselor_id = v.counselor_id and c.access = 'write'))
      and private.import_student_allowed(p_import, s.id, v.counselor_id, p_actor)
  );
end;
$$;

-- mapping -> staging. A double click gets "already being matched".
create or replace function public.import_begin_staging(p_import uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
begin
  v := private.import_v2_lock(p_import, p_actor, array['mapping']);
  if v.plan is null then
    raise exception 'Map the columns first' using errcode = '55000';
  end if;
  update public.roster_imports
     set status = 'staging', job_actor = p_actor, job_requested_at = now(), job_error = null
   where id = p_import;
end;
$$;

-- staging -> mapping with the reason, when staging fails in the API.
create or replace function public.import_abort_staging(p_import uuid, p_actor uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor is null or not private.can_manage_import(p_import, p_actor) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  update public.roster_imports
     set status = 'mapping', job_error = jsonb_build_object('message', left(coalesce(p_message, 'Matching didn''t finish. Try again.'), 300))
   where id = p_import and status = 'staging' and permission_confirmed_at is not null;
end;
$$;

-- Write the matched items and their changes (§5.4-§5.6). The API decided the
-- match; this re-checks every student against the uploader's roster, keeps one
-- invitation per address, then reads old values and sets the defaults.
-- payload: { items: [{ key, file_id, locator, imported_name, match_status,
--   confidence, reasons, student_id, candidates: [{ id, why }], match_key,
--   skip_reason, flags }], changes: [{ item, target, field, op, value,
--   source_ref, source_column, pattern_key, flags, alternatives, invalid }],
--   counts: { rows, blocked } }
create or replace function public.stage_import(p_import uuid, p_actor uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  v_present integer;
  v_stats jsonb;
begin
  v := private.import_v2_lock(p_import, p_actor, array['staging']);
  if v.job_actor is distinct from p_actor then
    raise exception 'This import is being matched by someone else' using errcode = '55000';
  end if;
  if jsonb_typeof(p_payload -> 'items') <> 'array' or jsonb_typeof(p_payload -> 'changes') <> 'array' then
    raise exception 'Nothing to stage' using errcode = '22023';
  end if;
  if jsonb_array_length(p_payload -> 'items') > 5000 or jsonb_array_length(p_payload -> 'changes') > 200000 then
    raise exception 'An import holds at most 5,000 rows' using errcode = '22023';
  end if;

  delete from public.import_items where import_id = p_import;

  insert into public.import_items (import_id, file_id, locator, match_status, match_confidence, match_reasons,
                                   student_id, imported_name, match_key, candidates, skip_reason, flags)
  select p_import,
         (select f.id from public.import_files f where f.id = x.file_id and f.import_id = p_import),
         jsonb_build_object('key', x.key) || coalesce(x.locator - 'key', '{}'::jsonb),
         case when x.match_status in ('matched_email','suggested','new_invite','skipped')
                   and not (x.match_status = 'matched_email' and x.student_id is null)
              then x.match_status else 'skipped' end,
         case when x.confidence in ('high','medium','low') then x.confidence end,
         coalesce(x.reasons[1:10], '{}'),
         case when x.match_status = 'matched_email' then x.student_id end,
         left(x.imported_name, 200),
         coalesce(x.match_key, '{}'::jsonb),
         coalesce((select jsonb_agg(c) from (
                     select c from jsonb_array_elements(coalesce(x.candidates, '[]'::jsonb)) c limit 5) q), '[]'::jsonb),
         left(case when x.match_status = 'matched_email' and x.student_id is null then 'No match on your roster'
                   else x.skip_reason end, 300),
         coalesce(x.flags[1:10], '{}')
  from jsonb_to_recordset(p_payload -> 'items') as x(
    key text, file_id uuid, locator jsonb, imported_name text, match_status text, confidence text,
    reasons text[], student_id uuid, candidates jsonb, match_key jsonb, skip_reason text, flags text[]);

  if (select count(*) from public.import_items where import_id = p_import)
     <> (select count(distinct locator ->> 'key') from public.import_items where import_id = p_import) then
    raise exception 'Item keys must be unique' using errcode = '22023';
  end if;

  -- Every student is re-checked against the uploader's roster.
  update public.import_items it
     set candidates = coalesce((
           select jsonb_agg(jsonb_build_object('id', (c ->> 'id')::uuid, 'why', left(c ->> 'why', 200)))
           from jsonb_array_elements(it.candidates) c
           where private.import_student_allowed(p_import, (c ->> 'id')::uuid, v.counselor_id, p_actor)), '[]'::jsonb)
   where it.import_id = p_import and jsonb_array_length(it.candidates) > 0;

  update public.import_items
     set match_status = 'skipped', student_id = null, match_confidence = null,
         skip_reason = 'This student isn''t on your roster'
   where import_id = p_import and match_status = 'matched_email'
     and not private.import_student_allowed(p_import, student_id, v.counselor_id, p_actor);

  update public.import_items
     set match_status = 'skipped', skip_reason = 'No match on your roster'
   where import_id = p_import and match_status = 'suggested' and jsonb_array_length(candidates) = 0;

  update public.import_items
     set match_status = 'skipped', skip_reason = 'No email to invite'
   where import_id = p_import and match_status = 'new_invite'
     and coalesce(match_key ->> 'email', '') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$';

  -- One invitation per address in an import: siblings on a parent's email
  -- must not both be invited to it (spec §1: no path delivers one student's
  -- data to another account).
  with ranked as (
    select id, row_number() over (partition by lower(match_key ->> 'email') order by created_at, id) as rn
    from public.import_items
    where import_id = p_import and match_status = 'new_invite'
  )
  update public.import_items it
     set match_status = 'skipped', skip_reason = 'Shares an email with another student in this file',
         flags = array_append(array_remove(it.flags, 'shared_email'), 'shared_email')
    from ranked
   where ranked.id = it.id and ranked.rn > 1;

  -- One item per student.
  with ranked as (
    select id, row_number() over (partition by student_id order by created_at, id) as rn
    from public.import_items
    where import_id = p_import and match_status = 'matched_email'
  )
  update public.import_items it
     set match_status = 'skipped', student_id = null, match_confidence = null,
         skip_reason = 'Another row is already matched to this student'
    from ranked
   where ranked.id = it.id and ranked.rn > 1;

  insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, decision, state,
                                     source_ref, source_column, pattern_key, flags, alternatives, error, risk)
  select p_import, it.id, c.target, c.field, c.op,
         c.value,
         case when coalesce(c.invalid, false) then 'keep_old' else 'accept' end,
         case when coalesce(c.invalid, false) then 'skipped_invalid' else 'staged' end,
         left(c.source_ref, 200), left(c.source_column, 200), left(c.pattern_key, 200),
         coalesce(c.flags[1:10], '{}'),
         case when jsonb_typeof(c.alternatives) = 'array' then c.alternatives end,
         case when coalesce(c.invalid, false) then 'Needs a fix' end,
         private.import_risk(f.sensitivity, 'empty', f.value_type, null, c.value, it.match_confidence)
  from jsonb_to_recordset(p_payload -> 'changes') as c(
    item text, target text, field text, op text, value jsonb, source_ref text, source_column text,
    pattern_key text, flags text[], alternatives jsonb, invalid boolean)
  join public.import_items it on it.import_id = p_import and it.locator ->> 'key' = c.item
  join public.import_fields f on f.target_table = c.target and f.field = c.field
  where it.match_status in ('matched_email','suggested','new_invite')
     or (it.match_status = 'skipped' and 'shared_email' = any (it.flags));

  v_present := private.import_assess(p_import, null);

  v_stats := private.import_stats(p_import) || jsonb_build_object(
    'rows', greatest(coalesce((p_payload #>> '{counts,rows}')::integer, 0), 0),
    'blocked', greatest(coalesce((p_payload #>> '{counts,blocked}')::integer, 0), 0),
    'alreadyPresent', v_present);

  update public.roster_imports
     set status = 'review', staged_at = now(), stats = v_stats, job_error = null
   where id = p_import;
  return v_stats;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: helpers are private to definer code; worker functions to the worker.
-- ---------------------------------------------------------------------------

revoke all on function private.import_v2_lock(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function private.import_student_allowed(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.import_values_equal(jsonb, jsonb) from public, anon;
revoke all on function private.import_risk(smallint, text, text, jsonb, jsonb, text) from public, anon;
revoke all on function private.import_row_presence(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.import_stats(uuid) from public, anon, authenticated;
revoke all on function private.import_assess(uuid, uuid) from public, anon, authenticated;

revoke all on function public.import_register_file(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.import_set_plan(uuid, uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.import_save_template(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.import_add_ai_spend(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.import_roster_for_matching(uuid, uuid) from public, anon, authenticated;
revoke all on function public.import_begin_staging(uuid, uuid) from public, anon, authenticated;
revoke all on function public.import_abort_staging(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.stage_import(uuid, uuid, jsonb) from public, anon, authenticated;

grant execute on function public.import_register_file(uuid, uuid, jsonb) to import_worker, service_role;
grant execute on function public.import_set_plan(uuid, uuid, jsonb, text, uuid) to import_worker, service_role;
grant execute on function public.import_save_template(uuid, text, text, text, jsonb) to import_worker, service_role;
grant execute on function public.import_add_ai_spend(uuid, uuid, integer) to import_worker, service_role;
grant execute on function public.import_roster_for_matching(uuid, uuid) to import_worker, service_role;
grant execute on function public.import_begin_staging(uuid, uuid) to import_worker, service_role;
grant execute on function public.import_abort_staging(uuid, uuid, text) to import_worker, service_role;
grant execute on function public.stage_import(uuid, uuid, jsonb) to import_worker, service_role;
