-- Time saved, step 5: anonymized averages for Meridies' own marketing.
-- Spec: docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
--
-- Only from figures consultants edited themselves (an unedited default is
-- left out), and nothing at all unless the pool holds 10+ consultants from 5+
-- firms (a solo consultant counts as their own firm). Medians only; no ids,
-- no names, no students. Service role only (the internal route).
--
-- Deploy order: after 20261027000001; either order with the code. Not in REQUIRED_SCHEMA.

create or replace function public.kpi_prospect_averages(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with pool as (
    select * from public.kpi_completions
    where month between date_trunc('month', p_from)::date and date_trunc('month', p_to)::date
      and manual_is_estimate = false
  ),
  size as (
    select count(distinct counselor_id) as people, count(distinct coalesce(firm_id, counselor_id)) as firms from pool
  ),
  tasks as (
    select jsonb_object_agg(task_type, jsonb_build_object(
             'completions', n, 'medianSavedMinutes', median_saved, 'medianMinutesInMeridies', median_meridies)) as j
    from (
      select task_type, count(*) as n,
             round(percentile_cont(0.5) within group (order by saved_minutes)::numeric, 1) as median_saved,
             round(percentile_cont(0.5) within group (order by meridies_minutes)::numeric, 1) as median_meridies
      from pool group by task_type
    ) t
  ),
  hours as (
    select round(percentile_cont(0.5) within group (order by h)::numeric, 1) as v
    from (select sum(saved_minutes) / 60.0 as h from pool group by counselor_id, month) m
  ),
  value as (
    select round(percentile_cont(0.5) within group (order by v)::numeric) as v
    from (select sum(saved_minutes / 60.0 * hourly_rate) as v from pool where rate_is_estimate = false group by counselor_id, month) x
  )
  select case
    when size.people < 10 or size.firms < 5 then jsonb_build_object('available', false)
    else jsonb_build_object(
      'available', true,
      'consultants', size.people,
      'firms', size.firms,
      'medianHoursPerMonth', hours.v,
      'medianValuePerMonth', value.v,
      'byTask', coalesce(tasks.j, '{}'::jsonb))
  end
  from size, tasks, hours, value
$$;

revoke all on function public.kpi_prospect_averages(date, date) from public, anon, authenticated;
grant execute on function public.kpi_prospect_averages(date, date) to service_role;
