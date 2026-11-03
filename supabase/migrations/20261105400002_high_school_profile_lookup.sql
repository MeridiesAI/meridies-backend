-- High school profile lookup (QA round 10).
--
-- The info card's high school row can open the school's own published profile
-- (school_profile_url, which already exists). When none is on file, the app's
-- "Find school profile" asks the API to look for it with cited web research;
-- a URL is kept only when the research actually cited it, saw it, and the link
-- answers. profile_lookup_at records when it last looked, so a school with no
-- published profile isn't searched again for 30 days.
--
-- Only the API writes it (service role, after the caller has shown the school
-- is their own or their student's); high_schools keeps its read-only RLS for
-- clients, so no grant or policy changes here.
--
-- Deploy order: either. Without this file the lookup still runs and still
-- stores a found URL on school_profile_url; it just doesn't remember a search
-- that found nothing (each try spends one research call, under the route's
-- rate limit). Not in REQUIRED_SCHEMA.

alter table public.high_schools
  add column if not exists profile_lookup_at timestamptz;
