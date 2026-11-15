-- One set of nodes for the 2D polygon and the 3D solid. Until now the solid drew Recs and six
-- detail nodes (Leadership, Awards, Service, Research, Arts, School fit) that were not polygon
-- axes, so deleting a node in either view changed nothing in the other. They are polygon axes now.
--
--   * Recs is a default axis, visible (the dashboard card and the solid already showed it).
--   * The six detail nodes are default axes, HIDDEN, so no student's 2D chart changes shape
--     until someone shows one. Their AI estimates are copied over from student_stat_nodes
--     (20261125000003), which stays in place and is no longer written.
--   * A polygon may now hold twelve visible axes (the cap trigger said ten).
--
-- Deploy order: this migration, then the API, then the app. The API and app read it; an app
-- deployed first draws the five-axis solid. Additive and idempotent.

create or replace function private.polygon_axes_enforce_cap()
returns trigger
language plpgsql
security invoker
set search_path to 'private','public','pg_temp'
as $function$
begin
  if new.hidden then
    return new;
  end if;
  if tg_op = 'UPDATE' and not old.hidden then
    return new;
  end if;

  if (
    select count(*)
    from public.student_polygon_axes a
    where a.student_id = new.student_id
      and not a.hidden
      and a.id <> new.id
  ) >= 12 then
    raise exception 'A polygon holds at most twelve axes' using errcode = '23514';
  end if;
  return new;
end;
$function$;

-- The defaults a student starts with: the five that were, plus Recs (shown) and the six detail nodes (hidden).
create or replace function public.ensure_default_polygon_axes(p_student uuid)
returns void
language plpgsql
security invoker
set search_path to 'public'
as $function$
begin
  if exists (select 1 from public.student_polygon_axes where student_id = p_student) then
    return;
  end if;

  insert into public.student_polygon_axes (student_id, key, label, description, sort_order, source, hidden)
  values
    (p_student, 'grades',           'Grades',           'Weighted GPA on a 4.5 scale',                              0, 'default', false),
    (p_student, 'testing',          'Testing',          'SAT superscore, or the ACT equivalent',                    1, 'default', false),
    (p_student, 'rigor',            'Rigor',            'AP, IB and college courses taken or planned',              2, 'default', false),
    (p_student, 'extracurriculars', 'Extracurriculars', 'Activities and awards, read together',                     3, 'default', false),
    (p_student, 'essays',           'Essays',           'How far the essays on file have come',                     4, 'default', false),
    (p_student, 'recs',             'Recs',             'Recommendation letters complete over assigned',            5, 'default', false),
    (p_student, 'leadership',       'Leadership',       'Positions held and what changed because of them',          6, 'default', true),
    (p_student, 'awards',           'Awards',           'Honors by level: school, state, national',                 7, 'default', true),
    (p_student, 'service',          'Service',          'Community service: hours, consistency, reach',             8, 'default', true),
    (p_student, 'research',         'Research',         'Research and independent inquiry, and its output',         9, 'default', true),
    (p_student, 'arts',             'Arts',             'Art, music, dance, theater or writing',                   10, 'default', true),
    (p_student, 'school-fit',       'School fit',       'How well the college list suits this student',            11, 'default', true)
  on conflict (student_id, key) do nothing;
end;
$function$;

-- Existing students: add what they lack. Hidden rows first (they never count toward the cap), then Recs.
insert into public.student_polygon_axes (student_id, key, label, description, sort_order, source, hidden, ai_score, ai_rationale, ai_scored_at)
select a.student_id, d.key, d.label, d.description, d.sort_order, 'default', true,
       n.ai_score, n.ai_rationale, n.ai_scored_at
from (select distinct student_id from public.student_polygon_axes) a
cross join (values
  ('leadership', 'Leadership', 'Positions held and what changed because of them',  6),
  ('awards',     'Awards',     'Honors by level: school, state, national',          7),
  ('service',    'Service',    'Community service: hours, consistency, reach',      8),
  ('research',   'Research',   'Research and independent inquiry, and its output', 9),
  ('arts',       'Arts',       'Art, music, dance, theater or writing',            10),
  ('school-fit', 'School fit', 'How well the college list suits this student',     11)
) as d(key, label, description, sort_order)
left join public.student_stat_nodes n on n.student_id = a.student_id and n.key = d.key
on conflict (student_id, key) do nothing;

insert into public.student_polygon_axes (student_id, key, label, description, sort_order, source, hidden)
select distinct student_id, 'recs', 'Recs', 'Recommendation letters complete over assigned', 5, 'default', false
from public.student_polygon_axes
on conflict (student_id, key) do nothing;
