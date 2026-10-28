-- Time saved, step 6: save signup figures as one atomic merge.
-- Each field in the app saves itself, so several saves can overlap; merging the
-- maps here (||) instead of read-modify-write in the API keeps every figure.
-- Edited flags only turn on. Service role only (PUT /kpi/baselines, own row).
--
-- Deploy order: after 20261027000001; the route answers 503 kpi_unavailable without it.

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
    counselor_id, manual, meridies, manual_edited, meridies_edited, hourly_rate, rate_edited,
    hours_per_student_year, hours_edited, monthly_email, prompt_dismissed_at, updated_at)
  values (
    p_counselor, coalesce(p_manual, '{}'), coalesce(p_meridies, '{}'), coalesce(p_manual_edited, '{}'),
    coalesce(p_meridies_edited, '{}'), p_rate, coalesce(p_rate_edited, false), p_hours, coalesce(p_hours_edited, false),
    coalesce(p_monthly_email, true), case when p_dismiss then now() end, now())
  on conflict (counselor_id) do update set
    manual                 = b.manual || coalesce(p_manual, '{}'),
    meridies               = b.meridies || coalesce(p_meridies, '{}'),
    manual_edited          = b.manual_edited || coalesce(p_manual_edited, '{}'),
    meridies_edited        = b.meridies_edited || coalesce(p_meridies_edited, '{}'),
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
