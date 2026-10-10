-- Research (spec §6–§7): runs, recommendations, blocklist, hidden counselor tasks.

alter table public.deliverables add column if not exists visible_to_student boolean not null default true;
comment on column public.deliverables.visible_to_student is
  'False: a counselor-only task (e.g. created from a recommendation). Hidden from the student in RLS until shared.';

drop policy if exists deliverables_student_visible on public.deliverables;
create policy deliverables_student_visible on public.deliverables
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student' or visible_to_student);

drop policy if exists deliverable_stages_student_visible on public.deliverable_stages;
create policy deliverable_stages_student_visible on public.deliverable_stages
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student'
         or exists (select 1 from public.deliverables d where d.id = deliverable_id and d.visible_to_student));

drop policy if exists deliverable_documents_student_visible on public.deliverable_documents;
create policy deliverable_documents_student_visible on public.deliverable_documents
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student'
         or exists (select 1 from public.deliverables d where d.id = deliverable_id and d.visible_to_student));

create table if not exists public.research_blocked_domains (
  domain text primary key check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  reason text not null check (reason in ('seo-listicle','lead-gen','essay-mill','pay-to-play','other')),
  created_at timestamptz not null default now()
);
alter table public.research_blocked_domains enable row level security;
revoke all on table public.research_blocked_domains from anon, authenticated;
insert into public.research_blocked_domains (domain, reason) values
  ('collegevine.com','lead-gen'), ('niche.com','lead-gen'), ('essayshark.com','essay-mill'),
  ('papersowl.com','essay-mill'), ('edubirdie.com','essay-mill'), ('ivypanda.com','essay-mill'),
  ('studentsofvalue.com','pay-to-play'), ('nshss.org','pay-to-play'), ('whoswhoamong.com','pay-to-play')
on conflict (domain) do nothing;

create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  counselor_id uuid not null references public.profiles(id) on delete cascade,
  firm_id uuid references public.firms(id) on delete set null,
  feature text not null check (feature in ('college_list','activities')),
  inputs_hash text not null check (length(inputs_hash) between 1 and 128),
  brief jsonb not null,
  status text not null check (status in ('running','succeeded','failed','discarded')),
  error text check (length(error) <= 500),
  model text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists research_runs_lookup on public.research_runs (student_id, feature, created_at desc);
alter table public.research_runs enable row level security;
revoke all on table public.research_runs from anon, authenticated;
grant select on table public.research_runs to authenticated;
drop policy if exists research_runs_select on public.research_runs;
create policy research_runs_select on public.research_runs for select to authenticated
  using (student_id <> (select auth.uid()) and coalesce((select private.user_role((select auth.uid()))), '') = 'counselor'
         and private.can_view_student(student_id, (select auth.uid())));

create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.research_runs(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  feature text not null check (feature in ('college_list','activities')),
  title text not null check (length(btrim(title)) between 1 and 300),
  details jsonb not null default '{}'::jsonb,
  why text not null check (length(why) <= 600),
  sources jsonb not null default '[]'::jsonb,
  status text not null default 'suggested' check (status in ('suggested','accepted','dismissed')),
  accepted_as jsonb,
  accepted_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists recommendations_run on public.recommendations (run_id);
create index if not exists recommendations_student on public.recommendations (student_id, feature, status);
alter table public.recommendations enable row level security;
revoke all on table public.recommendations from anon, authenticated;
grant select on table public.recommendations to authenticated;
drop policy if exists recommendations_select on public.recommendations;
create policy recommendations_select on public.recommendations for select to authenticated
  using (student_id <> (select auth.uid()) and coalesce((select private.user_role((select auth.uid()))), '') = 'counselor'
         and private.can_view_student(student_id, (select auth.uid())));

-- A hidden task leaves traces on its own: the activity log, tracker verdicts,
-- draft checks, red flags and the delivery log all point at it. A student's
-- read of any of them must not reveal the task (restrictive: ANDs with the
-- policies already there). Counselors are unaffected.

drop policy if exists progress_events_student_visible_task on public.progress_events;
create policy progress_events_student_visible_task on public.progress_events
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student'
         or deliverable_id is null
         or exists (select 1 from public.deliverables d where d.id = deliverable_id and d.visible_to_student));

drop policy if exists draft_quality_checks_student_visible_task on public.draft_quality_checks;
create policy draft_quality_checks_student_visible_task on public.draft_quality_checks
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student'
         or deliverable_id is null
         or exists (select 1 from public.deliverables d where d.id = deliverable_id and d.visible_to_student));

drop policy if exists deliverable_tracker_checks_student_visible_task on public.deliverable_tracker_checks;
create policy deliverable_tracker_checks_student_visible_task on public.deliverable_tracker_checks
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student'
         or deliverable_id is null
         or exists (select 1 from public.deliverables d where d.id = deliverable_id and d.visible_to_student));

drop policy if exists red_flags_student_visible_task on public.red_flags;
create policy red_flags_student_visible_task on public.red_flags
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student'
         or deliverable_id is null
         or exists (select 1 from public.deliverables d where d.id = deliverable_id and d.visible_to_student));

drop policy if exists message_deliveries_student_visible_task on public.message_deliveries;
create policy message_deliveries_student_visible_task on public.message_deliveries
  as restrictive for select to authenticated
  using (coalesce((select private.user_role((select auth.uid()))), '') <> 'student'
         or deliverable_id is null
         or exists (select 1 from public.deliverables d where d.id = deliverable_id and d.visible_to_student));

-- ai_runs module labels, added the additive way (see 20261012000001): read the
-- labels already allowed and append, so a sibling migration's label is never
-- dropped and a re-run is harmless.
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

  if 'activity-research' = any(v_values) and 'research-match' = any(v_values) then
    return;
  end if;
  v_values := array(select distinct unnest(v_values || array['activity-research', 'research-match']));

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
