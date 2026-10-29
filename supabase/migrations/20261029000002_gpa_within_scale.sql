-- A GPA can't be above its scale (bug hunt 2026-10-28, S2-M2).
--
-- `student_academics_gpa_range` (20261014000001) allows up to 10, or 110 on a
-- scale starting "100", whatever the scale says, so a 9.9 sat on a "4.0
-- scale" card. This adds the rule against the number the scale names:
-- unweighted up to the scale, weighted up to the scale plus one. A scale with
-- no number ("weighted", null) is checked by the older constraint only.
--
-- NOT VALID: every new write is checked from the moment this applies, and
-- rows already on file are left alone until they are fixed. List them with
-- scripts/migrations/gpa-scale-violations.sql (read-only), fix them, then a
-- later migration runs
--   alter table public.student_academics validate constraint student_academics_gpa_within_scale;
--
-- The same rule is in code (lib/gpa.ts gpaOverScale), so the profile editor,
-- the records route and the import's "Needs a fix" say what's wrong in words
-- before the database would refuse it.
--
-- Deploy order: either. With the code first, the routes refuse over-scale
-- GPAs and nothing reads the constraint. With this first, the serving build's
-- writes of an over-scale GPA fail with a generic error (as an out-of-range
-- value already does). Not in REQUIRED_SCHEMA.

alter table public.student_academics drop constraint if exists student_academics_gpa_within_scale;
alter table public.student_academics add constraint student_academics_gpa_within_scale check (
  coalesce(nullif(substring(gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)'), '')::numeric, 0) <= 0
  or (
    (gpa_unweighted is null or gpa_unweighted <= substring(gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric)
    and
    (gpa_weighted is null or gpa_weighted <= substring(gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric + 1)
  )
) not valid;

comment on constraint student_academics_gpa_within_scale on public.student_academics is
  'Unweighted up to the scale''s number, weighted up to it plus one (lib/gpa.ts gpaOverScale). NOT VALID until existing rows are fixed.';
