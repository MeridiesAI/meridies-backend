-- The college features ingest (lib/ingest/collegeFeatures.ts, `npm run ingest:features`): it reads a college's own
-- pages once and fills college_core_features and college_opportunities (20261119000001).
--
--   college_source_pages             one row per page of a college's site the job read: the URL as fetched, the
--                                    sha256 of its cleaned text, how long that text was and when it was fetched.
--                                    A re-run skips a page whose cleaned text hashes the same, so an unchanged
--                                    site costs no model call.
--   college_opportunities.missed_runs  how many runs in a row read an opportunity's source page and didn't find it.
--                                    Seen again resets it to 0; the second miss in a row sets active = false. A row
--                                    is never deleted by the job.
--   ai_runs.module 'college-features' the per-college model calls and the run's summary row.
--
-- Catalog data about public web pages: no student, no user. college_source_pages is service-role only (RLS on, no
-- policy and no grant for anon or authenticated, plus the approval gate every table carries); only the job reads
-- and writes it.
--
-- Deploy order: either. The code never reads these on a request: the ingest is a script, and it refuses to start
-- (naming this file) until both the table and the column exist. With this file and the previous build nothing
-- touches them. Not in REQUIRED_SCHEMA. Needs 20261119000001 (college_opportunities) first.

create table if not exists public.college_source_pages (
  college_id   uuid not null references public.colleges(id) on delete cascade,
  url          text not null check (url ~ '^https?://' and length(url) <= 2000),
  -- sha256 hex of the cleaned text, never of the raw HTML.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  text_chars   integer not null check (text_chars >= 0),
  fetched_at   timestamptz not null default now(),
  primary key (college_id, url)
);

alter table public.college_source_pages enable row level security;
revoke all on public.college_source_pages from public, anon, authenticated;
grant all on public.college_source_pages to service_role;
select private.attach_approval_gate('public.college_source_pages');

alter table public.college_opportunities
  add column if not exists missed_runs smallint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.college_opportunities'::regclass and conname = 'college_opportunities_missed_runs_check'
  ) then
    alter table public.college_opportunities add constraint college_opportunities_missed_runs_check
      check (missed_runs between 0 and 1000);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- ai_runs.module: 'college-features', added without dropping another label
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

  if 'college-features' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'college-features'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
