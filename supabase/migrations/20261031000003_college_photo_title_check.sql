-- A Wikimedia-sourced campus photo must name its Commons file; only a looked-up
-- 'site' photo has none (and may not have one).
--
-- 20261031000002 widened college_photos_commons_title_check for the two lookup
-- sources and dropped NOT NULL on commons_title, but wrote the rule as
--
--   commons_title is null and source = 'site'
--   or commons_title ~ '^File:.' and length(commons_title) <= 400
--
-- For a wikidata, pick or commons-search row with a NULL title the second branch
-- is NULL, `false or null` is NULL, and a CHECK lets NULL through: such a row was
-- accepted. The same rule also let a 'site' row carry a Commons title, which that
-- file's header says it must not. This replaces it with a rule that cannot be
-- NULL for any source:
--
--   site             commons_title is null
--   anything else    commons_title is a 'File:...' title, at most 400 characters
--
-- Every row written so far satisfies it (the loader always sets a title; a lookup
-- sets one for commons-search and none for site), so nothing is rewritten.
--
-- Also corrects a claim in 20261031000002's header: before that migration the
-- lookup route does NOT answer 503. The refused insert is caught and logged, and
-- the counselor sees "No usable picture was found on Wikimedia Commons or the
-- school's website." (the route answers 503 only without the service-role key, or
-- when the college_photos table itself is missing).
--
-- Deploy order: either; the code does not depend on it and it is not in
-- REQUIRED_SCHEMA. Idempotent: drops the constraint by name, then adds it back.

alter table public.college_photos drop constraint if exists college_photos_commons_title_check;
alter table public.college_photos
  add constraint college_photos_commons_title_check
  check (
    source = 'site' and commons_title is null
    or source <> 'site' and commons_title is not null and commons_title ~ '^File:.' and length(commons_title) <= 400
  );
