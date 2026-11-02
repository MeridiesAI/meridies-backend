-- A weighted GPA on a 100-point scale can go up to 110 (Elvin, 2026-10-29):
-- schools that grade out of 100 add honors and AP points, so 103-107 is a
-- real weighted average. Every other scale keeps scale + 1, and unweighted
-- stays at most the scale (lib/gpa.ts gpaOverScale, the same rule in code).
--
-- Replaces student_academics_gpa_within_scale from 20261029000002, still NOT
-- VALID: new writes are checked, rows on file wait until
-- scripts/migrations/gpa-scale-violations.sql comes back empty and a later
-- migration validates it.
--
-- Deploy order: either. It only allows more than 20261029000002 did, so the
-- serving build is unaffected. Not in REQUIRED_SCHEMA.

alter table public.student_academics drop constraint if exists student_academics_gpa_within_scale;
alter table public.student_academics add constraint student_academics_gpa_within_scale check (
  coalesce(nullif(substring(gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)'), '')::numeric, 0) <= 0
  or (
    (gpa_unweighted is null or gpa_unweighted <= substring(gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric)
    and
    (gpa_weighted is null or gpa_weighted <=
       case when substring(gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric = 100 then 110
            else substring(gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric + 1 end)
  )
) not valid;

comment on constraint student_academics_gpa_within_scale on public.student_academics is
  'Unweighted up to the scale''s number; weighted up to it plus one, or 110 on a 100-point scale (lib/gpa.ts gpaOverScale). NOT VALID until existing rows are fixed.';
