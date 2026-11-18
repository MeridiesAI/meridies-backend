-- Accessibility & Support for colleges, plus a student's private learning-support note.
--
--   college_accessibility            shared, one row per college: the disability services office, the percent of
--                                    undergraduates registered with it (IPEDS only), the level of support, a
--                                    structured program, accommodations, policies. Filled by the IPEDS import
--                                    (scripts/ingest/ipeds-accessibility.ts) and the AxIS research job
--                                    (lib/collegeAccessibility.ts). Public college data: any signed-in user reads it;
--                                    only the service role writes it.
--   college_accessibility_overrides  a practice's own edits to a college's record, without changing the shared row.
--                                    Scoped like the Contact Pipeline (a firm, else the solo Consultant): the
--                                    practice's members read and write them, nobody else.
--   student_learning_support         SENSITIVE. A student's learning-support need and notes. A table of its own on
--                                    purpose, so no existing student view, serializer, export or student or parent
--                                    API can reach it. Only the student's own Consultant reads or writes it; there is
--                                    NO policy for the student, a parent or anyone else. It is not on the AI allowlist
--                                    (lib/context/ai-allowlist.ts) and not in any data export.
--   ai_runs.module 'college-accessibility'  the research job's model calls.
--
-- Deploy order: either. Additive only. Until this is applied every new route answers 503
-- `accessibility_unavailable` / `learning_support_unavailable`, and the app says it isn't switched on yet. None of
-- these is in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- Shared record
-- ---------------------------------------------------------------------------

