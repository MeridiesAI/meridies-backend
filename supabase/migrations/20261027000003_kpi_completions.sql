-- Time saved, step 3: completions are recorded and undone by triggers on the
-- source tables, so every path (the app, AxIS, PostgREST, a job) counts the same.
-- Spec: docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
--
-- Every figure is snapshotted when the completion happens. A month in
-- kpi_months is locked: nothing is added to it or removed from it. A ledger
-- failure never blocks the user's save (each trigger traps its own errors).
--
-- Deploy order: after 20261027000001. Either order with the code. Not in
-- REQUIRED_SCHEMA.

-- The consultant's month for a moment, in their own time zone (UTC when unset or unknown).
create or replace function private.kpi_month_of(p_counselor uuid, p_at timestamptz)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select date_trunc('month', p_at at time zone coalesce(
    (select tz.name from public.profiles p join pg_timezone_names tz on tz.name = p.timezone where p.id = p_counselor),
    'UTC'))::date
$$;

-- Who is credited: the signed-in approved counselor, else the row's own counselor.
create or replace function private.kpi_actor(p_fallback uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when auth.uid() is not null and private.is_counselor(auth.uid()) then auth.uid() else p_fallback end
$$;

create or replace function private.kpi_default_manual(p_type text) returns integer
language sql immutable as $$
  select case p_type when 'college_list' then 240 when 'essay_feedback' then 45 when 'meeting' then 45
                     when 'family_report' then 60 when 'activity_list' then 90 end
$$;
create or replace function private.kpi_default_meridies(p_type text) returns integer
language sql immutable as $$
  select case p_type when 'college_list' then 30 when 'essay_feedback' then 15 when 'meeting' then 15
                     when 'family_report' then 10 when 'activity_list' then 20 end
$$;

-- Minutes in Meridies and how they were decided:
--   5+ measured completions of the type: cap at 3× their median; no time → the median.
--   fewer: measured time as is; no time → the signup figure.
create or replace function private.kpi_measure(p_counselor uuid, p_type text, p_seconds integer, p_signup integer,
                                               out minutes numeric, out method text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_n      integer;
  v_median numeric;
  v_mins   numeric := p_seconds / 60.0;
begin
  select count(*), percentile_cont(0.5) within group (order by measured_seconds / 60.0)
    into v_n, v_median
  from public.kpi_completions
  where counselor_id = p_counselor and task_type = p_type and measure_method in ('active','capped') and measured_seconds > 0;

  if v_n >= 5 then
    if p_seconds > 0 then
      if v_mins > 3 * v_median then minutes := round(3 * v_median, 2); method := 'capped';
      else minutes := round(v_mins, 2); method := 'active'; end if;
    else
      minutes := round(v_median, 2); method := 'median';
    end if;
  elsif p_seconds > 0 then
    minutes := round(v_mins, 2); method := 'active';
  else
    minutes := p_signup; method := 'signup';
  end if;
end;
$$;

-- Record one completion (or add a source and its time to the existing one).
create or replace function private.kpi_record_at(
  p_counselor uuid, p_type text, p_subject uuid, p_student uuid, p_dedupe text,
  p_source_table text, p_source_id uuid, p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month    date;
  v_key      text;
  v_secs     integer := 0;
  v_existing public.kpi_completions%rowtype;
  b          public.kpi_baselines%rowtype;
  v_manual   integer;
  v_signup   integer;
  v_measure  record;
  v_id       uuid;
begin
  if p_counselor is null or not private.is_counselor(p_counselor) then
    return;
  end if;
  v_month := private.kpi_month_of(p_counselor, p_now);
  v_key := case when p_type in ('college_list','activity_list') then p_dedupe || ':' || to_char(v_month, 'YYYY-MM') else p_dedupe end;

  if exists (select 1 from public.kpi_months where counselor_id = p_counselor and month = v_month) then
    return;
  end if;
  if exists (select 1 from public.kpi_completion_sources where source_table = p_source_table and source_id = p_source_id) then
    return;
  end if;

  select * into v_existing from public.kpi_completions
  where counselor_id = p_counselor and task_type = p_type and dedupe_key = v_key
  for update;
  if found and exists (select 1 from public.kpi_months where counselor_id = p_counselor and month = v_existing.month) then
    return;
  end if;

  delete from public.kpi_task_sessions
  where counselor_id = p_counselor and task_type = p_type and subject_id = p_subject
  returning active_seconds into v_secs;
  v_secs := coalesce(v_secs, 0);

  if v_existing.id is not null then
    if v_secs > 0 then
      select * into v_measure from private.kpi_measure(p_counselor, p_type, v_existing.measured_seconds + v_secs, null);
      update public.kpi_completions
      set measured_seconds = measured_seconds + v_secs,
          meridies_minutes = v_measure.minutes,
          measure_method   = v_measure.method,
          saved_minutes    = manual_minutes - v_measure.minutes
      where id = v_existing.id;
    end if;
    insert into public.kpi_completion_sources (completion_id, source_table, source_id)
    values (v_existing.id, p_source_table, p_source_id) on conflict do nothing;
    return;
  end if;

  select * into b from public.kpi_baselines where counselor_id = p_counselor;
  v_manual := coalesce((b.manual ->> p_type)::integer, private.kpi_default_manual(p_type));
  v_signup := coalesce((b.meridies ->> p_type)::integer, private.kpi_default_meridies(p_type));
  select * into v_measure from private.kpi_measure(p_counselor, p_type, v_secs, v_signup);

  insert into public.kpi_completions (
    counselor_id, firm_id, student_id, task_type, dedupe_key, month, completed_at,
    manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, measure_method,
    saved_minutes, hourly_rate, rate_is_estimate)
  values (
    p_counselor, (select firm_id from public.profiles where id = p_counselor), p_student, p_type, v_key, v_month, p_now,
    v_manual, not coalesce((b.manual_edited ->> p_type)::boolean, false), v_secs, v_measure.minutes, v_measure.method,
    v_manual - v_measure.minutes, coalesce(b.hourly_rate, 150), not coalesce(b.rate_edited, false))
  returning id into v_id;

  insert into public.kpi_completion_sources (completion_id, source_table, source_id)
  values (v_id, p_source_table, p_source_id);
end;
$$;

create or replace function private.kpi_record(
  p_counselor uuid, p_type text, p_subject uuid, p_student uuid, p_dedupe text, p_source_table text, p_source_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$ select private.kpi_record_at(p_counselor, p_type, p_subject, p_student, p_dedupe, p_source_table, p_source_id, now()) $$;

-- Undo one source. The completion goes when its last source does, unless its month is locked.
create or replace function private.kpi_unrecord(p_source_table text, p_source_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_completion uuid;
  v_locked     boolean;
begin
  select s.completion_id,
         exists (select 1 from public.kpi_months m where m.counselor_id = c.counselor_id and m.month = c.month)
    into v_completion, v_locked
  from public.kpi_completion_sources s join public.kpi_completions c on c.id = s.completion_id
  where s.source_table = p_source_table and s.source_id = p_source_id;

  if v_completion is null or v_locked then
    return;
  end if;
  delete from public.kpi_completion_sources where source_table = p_source_table and source_id = p_source_id;
  if not exists (select 1 from public.kpi_completion_sources where completion_id = v_completion) then
    delete from public.kpi_completions where id = v_completion;
  end if;
end;
$$;

revoke all on function private.kpi_record_at(uuid, text, uuid, uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.kpi_record(uuid, text, uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function private.kpi_unrecord(text, uuid) from public, anon, authenticated;
revoke all on function private.kpi_measure(uuid, text, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers. Each traps its own errors: the ledger must never block a save.
-- ---------------------------------------------------------------------------

-- Family report: sent → record; un-sent or deleted → undo.
create or replace function private.kpi_family_reports_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if tg_op = 'DELETE' then
      if old.status = 'sent' then perform private.kpi_unrecord('family_reports', old.id); end if;
      return old;
    end if;
    if new.status = 'sent' and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
      perform private.kpi_record(private.kpi_actor(new.counselor_id), 'family_report', new.student_id, new.student_id,
                                 new.id::text, 'family_reports', new.id);
    elsif tg_op = 'UPDATE' and old.status = 'sent' and new.status is distinct from 'sent' then
      perform private.kpi_unrecord('family_reports', new.id);
    end if;
  exception when others then
    raise warning 'kpi family_reports: %', sqlerrm;
  end;
  return coalesce(new, old);
end;
$$;
drop trigger if exists kpi_family_reports on public.family_reports;
create trigger kpi_family_reports after insert or update of status or delete on public.family_reports
  for each row execute function private.kpi_family_reports_trg();

-- Meeting: "Notes sent" mark → record; cleared or deleted → undo.
create or replace function private.kpi_meetings_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if tg_op = 'DELETE' then
      if old.notes_sent_at is not null then perform private.kpi_unrecord('meetings', old.id); end if;
      return old;
    end if;
    if new.notes_sent_at is not null and old.notes_sent_at is null then
      perform private.kpi_record(private.kpi_actor(new.counselor_id), 'meeting', new.id, new.student_id,
                                 new.id::text, 'meetings', new.id);
    elsif new.notes_sent_at is null and old.notes_sent_at is not null then
      perform private.kpi_unrecord('meetings', new.id);
    end if;
  exception when others then
    raise warning 'kpi meetings: %', sqlerrm;
  end;
  return coalesce(new, old);
end;
$$;
drop trigger if exists kpi_meetings on public.meetings;
create trigger kpi_meetings after update of notes_sent_at or delete on public.meetings
  for each row execute function private.kpi_meetings_trg();

-- College list: an AI-generated list saved → record (one per student per month); deleted → undo.
create or replace function private.kpi_college_list_variants_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if tg_op = 'DELETE' then
      perform private.kpi_unrecord('college_list_variants', old.id);
      return old;
    end if;
    if new.generated_by = 'ai' then
      perform private.kpi_record(
        private.kpi_actor(coalesce(new.created_by, (select counselor_id from public.profiles where id = new.student_id))),
        'college_list', new.student_id, new.student_id, new.student_id::text, 'college_list_variants', new.id);
    end if;
  exception when others then
    raise warning 'kpi college_list_variants: %', sqlerrm;
  end;
  return coalesce(new, old);
end;
$$;
drop trigger if exists kpi_college_list_variants on public.college_list_variants;
create trigger kpi_college_list_variants after insert or delete on public.college_list_variants
  for each row execute function private.kpi_college_list_variants_trg();

-- Research recommendation accepted: recorded once the thing it created is linked
-- (accepted_as), against that thing, so deleting it undoes the completion.
create or replace function private.kpi_recommendations_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text;
  v_id    uuid;
begin
  begin
    if new.status = 'accepted' and new.accepted_as is not null and old.accepted_as is null then
      v_table := case new.accepted_as ->> 'type' when 'task' then 'deliverables' when 'student_college' then 'student_colleges' end;
      v_id := (new.accepted_as ->> 'id')::uuid;
      if v_table is not null and v_id is not null then
        perform private.kpi_record(
          coalesce(new.accepted_by, private.kpi_actor(null)),
          case new.feature when 'activities' then 'activity_list' else 'college_list' end,
          new.student_id, new.student_id, new.student_id::text, v_table, v_id);
      end if;
    end if;
  exception when others then
    raise warning 'kpi recommendations: %', sqlerrm;
  end;
  return new;
end;
$$;
drop trigger if exists kpi_recommendations on public.recommendations;
create trigger kpi_recommendations after update of accepted_as on public.recommendations
  for each row execute function private.kpi_recommendations_trg();

-- The thing an accepted recommendation created is deleted → undo.
create or replace function private.kpi_source_deleted_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform private.kpi_unrecord(tg_table_name, old.id);
  exception when others then
    raise warning 'kpi %: %', tg_table_name, sqlerrm;
  end;
  return old;
end;
$$;
drop trigger if exists kpi_deliverables_deleted on public.deliverables;
create trigger kpi_deliverables_deleted after delete on public.deliverables
  for each row execute function private.kpi_source_deleted_trg();
drop trigger if exists kpi_student_colleges_deleted on public.student_colleges;
create trigger kpi_student_colleges_deleted after delete on public.student_colleges
  for each row execute function private.kpi_source_deleted_trg();

-- Essay feedback: a review round's marks decided → one completion per essay and round.
create or replace function private.kpi_essay_marks_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if old.status = 'open' and new.status in ('accepted','rejected') and new.quality_check_id is not null then
      perform private.kpi_record(
        private.kpi_actor((select counselor_id from public.profiles where id = new.student_id)),
        'essay_feedback', new.essay_id, new.student_id, new.essay_id::text || ':' || new.quality_check_id::text,
        'essay_marks', new.id);
    end if;
  exception when others then
    raise warning 'kpi essay_marks: %', sqlerrm;
  end;
  return new;
end;
$$;
drop trigger if exists kpi_essay_marks on public.essay_marks;
create trigger kpi_essay_marks after update of status on public.essay_marks
  for each row execute function private.kpi_essay_marks_trg();
