-- Read-only: GPAs on file above their scale (student_academics_gpa_within_scale,
-- 20261028000005). Fix these, then VALIDATE the constraint in a later migration.
-- Run in the Supabase SQL editor; it changes nothing.
select a.student_id,
       p.full_name,
       a.gpa_scale,
       a.gpa_unweighted,
       a.gpa_weighted,
       substring(a.gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric as scale_number
from public.student_academics a
join public.profiles p on p.id = a.student_id
where coalesce(nullif(substring(a.gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)'), '')::numeric, 0) > 0
  and (
    a.gpa_unweighted > substring(a.gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric
    or a.gpa_weighted > substring(a.gpa_scale from '^\s*([0-9]+(?:\.[0-9]+)?)')::numeric + 1
  )
order by p.full_name;
