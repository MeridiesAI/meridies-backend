-- Research: take the research model's leaked markup out of rows already stored.
--
-- The research model sometimes writes its citation wrappers into its answer as plain text
-- (`<cite index="3-1">...</cite>`, or `<cite index=\"3-1\">` escaped inside a JSON string), plus other stray
-- XML-like tags and `[S1]`-style source markers. Until the parser change in this PR they were stored as-is, so a
-- suggestion read "Cost: <cite index=\"...\">There is no application fee.</cite>". The code now strips them before
-- anything is stored (`stripModelMarkup` in src/lib/research/prompt.ts); this cleans what is already there, with the
-- same rule: the tags and markers go, the words inside a tag stay, whitespace is collapsed. A tag is `<`, a letter,
-- and no `<` or `>` before its `>`, so "<5%" is left alone.
--
-- What it touches: recommendations.title / why / details.deadline / details.cost / sources[].title, and the
-- things an accepted recommendation created from that text: the hidden task's title and instructions
-- (deliverables, by recommendations.accepted_as) and the college-list row's name (student_colleges, same).
-- Only rows that hold markup are updated. A title that would be empty after stripping is left as it was (the
-- title CHECK needs 1 to 300 characters).
--
-- Idempotent: a second run finds nothing to change (the WHERE clauses only match text that still holds markup).
-- Data only: no schema change, no grants, nothing to add to REQUIRED_SCHEMA. Deploy order: either way round; the
-- old code keeps working on cleaned rows and the new code never writes markup.

create or replace function private.research_strip_markup(t text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case when t is null then null else btrim(regexp_replace(
    regexp_replace(
      regexp_replace(t, '</?[A-Za-z][A-Za-z0-9_:.-]*([[:space:]][^<>]*)?/?>', '', 'g'),
      '[ \t]?\[S[0-9]+([[:space:]]*[,-][[:space:]]*S?[0-9]+)*\]', '', 'g'),
    '[[:space:]]+', ' ', 'g')) end
$$;

create or replace function private.research_has_markup(t text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(t ~ '</?[A-Za-z][A-Za-z0-9_:.-]*([[:space:]][^<>]*)?/?>' or t ~ '\[S[0-9]+([[:space:]]*[,-][[:space:]]*S?[0-9]+)*\]', false)
$$;

-- The college-list rows and hidden tasks made from a dirty recommendation, before the recommendation is cleaned.
update public.student_colleges sc
   set name = coalesce(nullif(private.research_strip_markup(sc.name), ''), sc.name)
  from public.recommendations r
 where r.accepted_as ->> 'type' = 'student_college'
   and sc.id::text = r.accepted_as ->> 'id'
   and private.research_has_markup(sc.name);

-- Instructions keep their line breaks (why, Sources, the verify line): only tags and markers go there.
update public.deliverables d
   set title = coalesce(nullif(private.research_strip_markup(d.title), ''), d.title),
       instructions = regexp_replace(
         regexp_replace(d.instructions, '</?[A-Za-z][A-Za-z0-9_:.-]*([[:space:]][^<>]*)?/?>', '', 'g'),
         '[ \t]?\[S[0-9]+([[:space:]]*[,-][[:space:]]*S?[0-9]+)*\]', '', 'g')
  from public.recommendations r
 where r.accepted_as ->> 'type' = 'task'
   and d.id::text = r.accepted_as ->> 'id'
   and (private.research_has_markup(d.title) or private.research_has_markup(d.instructions));

update public.recommendations r
   set title = coalesce(nullif(private.research_strip_markup(r.title), ''), r.title),
       why = private.research_strip_markup(r.why),
       details = r.details
         || case when jsonb_typeof(r.details -> 'deadline') = 'string'
                 then jsonb_build_object('deadline', private.research_strip_markup(r.details ->> 'deadline')) else '{}'::jsonb end
         || case when jsonb_typeof(r.details -> 'cost') = 'string'
                 then jsonb_build_object('cost', private.research_strip_markup(r.details ->> 'cost')) else '{}'::jsonb end,
       sources = case when jsonb_typeof(r.sources) = 'array' then (
         select coalesce(jsonb_agg(
                  case when jsonb_typeof(s -> 'title') = 'string'
                       then s || jsonb_build_object('title', private.research_strip_markup(s ->> 'title')) else s end
                  order by ord), '[]'::jsonb)
           from jsonb_array_elements(r.sources) with ordinality as e(s, ord)) else r.sources end
 where private.research_has_markup(r.title)
    or private.research_has_markup(r.why)
    or private.research_has_markup(r.details ->> 'deadline')
    or private.research_has_markup(r.details ->> 'cost')
    or (jsonb_typeof(r.sources) = 'array' and exists (
          select 1 from jsonb_array_elements(r.sources) s where private.research_has_markup(s ->> 'title')));

drop function if exists private.research_strip_markup(text);
drop function if exists private.research_has_markup(text);
