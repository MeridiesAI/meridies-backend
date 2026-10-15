-- Campus photos for the catalog (college_photos + the public college-photos bucket).
--
-- One freely licensed photo per college, from Wikimedia Commons, found through
-- Wikidata (the college's IPEDS unitid, P1771, to its main image, P18) or
-- named by the team in scripts/ingest/data/college-photo-picks.csv. Loaded by
-- src/lib/ingest/collegePhotos.ts (scripts/ingest/college-photos.ts, and
-- monthly POST /internal/ingest/college-photos).
--
-- The rules, enforced in the loader and again here:
--   - Only CC0, public domain, CC BY and CC BY-SA files. Never NC or ND.
--   - Every row carries what CC BY and CC BY-SA require to attribute it: the
--     author's credit (never clipped; a credit too long to store is refused),
--     the license, its deed and the Commons file page.
--   - A college with no usable free image has no row. Nothing is guessed from
--     a search.
--   - The two JPEG sizes (500 and 1280 px wide) are copied into Storage under
--     <unitid>/<sha1>-<width>.jpg, content-addressed, so a file that changes on
--     Commons gets new objects rather than overwriting old ones.
--   - Public catalog content: any signed-in user reads the rows; only
--     service_role (the loader) writes them.
--
-- Deploy order: either. The API reads college_photos through
-- lib/collegePhotos.ts, which serves photo: null while this table is missing;
-- the loader refuses to start without it (503 naming this file). Not in
-- REQUIRED_SCHEMA. After applying it, run the loader once by hand
-- (npx tsx --env-file=.env scripts/ingest/college-photos.ts), or
-- /internal/status reads the new job overdue until the first monthly run.

-- ---------------------------------------------------------------------------
-- 1. college_photos
-- ---------------------------------------------------------------------------

create table if not exists public.college_photos (
  college_id     uuid primary key references public.colleges(id) on delete cascade,
  -- Where the choice came from: Wikidata's main image, or the team's picks file.
  source         text not null check (source in ('wikidata', 'pick')),
  wikidata_id    text check (wikidata_id is null or wikidata_id ~ '^Q[0-9]{1,12}$'),
  commons_title  text not null check (commons_title ~ '^File:.' and length(commons_title) <= 400),
  -- The Commons original's sha1: the same file keeps the same objects.
  commons_sha1   text not null check (commons_sha1 ~ '^[0-9a-f]{40}$'),
  storage_path   text not null check (storage_path ~ '^[0-9]{6}/[0-9a-f]{40}-1280\.jpg$'),
  thumb_path     text not null check (thumb_path ~ '^[0-9]{6}/[0-9a-f]{40}-500\.jpg$'),
  -- The stored 1280 px copy's size, for the aspect ratio.
  width          integer check (width is null or width between 1 and 20000),
  height         integer check (height is null or height between 1 and 20000),
  credit         text not null check (length(btrim(credit)) between 1 and 500),
  license        text not null check (
                   length(license) <= 60
                   and license !~* '\m(NC|ND)\M'
                   and license ~* '^(CC0|Public domain|PD\M|CC BY(-SA)? [0-9])'
                 ),
  license_url    text check (license_url is null or (license_url ~ '^https?://' and length(license_url) <= 500)),
  source_url     text not null check (source_url ~ '^https://commons\.wikimedia\.org/' and length(source_url) <= 2000),
  checked_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists college_photos_set_updated_at on public.college_photos;
create trigger college_photos_set_updated_at before update on public.college_photos
  for each row execute function public.set_updated_at();

alter table public.college_photos enable row level security;

drop policy if exists college_photos_select on public.college_photos;
create policy college_photos_select on public.college_photos
  for select to authenticated using (true);

revoke all on public.college_photos from anon, authenticated;
grant select on public.college_photos to authenticated;
grant all on public.college_photos to service_role;

-- A pending or revoked counselor reads nothing here, like every public table.
select private.attach_approval_gate('public.college_photos');

-- ---------------------------------------------------------------------------
-- 2. The bucket
-- ---------------------------------------------------------------------------
-- Public: the objects are CC-licensed campus photos anyone may see, served
-- from Storage's public URL without signing. It is the first public bucket;
-- nothing else may go in it. There is deliberately no storage.objects policy
-- for it: only service_role (the loader) writes, and the restrictive
-- approval_gate on storage.objects is untouched. JPEG only, 3 MB a file.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('college-photos', 'college-photos', true, 3145728, array['image/jpeg'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. Labels for the loader's runs and heartbeat
-- ---------------------------------------------------------------------------
-- Read the current CHECK back and add 'college-photos', so another migration's
-- label is never dropped and re-running this is harmless (the same read-back
-- as ai_runs_module_check in 20261021000001).

do $$
declare
  v_target record;
  v_def    text;
  v_values text[];
begin
  for v_target in
    select * from (values
      ('public.ingest_runs'::regclass,    'ingest_runs_source_check',  'source'),
      ('public.job_heartbeats'::regclass, 'job_heartbeats_job_check',  'job')
    ) as t(tbl, conname, col)
  loop
    select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
    where c.conrelid = v_target.tbl and c.conname = v_target.conname;

    select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
    from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
         lateral unnest(
           case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
         ) as v;

    if 'college-photos' = any(v_values) then
      continue;
    end if;
    v_values := array_append(v_values, 'college-photos'::text);

    execute format('alter table %s drop constraint if exists %I', v_target.tbl, v_target.conname);
    execute format(
      'alter table %s add constraint %I check (%I = any (%L::text[]))',
      v_target.tbl, v_target.conname, v_target.col, v_values
    );
  end loop;
end;
$$;

insert into public.job_heartbeats (job, expected_every)
values ('college-photos', interval '31 days')
on conflict (job) do nothing;
