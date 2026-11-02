-- Campus photos found by a counselor's "Look up info & photo" (POST /colleges/:id/lookup).
--
-- The monthly loader (20261023070001) only knows Wikimedia Commons through
-- Wikidata or the team's picks. A counselor looking at a school with no photo
-- can now ask for one, and two more kinds of row exist:
--
--   commons-search  a Commons file found by the school's name, accepted by the
--                   loader's own rules (JPEG, big enough, CC0 / public domain /
--                   CC BY / CC BY-SA, a credit). Same row shape as a pick.
--   site            the college's own share image (og:image), from its host or
--                   a subdomain, a JPEG of at most 3 MB, copied into the bucket.
--                   Not freely licensed: license reads 'University website',
--                   the credit names the school and source_url is the page it
--                   came from. No Commons title.
--
-- Only a school with no photo at all is looked up, so a lookup never replaces
-- the loader's photo; and the loader leaves these two kinds alone when
-- Wikidata has nothing for the school (it still replaces them when Wikidata or
-- a pick offers a photo, or a pick says 'none').
--
-- Deploy order: either. Before this file the lookup route's insert is refused by
-- the old CHECKs and answers 503 "isn't switched on yet" (the app shows that
-- calmly); the old API never writes these sources. Not in REQUIRED_SCHEMA.
-- The review gate (20261024000071) is not applied to these two sources: a
-- counselor chose to look, and nothing replaces a loader photo.

-- ---------------------------------------------------------------------------
-- 1. college_photos
-- ---------------------------------------------------------------------------

alter table public.college_photos drop constraint if exists college_photos_source_check;
alter table public.college_photos
  add constraint college_photos_source_check
  check (source in ('wikidata', 'pick', 'commons-search', 'site'));

-- A site photo has no Commons file.
alter table public.college_photos alter column commons_title drop not null;
alter table public.college_photos drop constraint if exists college_photos_commons_title_check;
alter table public.college_photos
  add constraint college_photos_commons_title_check
  check (commons_title is null and source = 'site'
         or commons_title ~ '^File:.' and length(commons_title) <= 400);

-- commons_sha1 is the sha1 of the stored bytes for a site photo.
-- (Same shape as before: 40 hex characters.)

alter table public.college_photos drop constraint if exists college_photos_license_check;
alter table public.college_photos
  add constraint college_photos_license_check
  check (
    length(license) <= 60
    and (
      source = 'site' and license = 'University website'
      or license !~* '\m(NC|ND)\M' and license ~* '^(CC0|Public domain|PD\M|CC BY(-SA)? [0-9])'
    )
  );

alter table public.college_photos drop constraint if exists college_photos_source_url_check;
alter table public.college_photos
  add constraint college_photos_source_url_check
  check (
    length(source_url) <= 2000
    and (
      source = 'site' and source_url ~ '^https?://'
      or source <> 'site' and source_url ~ '^https://commons\.wikimedia\.org/'
    )
  );
