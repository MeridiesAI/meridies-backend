-- PostgREST only exposes `public`, so the limiter RPCs have to live there.
-- EXECUTE is granted to service_role alone; anon and authenticated cannot call
-- them, which is what keeps a client from incrementing (or resetting) its own
-- limit. The bucket tables stay in `private`.

create or replace function public.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path to 'private','public','pg_temp'
as $function$
declare
  v_now    timestamptz := now();
  v_start  timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_count  integer;
begin
  insert into private.rate_limit_buckets (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set count = case when private.rate_limit_buckets.window_start < v_start
                     then 1
                     else private.rate_limit_buckets.count + 1 end,
        window_start = case when private.rate_limit_buckets.window_start < v_start
                            then v_now
                            else private.rate_limit_buckets.window_start end
  returning count into v_count;

  return v_count <= p_limit;
end;
$function$;

create or replace function public.consume_quota(
  p_subject uuid,
  p_metric text,
  p_period text,
  p_limit bigint,
  p_amount bigint default 1
)
returns boolean
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_start date := case when p_period = 'month' then date_trunc('month', now())::date
                       else current_date end;
  v_count bigint;
begin
  insert into public.usage_counters (subject_id, metric, period, period_start, count)
  values (p_subject, p_metric, p_period, v_start, p_amount)
  on conflict (subject_id, metric, period, period_start) do update
    set count = public.usage_counters.count + p_amount,
        updated_at = now()
  returning count into v_count;

  return v_count <= p_limit;
end;
$function$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.consume_quota(uuid, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
grant execute on function public.consume_quota(uuid, text, text, bigint, bigint) to service_role;

drop function if exists private.consume_rate_limit(text, integer, integer);
drop function if exists private.consume_quota(uuid, text, text, bigint, bigint);
