-- Check the GPA-within-scale rule against existing rows too.
-- 20261029000002 added student_academics_gpa_within_scale NOT VALID (new writes
-- only); 20261029000004 widened 100-point weighted to 110. Production's rows were
-- cleaned with scripts/migrations/gpa-scale-violations.sql (0 rows, 2026-11-02).
-- If a row still breaks the rule, this fails and changes nothing: run that
-- script, fix the rows, push again.
alter table public.student_academics
  validate constraint student_academics_gpa_within_scale;