create table if not exists public.college_accessibility (
  college_id                 uuid primary key references public.colleges(id) on delete cascade,
  -- Copied from colleges.unitid (only a partial unique index there, so it cannot be a foreign key).
  unitid                     integer,
  ds_office_name             text check (ds_office_name is null or length(ds_office_name) <= 200),
  ds_email                   text check (ds_email is null or (length(ds_email) <= 254 and ds_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  ds_phone                   text check (ds_phone is null or length(ds_phone) <= 40),
  ds_url                     text check (ds_url is null or (length(ds_url) <= 2000 and ds_url ~ '^https?://')),
  pct_registered_ds          numeric(5,2) check (pct_registered_ds is null or (pct_registered_ds >= 0 and pct_registered_ds <= 100)),
  -- IPEDS reports "3 percent or less" as a bucket, not a number.
  pct_three_or_less          boolean not null default false,
  support_level              text check (support_level is null or support_level in ('standard', 'enhanced', 'comprehensive')),
  program_name               text check (program_name is null or length(program_name) <= 200),
  program_fee_based          boolean,
  program_cost_text          text check (program_cost_text is null or length(program_cost_text) <= 400),
  accommodations             text[] not null default '{}' check (cardinality(accommodations) <= 30),
  course_substitution_policy text check (course_substitution_policy is null or length(course_substitution_policy) <= 1000),
  documentation_accepted     text check (documentation_accepted is null or length(documentation_accepted) <= 1000),
  source_urls                text[] not null default '{}' check (cardinality(source_urls) <= 40),
  -- field name -> the URLs that field was read from. The research job fills this for every field it sets.
  field_sources              jsonb not null default '{}'::jsonb
                               check (jsonb_typeof(field_sources) = 'object' and pg_column_size(field_sources) <= 20000),
  last_verified_at           timestamptz,
  data_source                text not null check (data_source in ('ipeds', 'axis', 'consultant')),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create unique index if not exists college_accessibility_unitid_uidx
  on public.college_accessibility (unitid) where unitid is not null;

drop trigger if exists college_accessibility_set_updated_at on public.college_accessibility;
create trigger college_accessibility_set_updated_at before update on public.college_accessibility
  for each row execute function public.set_updated_at();

alter table public.college_accessibility enable row level security;
revoke all on public.college_accessibility from public, anon, authenticated;
grant select on public.college_accessibility to authenticated;
grant all on public.college_accessibility to service_role;

drop policy if exists college_accessibility_select on public.college_accessibility;
create policy college_accessibility_select on public.college_accessibility
  for select to authenticated using (true);

select private.attach_approval_gate('public.college_accessibility');

-- ---------------------------------------------------------------------------
-- A practice's own edits
-- ---------------------------------------------------------------------------

create table if not exists public.college_accessibility_overrides (
  id           uuid primary key default gen_random_uuid(),
  -- A firm's practice carries firm_id; a solo Consultant's carries only their own id (the Contact Pipeline's shape).
  firm_id      uuid references public.firms(id) on delete cascade,
  counselor_id uuid not null references public.profiles(id) on delete cascade,
  -- The practice: the firm, else the solo Consultant. One row per practice per college.
  scope_id     uuid generated always as (coalesce(firm_id, counselor_id)) stored,
  college_id   uuid not null references public.colleges(id) on delete cascade,
  -- Only the keys the practice changed, camelCase as the API names them. The API validates every value.
  fields       jsonb not null check (jsonb_typeof(fields) = 'object' and pg_column_size(fields) <= 20000),
  updated_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint college_accessibility_overrides_scope_college_key unique (scope_id, college_id)
);

drop trigger if exists college_accessibility_overrides_set_updated_at on public.college_accessibility_overrides;
create trigger college_accessibility_overrides_set_updated_at before update on public.college_accessibility_overrides
  for each row execute function public.set_updated_at();

alter table public.college_accessibility_overrides enable row level security;
revoke all on public.college_accessibility_overrides from public, anon, authenticated;
grant select, delete on public.college_accessibility_overrides to authenticated;
grant insert (firm_id, counselor_id, college_id, fields, updated_by) on public.college_accessibility_overrides to authenticated;
grant update (fields, updated_by) on public.college_accessibility_overrides to authenticated;
grant all on public.college_accessibility_overrides to service_role;

drop policy if exists college_accessibility_overrides_select on public.college_accessibility_overrides;
create policy college_accessibility_overrides_select on public.college_accessibility_overrides
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists college_accessibility_overrides_insert on public.college_accessibility_overrides;
create policy college_accessibility_overrides_insert on public.college_accessibility_overrides
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid())));

drop policy if exists college_accessibility_overrides_update on public.college_accessibility_overrides;
create policy college_accessibility_overrides_update on public.college_accessibility_overrides
  for update to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists college_accessibility_overrides_delete on public.college_accessibility_overrides;
create policy college_accessibility_overrides_delete on public.college_accessibility_overrides
  for delete to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

select private.attach_approval_gate('public.college_accessibility_overrides');

-- ---------------------------------------------------------------------------
-- A student's private learning-support note
-- ---------------------------------------------------------------------------

create table if not exists public.student_learning_support (
  student_id uuid primary key references public.profiles(id) on delete cascade,
  need_level text not null default 'none' check (need_level in ('none', 'standard', 'enhanced', 'comprehensive')),
  notes      text check (notes is null or length(notes) <= 4000),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists student_learning_support_set_updated_at on public.student_learning_support;
create trigger student_learning_support_set_updated_at before update on public.student_learning_support
  for each row execute function public.set_updated_at();

comment on table public.student_learning_support is
  'A student''s learning-support need and notes. Consultant-only for select as well as write (the student''s own Consultant). No policy for the student, a parent or anyone else. Never sent to an AI feature by default, never in a data export.';

alter table public.student_learning_support enable row level security;
revoke all on public.student_learning_support from public, anon, authenticated;
grant select, insert, update, delete on public.student_learning_support to authenticated;
grant all on public.student_learning_support to service_role;

drop policy if exists student_learning_support_counselor on public.student_learning_support;
create policy student_learning_support_counselor on public.student_learning_support
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));

select private.attach_approval_gate('public.student_learning_support');

-- ---------------------------------------------------------------------------
-- ai_runs.module: 'college-accessibility', added without dropping another label
-- ---------------------------------------------------------------------------

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

  if 'college-accessibility' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'college-accessibility'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
