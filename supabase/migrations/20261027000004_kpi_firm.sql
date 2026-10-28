-- Time saved, step 4: firm totals for owners and admins.
-- Spec: docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
--
-- Totals only, only for months that have ended, and only when 3+ consultants
-- contributed that month, so an admin
-- can't subtract their own figures to read a colleague's. Never a per-person field.
-- Rows count under the firm snapshotted when the work was done.
--
-- Deploy order: after 20261027000001; either order with the code (the route
-- answers 503 kpi_unavailable without it). Not in REQUIRED_SCHEMA.

-- The totals themselves (service role only: the monthly job reads them for the firm email).
create or replace function public.kpi_firm_totals(p_firm uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_people integer;
  v_result jsonb;
begin
  select count(distinct counselor_id) into v_people
  from public.kpi_completions where firm_id = p_firm and month = p_month;

  if v_people < 3 then
    return jsonb_build_object('available', false);
  end if;

  select jsonb_build_object(
    'available',   true,
    'hoursSaved',  round(sum(saved_minutes) / 60.0, 1),
    'valueOfTime', case when sum(saved_minutes) > 0 then round(sum(saved_minutes / 60.0 * hourly_rate)) else null end,
    'completions', count(*),
    'students',    count(distinct student_id))
  into v_result
  from public.kpi_completions where firm_id = p_firm and month = p_month;
  return v_result;
end;
$$;

revoke all on function public.kpi_firm_totals(uuid, date) from public, anon, authenticated;
grant execute on function public.kpi_firm_totals(uuid, date) to service_role;

create or replace function public.kpi_firm_month(p_firm uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or not private.is_counselor(v_me) or not (
       exists (select 1 from public.firms f where f.id = p_firm and f.owner_id = v_me)
    or exists (select 1 from public.firm_members m where m.firm_id = p_firm and m.profile_id = v_me and m.seat_role in ('owner','admin'))
  ) then
    raise exception 'Only the firm''s owners and admins see firm totals' using errcode = '42501';
  end if;

  -- A month still open is never shown: polling it, the change between two reads
  -- would be one colleague's work, and value ÷ hours their rate.
  if p_month >= date_trunc('month', now())::date then
    return jsonb_build_object('available', false, 'reason', 'month-open');
  end if;

  return public.kpi_firm_totals(p_firm, p_month);
end;
$$;

revoke all on function public.kpi_firm_month(uuid, date) from public, anon;
grant execute on function public.kpi_firm_month(uuid, date) to authenticated;
