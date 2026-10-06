-- Events Hub (v8, one feed since v9): webinars, workshops, conferences, college
-- fairs and admissions info sessions, and the counselor's saves.
--
-- The demo authors its listings against a fixed "today". Those are invented,
-- so NOTHING is seeded here: a listing is a row a counselor (for their firm, or
-- for themselves) or a Meridies curator (service_role, firm-less) entered.
-- The "Update" cards of the feed are public.policy_updates, which already
-- exists and is catalog-wide; this migration does not duplicate it.
--
--   hub_events        -- one listing. Dates are local dates plus wall-clock
--                        times in the organizer's time zone, because an
--                        all-day three-day conference has no instant.
--   hub_event_saves   -- Add to Calendar: which calendars the counselor sent it
--                        to and the reminder. A save with 'meridies' among its
--                        targets is what the Calendar shows as a Professional
--                        event (GET /events/calendar).
--
-- Also: the ai_runs module list gains 'college-research', additively.

create table if not exists public.hub_events (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 1 and 200),
  kind          text not null check (kind in
                  ('conference','webinar','workshop','college-fair','info-session')),
  -- Who runs it, as the organizer names itself.
  host          text not null check (length(btrim(host)) between 1 and 200),
  start_date    date not null,
  end_date      date,
  start_time    time,
  end_time      time,
  time_zone     text not null default 'America/New_York'
                check (length(time_zone) between 1 and 64),
  -- "Online", "Washington, DC"
  place         text not null default 'Online' check (length(btrim(place)) between 1 and 200),
  url           text not null check (url ~ '^https?://' and length(url) <= 2000),
  description   text check (length(description) <= 1000),
  -- A college the event is about; its campus photo stands for the event.
  college_id    uuid references public.colleges(id) on delete set null,
  -- A freely licensed stock photo (public/events), when no college is attached.
  photo_key     text check (photo_key in
                  ('webinar','webinar-desk','conference','college-fair','workshop','lecture-hall')),
  -- What the roster might need it for; drives the three recommendations.
  topics        text[] not null default '{}'
                check (topics <@ array['aid','essays','uc','lists','practice']::text[]),
  firm_id       uuid references public.firms(id) on delete cascade,
  created_by    uuid references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint hub_events_dates check (end_date is null or end_date >= start_date),
  constraint hub_events_times check (
    (start_time is null and end_time is null)
    or (start_time is not null and (end_time is null or end_date is not null or end_time > start_time))
  )
);

create index if not exists hub_events_start_idx on public.hub_events (start_date);
create index if not exists hub_events_college_idx on public.hub_events (college_id);
create index if not exists hub_events_firm_idx on public.hub_events (firm_id);

drop trigger if exists hub_events_set_updated_at on public.hub_events;
create trigger hub_events_set_updated_at before update on public.hub_events
  for each row execute function public.set_updated_at();

alter table public.hub_events enable row level security;

-- Counselors only. Meridies-wide rows (no author, no firm) for everyone; firm
-- rows for the firm; personal rows for their author.
drop policy if exists hub_events_select on public.hub_events;
create policy hub_events_select on public.hub_events
  for select to authenticated
  using (
    private.is_counselor((select auth.uid()))
    and (
      (created_by is null and firm_id is null)
      or created_by = (select auth.uid())
      or (firm_id is not null and private.is_firm_member(firm_id, (select auth.uid())))
    )
  );

drop policy if exists hub_events_insert on public.hub_events;
create policy hub_events_insert on public.hub_events
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.is_counselor((select auth.uid()))
    and (firm_id is null or private.is_firm_member(firm_id, (select auth.uid())))
  );

drop policy if exists hub_events_update on public.hub_events;
create policy hub_events_update on public.hub_events
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (
    created_by = (select auth.uid())
    and (firm_id is null or private.is_firm_member(firm_id, (select auth.uid())))
  );

drop policy if exists hub_events_delete on public.hub_events;
create policy hub_events_delete on public.hub_events
  for delete to authenticated
  using (created_by = (select auth.uid()));

revoke all on public.hub_events from anon, authenticated;
grant select, insert, update, delete on public.hub_events to authenticated;
grant all on public.hub_events to service_role;

-- ---------------------------------------------------------------------------
-- Saves
-- ---------------------------------------------------------------------------

create table if not exists public.hub_event_saves (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  event_id    uuid not null references public.hub_events(id) on delete cascade,
  targets     text[] not null default '{}'
              check (cardinality(targets) >= 1
                     and targets <@ array['meridies','google','outlook','apple']::text[]),
  reminder    text not null default 'none'
              check (reminder in ('none','15m','1h','1d','1w')),
  saved_at    timestamptz not null default now(),
  primary key (profile_id, event_id)
);

create index if not exists hub_event_saves_event_idx on public.hub_event_saves (event_id);

alter table public.hub_event_saves enable row level security;

-- A counselor's own saves, and only of events they can see.
drop policy if exists hub_event_saves_own on public.hub_event_saves;
create policy hub_event_saves_own on public.hub_event_saves
  for all to authenticated
  using (profile_id = (select auth.uid()))
  with check (
    profile_id = (select auth.uid())
    and exists (select 1 from public.hub_events e where e.id = event_id)
  );

revoke all on public.hub_event_saves from anon, authenticated;
grant select, insert, update, delete on public.hub_event_saves to authenticated;
grant all on public.hub_event_saves to service_role;

-- ---------------------------------------------------------------------------
-- ai_runs.module: add 'college-research' without dropping anything another
-- migration added. The current CHECK is read back and rebuilt as a superset.
-- ---------------------------------------------------------------------------

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  if v_def is null then
    return;
  end if;

  -- Postgres prints the CHECK either as ANY ('{a,b}'::text[]) or as a list of
  -- quoted literals; read both.
  if v_def ~ '''\{' then
    v_values := (substring(v_def from '''(\{[^'']*\})'''))::text[];
  else
    select coalesce(array_agg(m[1]), '{}') into v_values
    from regexp_matches(v_def, '''([^'']+)''', 'g') as m;
  end if;

  if 'college-research' = any (v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'college-research');

  execute 'alter table public.ai_runs drop constraint ai_runs_module_check';
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end
$$;
