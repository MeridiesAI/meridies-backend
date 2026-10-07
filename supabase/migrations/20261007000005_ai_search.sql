-- AI inside the search (BACKEND_TODO §5). Anthropic only, and it never invents:
--   - natural-language search turns words into the §3 filters and runs the
--     real search; the model never writes the result list;
--   - research answers come with a link for every claim (web search limited
--     to official domains);
--   - a fact research finds that differs from the catalog becomes a
--     proposal, and changes nothing until a catalog editor approves it.
--
-- This adds the proposals, the editors who may approve them, and four
-- ai_runs labels.

-- ---------------------------------------------------------------------------
-- catalog_editors: who may approve catalog changes. The catalog is shared by
-- every practice, so this is Meridies staff, not any counselor. Managed by
-- service_role (no client writes).
-- ---------------------------------------------------------------------------

create table if not exists public.catalog_editors (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  added_at    timestamptz not null default now()
);

alter table public.catalog_editors enable row level security;
drop policy if exists catalog_editors_select_self on public.catalog_editors;
create policy catalog_editors_select_self on public.catalog_editors
  for select to authenticated using (profile_id = (select auth.uid()));
revoke all on public.catalog_editors from public, anon, authenticated;
grant select on public.catalog_editors to authenticated;

create or replace function private.is_catalog_editor(p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$ select exists (select 1 from public.catalog_editors where profile_id = p_viewer) $$;
revoke all on function private.is_catalog_editor(uuid) from public, anon;
grant execute on function private.is_catalog_editor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- catalog_change_proposals
-- ---------------------------------------------------------------------------

create table if not exists public.catalog_change_proposals (
  id               uuid primary key default gen_random_uuid(),
  college_id       uuid not null references public.colleges(id) on delete cascade,
  -- The only fields a proposal may touch; each maps to one column in the API.
  field            text not null check (field in (
                     'test_policy', 'superscore', 'self_report_scores',
                     'css_profile_required', 'stars_required', 'fairtest_status')),
  current_value    text,
  proposed_value   text not null check (length(proposed_value) between 1 and 40),
  -- The page the fact came from: required, http(s).
  source_url       text not null check (source_url ~ '^https?://' and length(source_url) <= 2000),
  -- The sentence it rests on, as cited.
  evidence         text check (length(evidence) <= 1000),
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  proposed_by      uuid references public.profiles(id) on delete set null,
  ai_run_id        uuid,
  reviewed_by      uuid references public.profiles(id) on delete set null,
  reviewed_at      timestamptz,
  review_note      text check (length(review_note) <= 500),
  created_at       timestamptz not null default now()
);

create index if not exists catalog_change_proposals_status_idx on public.catalog_change_proposals (status, created_at desc);
create index if not exists catalog_change_proposals_college_idx on public.catalog_change_proposals (college_id);
-- One open proposal per school, field and value.
create unique index if not exists catalog_change_proposals_open_key
  on public.catalog_change_proposals (college_id, field, proposed_value) where status = 'pending';

alter table public.catalog_change_proposals enable row level security;

drop policy if exists catalog_change_proposals_select on public.catalog_change_proposals;
create policy catalog_change_proposals_select on public.catalog_change_proposals
  for select to authenticated
  using (proposed_by = (select auth.uid()) or private.is_catalog_editor((select auth.uid())));

-- Written by the API (service_role) from a research run; reviewed through the
-- API by an editor. No direct client writes.
revoke all on public.catalog_change_proposals from public, anon, authenticated;
grant select on public.catalog_change_proposals to authenticated;

-- ---------------------------------------------------------------------------
-- ai_runs.module: add the §5 labels without dropping anything another
-- migration added (the 20261005040003 pattern).
-- ---------------------------------------------------------------------------

do $$
declare
  v_def    text;
  v_values text[];
  v_new    text;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  if v_def is null then
    return;
  end if;

  if v_def ~ '''\{' then
    v_values := (substring(v_def from '''(\{[^'']*\})'''))::text[];
  else
    select coalesce(array_agg(m[1]), '{}') into v_values
    from regexp_matches(v_def, '''([^'']+)''', 'g') as m;
  end if;

  foreach v_new in array array['college-search', 'web-research', 'resource-qa', 'list-explain'] loop
    if not (v_new = any (v_values)) then
      v_values := array_append(v_values, v_new);
    end if;
  end loop;

  execute 'alter table public.ai_runs drop constraint ai_runs_module_check';
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end
$$;
