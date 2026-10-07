-- Student view (SV Demo v2), 5 of 5: Profile Update (AxIS).
--
-- A student-only chat whose one job is to collect what the student has been
-- doing (awards, accomplishments, activities, leadership) one short question
-- at a time, and file each finished record into the Application page's
-- sheets (public.activities or public.awards) where the counselor sees it.
--
--   profile_update_threads   one conversation; its draft record so far
--   profile_update_messages  what was said, so a refresh continues the thread
--   profile_updates          the log of what was filed, and where
--
-- The student writes all three, for themselves only. The counselor reads them
-- (the log is what the student page shows). Nobody edits the log after the
-- fact: there are no update or delete policies on it. The filed row itself
-- lives in the sheet and is edited there like any other row.

create table if not exists public.profile_update_threads (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'open' check (status in ('open','filed')),
  kind        text check (kind in ('activity','honor')),
  -- The record gathered so far. Validated by the route before it is stored.
  draft       jsonb not null default '{}'::jsonb
                check (jsonb_typeof(draft) = 'object' and pg_column_size(draft) <= 8192),
  filed_update_id uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profile_update_threads_student_idx
  on public.profile_update_threads (student_id, updated_at desc);

drop trigger if exists profile_update_threads_set_updated_at on public.profile_update_threads;
create trigger profile_update_threads_set_updated_at before update on public.profile_update_threads
  for each row execute function public.set_updated_at();

create table if not exists public.profile_update_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.profile_update_threads(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('student','axis')),
  content     text not null check (length(btrim(content)) between 1 and 1000),
  created_at  timestamptz not null default now()
);

create index if not exists profile_update_messages_thread_idx
  on public.profile_update_messages (thread_id, created_at);

create table if not exists public.profile_updates (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  thread_id   uuid references public.profile_update_threads(id) on delete set null,
  kind        text not null check (kind in ('activity','honor')),
  summary     text not null check (length(btrim(summary)) between 1 and 300),
  -- Where it was filed: a row of public.activities or public.awards. Not a
  -- foreign key, because the counselor may delete the sheet row later and
  -- the log should still say what the student reported.
  filed_table text not null check (filed_table in ('activities','awards')),
  filed_id    uuid not null,
  details     jsonb not null default '{}'::jsonb
                check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 8192),
  created_at  timestamptz not null default now(),
  constraint profile_updates_kind_matches_table check (
    (kind = 'activity' and filed_table = 'activities') or (kind = 'honor' and filed_table = 'awards')
  )
);

create index if not exists profile_updates_student_idx
  on public.profile_updates (student_id, created_at desc);

alter table public.profile_update_threads
  drop constraint if exists profile_update_threads_filed_update_fk;
alter table public.profile_update_threads
  add constraint profile_update_threads_filed_update_fk
  foreign key (filed_update_id) references public.profile_updates(id) on delete set null;

comment on table public.profile_update_threads is
  'SV Demo v2 Profile Update (AxIS): one student conversation and the record drafted so far. Student-written, counselor-readable.';
comment on table public.profile_updates is
  'SV Demo v2: what a student reported through Profile Update and where it was filed (activities/awards). Append-only; the counselor reads it on the student page.';

-- ---- RLS --------------------------------------------------------------------

alter table public.profile_update_threads enable row level security;
alter table public.profile_update_messages enable row level security;
alter table public.profile_updates enable row level security;

-- Supabase's default privileges grant everything to anon and authenticated;
-- take it back and grant only what the policies below are written for.
revoke all on table public.profile_update_threads from anon, authenticated;
revoke all on table public.profile_update_messages from anon, authenticated;
revoke all on table public.profile_updates from anon, authenticated;
grant select, insert on table public.profile_update_threads to authenticated;
grant update (status, kind, draft, filed_update_id, updated_at) on public.profile_update_threads to authenticated;
grant select, insert on table public.profile_update_messages to authenticated;
grant select, insert on table public.profile_updates to authenticated;

-- Threads
drop policy if exists profile_update_threads_select on public.profile_update_threads;
create policy profile_update_threads_select on public.profile_update_threads
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists profile_update_threads_insert_self on public.profile_update_threads;
create policy profile_update_threads_insert_self on public.profile_update_threads
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

drop policy if exists profile_update_threads_update_self on public.profile_update_threads;
create policy profile_update_threads_update_self on public.profile_update_threads
  for update to authenticated
  using (student_id = (select auth.uid()))
  with check (student_id = (select auth.uid()));

-- Messages
drop policy if exists profile_update_messages_select on public.profile_update_messages;
create policy profile_update_messages_select on public.profile_update_messages
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists profile_update_messages_insert_self on public.profile_update_messages;
create policy profile_update_messages_insert_self on public.profile_update_messages
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and exists (
      select 1 from public.profile_update_threads t
      where t.id = thread_id and t.student_id = (select auth.uid())
    )
  );

-- The log
drop policy if exists profile_updates_select on public.profile_updates;
create policy profile_updates_select on public.profile_updates
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists profile_updates_insert_self on public.profile_updates;
create policy profile_updates_insert_self on public.profile_updates
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

-- ---- The ai_runs audit label ------------------------------------------------
-- Additive, like 20261005010004: read the labels already allowed and append,
-- so a sibling migration's label is never dropped and a re-run is harmless.

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if 'profile-update' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'profile-update'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
