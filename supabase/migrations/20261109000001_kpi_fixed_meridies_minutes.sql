-- Time saved: "minutes with Meridies" is Meridies' own figure, not the counselor's.
--
-- Counselors could type their own minutes-with-Meridies in onboarding and Settings.
-- That figure is used whenever there's no measured time (always, for essay feedback
-- and family reports, which have no screen to time), so typing a low number made
-- savings look bigger. From now on:
--   1. A completion's fallback figure is always the Meridies default per task
--      (private.kpi_default_meridies), never a saved one.
--   2. kpi_save_baselines no longer writes the meridies figures (the API refuses them too).
--   3. Figures counselors already saved are cleared.
-- Completions already recorded keep their snapshotted numbers (past reports don't change).
--
-- Deploy order: either order with the code. Not in REQUIRED_SCHEMA.

update public.kpi_baselines
set meridies = '{}'::jsonb, meridies_edited = '{}'::jsonb, updated_at = now()
where meridies <> '{}'::jsonb or meridies_edited <> '{}'::jsonb;

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
  v_int      boolean := false;
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
  returning active_seconds, interrupted into v_secs, v_int;
  v_secs := coalesce(v_secs, 0);
  v_int := coalesce(v_int, false);

  if v_existing.id is not null then
    if v_secs > 0 or v_int then
      v_int := v_int or v_existing.measure_method = 'fallback';
      select * into v_measure
      from private.kpi_measure(p_counselor, p_type, v_existing.measured_seconds + v_secs, v_existing.signup_minutes, v_int);
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
  v_signup := private.kpi_default_meridies(p_type); -- Meridies' figure only, never a saved one
  select * into v_measure from private.kpi_measure(p_counselor, p_type, v_secs, v_signup, v_int);

  insert into public.kpi_completions (
    counselor_id, firm_id, student_id, task_type, subject_id, dedupe_key, month, completed_at,
    manual_minutes, manual_is_estimate, measured_seconds, meridies_minutes, signup_minutes, measure_method,
    saved_minutes, hourly_rate, rate_is_estimate)
  values (
    p_counselor, (select firm_id from public.profiles where id = p_counselor), p_student, p_type, p_subject, v_key, v_month, p_now,
    v_manual, not coalesce((b.manual_edited ->> p_type)::boolean, false), v_secs, v_measure.minutes, v_signup, v_measure.method,
    v_manual - v_measure.minutes, coalesce(b.hourly_rate, 150), not coalesce(b.rate_edited, false))
  returning id into v_id;

  insert into public.kpi_completion_sources (completion_id, source_table, source_id)
  values (v_id, p_source_table, p_source_id);
end;
$$;

revoke all on function private.kpi_record_at(uuid, text, uuid, uuid, text, text, uuid, timestamptz) from public, anon, authenticated;

-- Same signature (the API still passes the arguments); the meridies maps are no longer written.
create or replace function public.kpi_save_baselines(
  p_counselor uuid,
  p_manual jsonb, p_meridies jsonb, p_manual_edited jsonb, p_meridies_edited jsonb,
  p_rate numeric, p_rate_edited boolean, p_hours numeric, p_hours_edited boolean,
  p_monthly_email boolean, p_dismiss boolean)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.kpi_baselines as b (
    counselor_id, manual, manual_edited, hourly_rate, rate_edited,
    hours_per_student_year, hours_edited, monthly_email, prompt_dismissed_at, updated_at)
  values (
    p_counselor, coalesce(p_manual, '{}'), coalesce(p_manual_edited, '{}'),
    p_rate, coalesce(p_rate_edited, false), p_hours, coalesce(p_hours_edited, false),
    coalesce(p_monthly_email, true), case when p_dismiss then now() end, now())
  on conflict (counselor_id) do update set
    manual                 = b.manual || coalesce(p_manual, '{}'),
    manual_edited          = b.manual_edited || coalesce(p_manual_edited, '{}'),
    hourly_rate            = coalesce(p_rate, b.hourly_rate),
    rate_edited            = b.rate_edited or coalesce(p_rate_edited, false),
    hours_per_student_year = coalesce(p_hours, b.hours_per_student_year),
    hours_edited           = b.hours_edited or coalesce(p_hours_edited, false),
    monthly_email          = coalesce(p_monthly_email, b.monthly_email),
    prompt_dismissed_at    = case when p_dismiss then now() else b.prompt_dismissed_at end,
    updated_at             = now()
$$;

revoke all on function public.kpi_save_baselines(uuid, jsonb, jsonb, jsonb, jsonb, numeric, boolean, numeric, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.kpi_save_baselines(uuid, jsonb, jsonb, jsonb, jsonb, numeric, boolean, numeric, boolean, boolean, boolean) to service_role;
