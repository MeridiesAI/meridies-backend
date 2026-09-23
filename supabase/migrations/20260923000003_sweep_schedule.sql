-- ---------------------------------------------------------------------------
-- Scheduled accountability sweep: a lease so exactly one runner sweeps at a time.
--
-- The escalation sweep used to run only when a counselor clicked the dashboard
-- button. It now also runs on a schedule — a Railway cron hitting
-- `POST /internal/accountability/sweep`, and/or an in-process interval
-- (`SWEEP_INTERVAL_MINUTES`) on every API replica. Without a guard, two
-- replicas (or the cron and an interval) would sweep the same red flags
-- concurrently and race to queue the same parent alert twice.
--
-- Why a lease row and not pg_advisory_lock: every PostgREST RPC is its own
-- transaction on a pooled connection. A session-level advisory lock would stay
-- held on whatever pooled connection took it, and a transaction-level one is
-- released the moment the RPC returns — neither spans a sweep that makes many
-- round trips. A row with an expiry does, and a crashed holder simply times out.
--
-- The table lives in `private` (not exposed by PostgREST) with RLS on and no
-- policies. The two RPCs are SECURITY DEFINER with EXECUTE granted to
-- service_role only, matching consume_rate_limit / consume_quota.
-- ---------------------------------------------------------------------------

create table if not exists private.job_leases (
  name        text primary key,
  holder      text not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

alter table private.job_leases enable row level security;
revoke all on table private.job_leases from public, anon, authenticated;

-- Take the named lease for p_ttl_seconds. Returns true when this holder now
-- owns it (fresh, expired and taken over, or re-entered by the same holder);
-- false when someone else holds an unexpired lease.
create or replace function public.acquire_job_lease(
  p_name text,
  p_holder text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path to 'private','public','pg_temp'
as $function$
declare
  v_now    timestamptz := now();
  v_holder text;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 86400 then
    raise exception 'lease ttl out of range';
  end if;

  insert into private.job_leases (name, holder, acquired_at, expires_at)
  values (p_name, p_holder, v_now, v_now + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set holder      = excluded.holder,
        acquired_at = excluded.acquired_at,
        expires_at  = excluded.expires_at
    where private.job_leases.expires_at <= v_now
       or private.job_leases.holder = excluded.holder
  returning holder into v_holder;

  return v_holder is not null and v_holder = p_holder;
end;
$function$;

-- Release only a lease this holder owns; a holder whose lease expired and was
-- taken over must not release the new owner's.
create or replace function public.release_job_lease(p_name text, p_holder text)
returns void
language sql
security definer
set search_path to 'private','public','pg_temp'
as $function$
  delete from private.job_leases where name = p_name and holder = p_holder;
$function$;

revoke all on function public.acquire_job_lease(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_job_lease(text, text) from public, anon, authenticated;
grant execute on function public.acquire_job_lease(text, text, integer) to service_role;
grant execute on function public.release_job_lease(text, text) to service_role;
