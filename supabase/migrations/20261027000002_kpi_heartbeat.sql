-- Time saved, step 2: server-timed heartbeats.
-- Spec: docs/superpowers/specs/2026-10-26-roi-kpi-report-design.md
--
-- One row per (consultant, task type, subject) with ONE last-heartbeat time, so
-- several tabs can't double count. The client sends no duration: each increment
-- is the gap between this server's own receive times, added only when it is
-- under the 10-minute idle limit. A beat under 30 s after the last counted one
-- changes nothing (except that it still records an interruption the client
-- reports: `p_interrupted`, sticky for the task). The API checks the subject belongs to the consultant before
-- calling this; EXECUTE is service_role only, so no client can call it directly.
--
-- Deploy order: after 20261027000001; either order with the code (the route
-- answers 503 kpi_unavailable without it). Not in REQUIRED_SCHEMA.

create or replace function public.kpi_heartbeat(p_counselor uuid, p_task_type text, p_subject uuid, p_interrupted boolean default false)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_now  timestamptz := clock_timestamp();
  v_gap  double precision;
begin
  if p_task_type not in ('college_list','essay_feedback','meeting','family_report','activity_list') then
    raise exception 'unknown task type' using errcode = '22023';
  end if;

  insert into public.kpi_task_sessions (counselor_id, task_type, subject_id, last_heartbeat_at, last_active_on, interrupted)
  values (p_counselor, p_task_type, p_subject, v_now, current_date, coalesce(p_interrupted, false))
  on conflict (counselor_id, task_type, subject_id) do nothing;
  if found then
    return 'started';
  end if;

  if p_interrupted then
    update public.kpi_task_sessions set interrupted = true
    where counselor_id = p_counselor and task_type = p_task_type and subject_id = p_subject;
  end if;

  select last_heartbeat_at into v_last
  from public.kpi_task_sessions
  where counselor_id = p_counselor and task_type = p_task_type and subject_id = p_subject
  for update;

  if v_last is null then
    update public.kpi_task_sessions set last_heartbeat_at = v_now, last_active_on = current_date
    where counselor_id = p_counselor and task_type = p_task_type and subject_id = p_subject;
    return 'started';
  end if;

  v_gap := extract(epoch from (v_now - v_last));
  if v_gap < 30 then
    return 'throttled';
  elsif v_gap < 600 then
    update public.kpi_task_sessions
    set active_seconds = active_seconds + floor(v_gap)::int, last_heartbeat_at = v_now, last_active_on = current_date
    where counselor_id = p_counselor and task_type = p_task_type and subject_id = p_subject;
    return 'counted';
  else
    update public.kpi_task_sessions set last_heartbeat_at = v_now, last_active_on = current_date
    where counselor_id = p_counselor and task_type = p_task_type and subject_id = p_subject;
    return 'idle-reset';
  end if;
end;
$$;

revoke all on function public.kpi_heartbeat(uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.kpi_heartbeat(uuid, text, uuid, boolean) to service_role;
