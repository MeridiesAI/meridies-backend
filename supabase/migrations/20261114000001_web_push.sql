-- Push notifications (Phase 2 of the phone app).
--
-- A user's device registers a push subscription; a cron sweep (POST /internal/push-dispatch) turns each new
-- `notifications` row (the in-app bell's own rows) into one push per registered device. `channel` is 'web' now;
-- 'fcm' / 'apns' are reserved for the store apps, so they need no second migration.
--
--   * push_subscriptions: owner-only (a user reads, adds and removes only their own devices). The API's sweep reads
--     them with the service role.
--   * notifications.pushed_at: set when the sweep has handled the row. Every existing row is marked handled here, so
--     switching the sweep on never pushes old notifications.
--   * job_heartbeats: the sweep's label.
--
-- Deploy order: either. Without VAPID keys (or before this migration) the API answers 503 push_unavailable and the
-- sweep does nothing; the app shows "isn't switched on yet".

create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  channel      text not null default 'web' check (channel in ('web', 'fcm', 'apns')),
  endpoint     text not null check (length(endpoint) between 10 and 2048),
  p256dh       text check (length(p256dh) <= 512),
  auth         text check (length(auth) <= 512),
  user_agent   text check (length(user_agent) <= 300),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, endpoint),
  -- A web subscription needs its keys; a device token (fcm/apns) has none.
  check (channel <> 'web' or (p256dh is not null and auth is not null))
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists push_subscriptions_insert_own on public.push_subscriptions;
create policy push_subscriptions_insert_own on public.push_subscriptions
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists push_subscriptions_delete_own on public.push_subscriptions;
create policy push_subscriptions_delete_own on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.push_subscriptions');

-- ---------------------------------------------------------------------------
-- Which notifications the sweep has handled
-- ---------------------------------------------------------------------------

alter table public.notifications add column if not exists pushed_at timestamptz;
update public.notifications set pushed_at = now() where pushed_at is null;
create index if not exists notifications_unpushed_idx on public.notifications (created_at) where pushed_at is null;

-- ---------------------------------------------------------------------------
-- The sweep's heartbeat (reads the CHECK back so no other label is dropped)
-- ---------------------------------------------------------------------------

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.job_heartbeats'::regclass and c.conname = 'job_heartbeats_job_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if not ('push-dispatch' = any(v_values)) then
    v_values := array_append(v_values, 'push-dispatch'::text);
    alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
    execute format('alter table public.job_heartbeats add constraint job_heartbeats_job_check check (job = any (%L::text[]))', v_values);
  end if;
end;
$$;

insert into public.job_heartbeats (job, expected_every)
values ('push-dispatch', interval '5 minutes')
on conflict (job) do nothing;
