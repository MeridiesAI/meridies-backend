-- Campus photos wait before they go live (the review queue), and each photo
-- run records its counts.
--
-- Wikidata's main image (P18) and the Commons file under it are crowd-edited:
-- anyone can point a college at another free image, or upload a new version
-- over its file, minutes before the monthly run. So the loader
-- (src/lib/ingest/collegePhotos.ts, reviewDecision) publishes a new or
-- changed photo only once it has been stable for a week: the Wikidata item and
-- the Commons file and its description page last edited at least seven days
-- before the run, read from the APIs the loader already calls, or the same
-- candidate seen unchanged by a run at least seven days earlier. A replacement
-- of a photo already shown always needs that earlier sighting; until then the
-- old photo keeps serving. A team pick (scripts/ingest/data/college-photo-picks.csv)
-- is published at once, unless a new version was uploaded over the picked file.
--
-- 1. college_photo_candidates: what a run held back and why, one row per
--    college, with when a run first and last saw that exact candidate (title,
--    Commons sha1, credit and license). This is the memory a later run
--    confirms against, and the team's review queue (read it in the SQL editor;
--    the dry-run CSV prints the same list). Operational: service_role only,
--    like ingest_runs. Rows are replaced or removed by the loader; a college's
--    row goes when its photo is published, unchanged, refused or suppressed.
-- 2. ingest_runs.counts: the run's counts by outcome (added, replaced,
--    held-new, held-replace, hold:<reason>, ...), numbers only, so each run's
--    row says what it held.
--
-- Deploy order: either, and after 20261023070001 (it names public.colleges
-- only, so it also applies on its own). Before this file the loader still
-- runs: a new photo is published only when every timestamp says it has been
-- stable for a week, a replacement is always held (no memory of an earlier
-- sighting), and the run's row is finished without its counts. Previous
-- builds never name either object. Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. college_photo_candidates
-- ---------------------------------------------------------------------------

create table if not exists public.college_photo_candidates (
  college_id     uuid primary key references public.colleges(id) on delete cascade,
  source         text not null check (source in ('wikidata', 'pick')),
  commons_title  text not null check (commons_title ~ '^File:.' and length(commons_title) <= 400),
  commons_sha1   text not null check (commons_sha1 ~ '^[0-9a-f]{40}$'),
  -- sha1 of the credit and license the run read: a credit edited since is a new candidate.
  text_hash      text not null check (text_hash ~ '^[0-9a-f]{40}$'),
  -- Why it was held, e.g. {replacement,file-recent}.
  reasons        text[] not null default '{}' check (cardinality(reasons) <= 10),
  first_seen_at  timestamptz not null,
  last_seen_at   timestamptz not null,
  check (last_seen_at >= first_seen_at)
);

alter table public.college_photo_candidates enable row level security;
revoke all on public.college_photo_candidates from public, anon, authenticated;
grant all on public.college_photo_candidates to service_role;

-- No policies: nobody but service_role (the loader) reads or writes it. The
-- approval gate is attached like on every public table.
select private.attach_approval_gate('public.college_photo_candidates');

-- ---------------------------------------------------------------------------
-- 2. ingest_runs.counts
-- ---------------------------------------------------------------------------

alter table public.ingest_runs add column if not exists counts jsonb;
