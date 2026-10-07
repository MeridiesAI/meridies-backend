-- College search that scales and filters (BACKEND_TODO §3).
--
-- GET /colleges/search pulled up to 2,000 alias rows and filtered majors in
-- memory, which can't work on a ~3,000-school catalog. Search now runs in
-- Postgres: trigram and full-text indexes, and one function,
-- public.search_colleges, that ranks, filters, sorts and pages.
--
-- In Postgres rather than with embeddings: the AI rule is Anthropic only, and
-- Anthropic has no embeddings API.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- array_to_string isn't IMMUTABLE (element output can depend on settings), so a
-- generated column can't call it. For text[] it is, in practice.
create or replace function private.join_text(p text[])
returns text
language sql immutable parallel safe
as $$ select coalesce(array_to_string(p, ' '), '') $$;

-- Punctuation-free, lower-case, accent-free text: "St. John's" -> "st johns".
-- Matches lib/collegesV10.ts safeIlikeTerm, so both sides normalize the same way.
-- The two-argument unaccent names its dictionary, so the result doesn't depend
-- on search_path; that is what makes the IMMUTABLE label true.
create or replace function private.search_norm(p text)
returns text
language sql immutable parallel safe
as $$
  select btrim(regexp_replace(
           regexp_replace(lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p, ''))), '[''’]', '', 'g'),
           '[^[:alnum:]]+', ' ', 'g'))
$$;

create or replace function private.search_norm_all(p text[])
returns text[]
language sql immutable parallel safe
as $$ select coalesce(array(select private.search_norm(x) from unnest(p) x where x is not null), '{}') $$;

alter table public.colleges
  add column if not exists search_name text
    generated always as (private.search_norm(name)) stored,
  add column if not exists search_aka text
    generated always as (private.search_norm(private.join_text(aka))) stored,
  add column if not exists search_aka_list text[]
    generated always as (private.search_norm_all(aka)) stored,
  add column if not exists search_doc tsvector
    generated always as (
      setweight(to_tsvector('simple', private.search_norm(name)), 'A') ||
      setweight(to_tsvector('simple', private.search_norm(private.join_text(aka))), 'A') ||
      setweight(to_tsvector('simple', private.search_norm(coalesce(city, '') || ' ' || coalesce(state, ''))), 'C')
    ) stored;

create index if not exists colleges_search_doc_idx on public.colleges using gin (search_doc);
create index if not exists colleges_search_name_trgm_idx on public.colleges using gin (search_name extensions.gin_trgm_ops);
create index if not exists colleges_search_aka_trgm_idx on public.colleges using gin (search_aka extensions.gin_trgm_ops);
create index if not exists colleges_state_idx on public.colleges (state);
alter table public.college_fields_of_study
  add column if not exists search_title tsvector
    generated always as (to_tsvector('simple', private.search_norm(title))) stored;
create index if not exists college_fields_search_title_idx
  on public.college_fields_of_study using gin (search_title) where credential_level = 3;

-- ---------------------------------------------------------------------------
-- search_colleges
-- ---------------------------------------------------------------------------
--
-- p_q        free text; empty means "browse" (filters and sort only)
-- p_filters  jsonb, every key optional:
--   states        ["CA","NY"]
--   near          {"lat":..,"lng":..,"miles":..}  (from the school's coordinates)
--   enrollment    {"min":..,"max":..}             undergraduates
--   control       ["public","private","private-for-profit"]
--   admitRate     {"min":0..1,"max":0..1}
--   testPolicy    ["required","optional","blind","recommended"]
--   netPrice      {"max":dollars,"band":"0-30000"|"30001-48000"|"48001-75000"|"75001-110000"|"110001-plus"}
--   majors        ["1107", "computer science"]     CIP codes or words in a bachelor's program title
--   hbcu, hsi, womenOnly, religious               true to require
--   setting       ["city","suburb","town","rural"]
--   student       {"sat":1400,"gpa":3.8}           the student's numbers, for fit
--   fit           ["reach","target","likely"]     needs student
-- p_sort     relevance (default with p_q) | name | admit-rate | net-price | enrollment
-- p_limit    1..100
-- p_offset   0..
--
-- Returns one row per school: its id, how it matched (tier: 0 exact name or
-- alias, 1 name prefix, 2 word prefix, 3 trigram, 4 full text, 5 major,
-- 6 browse), a similarity score, the estimated odds and fit when a student was
-- given, its distance when `near` was, and the total before paging.
--
-- SECURITY INVOKER: it reads as the caller, under the catalog's RLS. VOLATILE
-- only because it sets the trigram thresholds for its transaction.

create or replace function public.search_colleges(
  p_q text default '',
  p_filters jsonb default '{}'::jsonb,
  p_sort text default null,
  p_limit integer default 48,
  p_offset integer default 0
)
returns table (
  college_id uuid,
  match_tier smallint,
  score real,
  odds numeric,
  fit text,
  miles numeric,
  total_count bigint
)
language plpgsql
volatile
security invoker
set search_path to 'public', 'extensions', 'private', 'pg_temp'
as $$
#variable_conflict use_column
begin
  -- The typo tier's thresholds, for this transaction only. (A function's own
  -- SET clause can't name a pg_trgm setting without superuser.)
  perform set_config('pg_trgm.similarity_threshold', '0.3', true);
  perform set_config('pg_trgm.word_similarity_threshold', '0.5', true);

  return query
with params as (
  select
    private.search_norm(left(coalesce(p_q, ''), 120)) as q,
    coalesce(p_filters, '{}'::jsonb) as f,
    greatest(1, least(coalesce(p_limit, 48), 100)) as lim,
    greatest(0, least(coalesce(p_offset, 0), 10000)) as off
),
qp as (
  select p.*,
    -- "uc berk" -> 'uc:* & berk:*' (every word, as a prefix)
    case when p.q = '' then null
         else to_tsquery('simple', array_to_string(array(
           select quote_literal(w) || ':*' from unnest(string_to_array(p.q, ' ')) w where w <> ''
         ), ' & ')) end as tsq,
    (p.f->'student'->>'sat')::numeric as student_sat,
    (p.f->'student'->>'gpa')::numeric as student_gpa,
    (p.f->'near'->>'lat')::float8 as near_lat,
    (p.f->'near'->>'lng')::float8 as near_lng,
    (p.f->'near'->>'miles')::float8 as near_miles,
    coalesce(p.f->'netPrice'->>'band', '') as band
  from params p
),
-- Schools with a bachelor's program whose title has every query word as a
-- prefix ("comp sci" -> Computer Science), found once through the GIN index.
major_hits as (
  select distinct fs.college_id
  from public.college_fields_of_study fs, qp
  where qp.tsq is not null and length(qp.q) >= 4
    and fs.credential_level = 3 and fs.search_title @@ qp.tsq
),
-- With a query, candidates come through the indexes, one branch each, and
-- only they are ranked below. Every tier's condition implies a branch:
-- prefixes and word prefixes are tsquery prefix matches, typos are trigram
-- or word-similarity matches, majors are major_hits.
candidates as (
  select c.id from public.colleges c, qp where qp.q <> '' and c.search_doc @@ qp.tsq
  union select c.id from public.colleges c, qp where qp.q <> '' and c.search_name % qp.q
  union select c.id from public.colleges c, qp where qp.q <> '' and qp.q <% c.search_name
  union select c.id from public.colleges c, qp where qp.q <> '' and qp.q <% c.search_aka
  union select college_id from major_hits
),
base as (
  select
    c.id,
    c.name,
    c.search_name,
    c.search_aka,
    c.search_aka_list,
    c.search_doc,
    c.state,
    coalesce(fa.test_policy, c.test_policy) as test_policy,
    coalesce(s.admit_rate, c.acceptance_rate) as admit_rate,
    coalesce(s.undergrad_enrollment, c.size) as enrollment,
    coalesce(s.control, c.control) as control,
    s.locale,
    s.hbcu, s.hsi, s.women_only, s.religious_affiliation,
    coalesce(s.latitude, lp.latitude) as lat,
    coalesce(s.longitude, lp.longitude) as lng,
    case when s.sat_total_25 is not null and s.sat_total_75 is not null
         then (s.sat_total_25 + s.sat_total_75) / 2.0 else lp.sat_mid end as sat_mid,
    lp.gpa_mid,
    s.avg_net_price,
    s.net_price_by_income
  from public.colleges c
  cross join qp
  left join public.college_stats s on s.college_id = c.id
  left join public.college_list_profiles lp on lp.college_id = c.id
  left join public.college_admission_factors fa on fa.college_id = c.id
  where qp.q = '' or c.id in (select id from candidates)
),
matched as (
  select b.*,
    case
      when qp.q = '' then 6
      when b.search_name = qp.q or qp.q = any(b.search_aka_list) then 0
      when b.search_name like qp.q || '%' or exists (select 1 from unnest(b.search_aka_list) a where a like qp.q || '%') then 1
      -- q is letters, digits and single spaces (search_norm), so it is safe in a regex.
      when b.search_name ~ ('\m' || qp.q) or b.search_aka ~ ('\m' || qp.q) then 2
      -- Typos ("berkly"): the query against the best-matching words of the name.
      when length(qp.q) >= 3 and (
        word_similarity(qp.q, b.search_name) >= 0.5 or word_similarity(qp.q, b.search_aka) >= 0.5
        or similarity(b.search_name, qp.q) >= 0.3) then 3
      when b.search_doc @@ qp.tsq then 4
      when b.id in (select college_id from major_hits) then 5
      else null
    end::smallint as tier,
    case when qp.q = '' then 0
         else greatest(similarity(b.search_name, qp.q), word_similarity(qp.q, b.search_name),
                       similarity(b.search_aka, qp.q), word_similarity(qp.q, b.search_aka)) end::real as sim,
    case when qp.near_lat is null or b.lat is null then null
         else 3959 * 2 * asin(sqrt(
           power(sin(radians(b.lat - qp.near_lat) / 2), 2) +
           cos(radians(qp.near_lat)) * cos(radians(b.lat)) * power(sin(radians(b.lng - qp.near_lng) / 2), 2)
         )) end as dist,
    -- lib/collegesV10.ts studentOdds, the same formula: the admit rate, lifted
    -- or lowered by the student's SAT and GPA against the school's middle.
    case when b.admit_rate is null or (qp.student_sat is null and qp.student_gpa is null) then null
         else greatest(0.5, least(94, (b.admit_rate * 100) * exp(
           0.35 * coalesce((qp.student_sat - b.sat_mid) / 80, 0) +
           0.35 * coalesce((qp.student_gpa - b.gpa_mid) / 0.2, 0)
         ))) end as est_odds,
    case when b.net_price_by_income ? qp.band then (b.net_price_by_income->>qp.band)::numeric
         else b.avg_net_price end as net_price
  from base b cross join qp
),
fitted as (
  select m.*,
    case when (select student_sat from qp) is null and (select student_gpa from qp) is null then null
         when m.est_odds is null or coalesce(m.admit_rate, 0) < 0.15 or m.est_odds < 35 then 'reach'
         when m.est_odds < 70 then 'target'
         else 'likely' end as est_fit
  from matched m
),
filtered as (
  select fi.* from fitted fi cross join qp
  where fi.tier is not null
    and (not (qp.f ? 'states') or fi.state = any(array(select jsonb_array_elements_text(qp.f->'states'))))
    and (qp.near_lat is null or (fi.dist is not null and fi.dist <= coalesce(qp.near_miles, 100)))
    and (not (qp.f ? 'enrollment') or (
          fi.enrollment is not null
          and fi.enrollment >= coalesce((qp.f->'enrollment'->>'min')::int, 0)
          and fi.enrollment <= coalesce((qp.f->'enrollment'->>'max')::int, 2147483647)))
    and (not (qp.f ? 'control') or fi.control = any(array(select jsonb_array_elements_text(qp.f->'control'))))
    and (not (qp.f ? 'admitRate') or (
          fi.admit_rate is not null
          and fi.admit_rate >= coalesce((qp.f->'admitRate'->>'min')::numeric, 0)
          and fi.admit_rate <= coalesce((qp.f->'admitRate'->>'max')::numeric, 1)))
    and (not (qp.f ? 'testPolicy') or fi.test_policy = any(array(select jsonb_array_elements_text(qp.f->'testPolicy'))))
    and (not (qp.f ? 'netPrice') or (fi.net_price is not null and fi.net_price <= (qp.f->'netPrice'->>'max')::numeric))
    and (not (qp.f ? 'majors') or exists (
          select 1 from public.college_fields_of_study fs, jsonb_array_elements_text(qp.f->'majors') want
          where fs.college_id = fi.id and fs.credential_level = 3
            and (fs.cip_code = want or lower(fs.title) like '%' || private.search_norm(want) || '%')))
    and (coalesce((qp.f->>'hbcu')::boolean, false) = false or fi.hbcu)
    and (coalesce((qp.f->>'hsi')::boolean, false) = false or fi.hsi)
    and (coalesce((qp.f->>'womenOnly')::boolean, false) = false or fi.women_only)
    and (coalesce((qp.f->>'religious')::boolean, false) = false or (fi.religious_affiliation is not null and fi.religious_affiliation > 0))
    and (not (qp.f ? 'setting') or (fi.locale / 10) = any(array(
          select case s when 'city' then 1 when 'suburb' then 2 when 'town' then 3 when 'rural' then 4 end
          from jsonb_array_elements_text(qp.f->'setting') s)))
    and (not (qp.f ? 'fit') or fi.est_fit = any(array(select jsonb_array_elements_text(qp.f->'fit'))))
)
select
  fl.id, fl.tier, fl.sim, round(fl.est_odds, 1), fl.est_fit, round(fl.dist::numeric, 1),
  count(*) over ()
from filtered fl cross join qp
order by
  case when coalesce(p_sort, case when qp.q = '' then 'name' else 'relevance' end) = 'relevance' then fl.tier end,
  case when coalesce(p_sort, case when qp.q = '' then 'name' else 'relevance' end) = 'relevance' then fl.sim end desc,
  case when p_sort = 'admit-rate' then fl.admit_rate end asc nulls last,
  case when p_sort = 'net-price' then fl.net_price end asc nulls last,
  case when p_sort = 'enrollment' then fl.enrollment end desc nulls last,
  case when p_sort = 'distance' then fl.dist end asc nulls last,
  fl.name
limit (select lim from qp) offset (select off from qp);
end;
$$;

revoke all on function public.search_colleges(text, jsonb, text, integer, integer) from public, anon;
grant execute on function public.search_colleges(text, jsonb, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- match_college_names: hand-typed list names ("UPenn", "U Michigan") to
-- catalog ids, for /colleges/recommended, without loading the catalog.
-- ---------------------------------------------------------------------------

create or replace function public.match_college_names(p_names text[])
returns table (name text, college_id uuid)
language plpgsql
volatile
security invoker
set search_path to 'public', 'extensions', 'private', 'pg_temp'
as $$
#variable_conflict use_column
begin
  perform set_config('pg_trgm.similarity_threshold', '0.45', true);
  return query
  select n.name, best.id
  from unnest(p_names) as n(name)
  cross join lateral (
    select c.id
    from public.colleges c
    where c.search_name = private.search_norm(n.name)
       or private.search_norm(n.name) = any(c.search_aka_list)
       -- "Cal Tech" for "Caltech": the same letters without the spaces.
       or replace(private.search_norm(n.name), ' ', '') = any(array(select replace(a, ' ', '') from unnest(c.search_aka_list) a))
       or c.search_name % private.search_norm(n.name)
    order by (c.search_name = private.search_norm(n.name) or private.search_norm(n.name) = any(c.search_aka_list)) desc,
             (replace(private.search_norm(n.name), ' ', '') = any(array(select replace(a, ' ', '') from unnest(c.search_aka_list) a))) desc,
             similarity(c.search_name, private.search_norm(n.name)) desc
    limit 1
  ) best;
end;
$$;

revoke all on function public.match_college_names(text[]) from public, anon;
grant execute on function public.match_college_names(text[]) to authenticated;

-- The names counselors actually type for the curated schools that had none.
update public.colleges c set aka = m.aka
from (values
  ('penn', array['Penn', 'UPenn']), ('columbia', array['Columbia']), ('cornell', array['Cornell']),
  ('brown', array['Brown']), ('yale', array['Yale']), ('dartmouth', array['Dartmouth']),
  ('jhu', array['JHU', 'Johns Hopkins', 'Hopkins']), ('cmu', array['CMU', 'Carnegie Mellon']),
  ('cwru', array['CWRU', 'Case Western']), ('bu', array['BU']), ('boston-college', array['BC']),
  ('northeastern', array['NEU']), ('tufts', array['Tufts']), ('penn-state', array['Penn State', 'PSU']),
  ('ohio-state', array['Ohio State', 'OSU']), ('pitt', array['Pitt']), ('rit', array['RIT']),
  ('rutgers', array['Rutgers']), ('uvm', array['UVM']), ('buffalo', array['UB', 'SUNY Buffalo']),
  ('stony-brook', array['SBU', 'SUNY Stony Brook']), ('binghamton', array['SUNY Binghamton']),
  ('rochester', array['UR', 'U of R']), ('syracuse', array['Cuse', 'SU'])
) as m(slug, aka)
where c.slug = m.slug and c.aka = '{}';

-- ---------------------------------------------------------------------------
-- college_search_facets: the values each search filter can take, with how
-- many schools have each, for GET /colleges/filters.
-- ---------------------------------------------------------------------------

create or replace function public.college_search_facets()
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
  with b as (
    select c.state,
           coalesce(s.control, c.control) as control,
           coalesce(fa.test_policy, c.test_policy) as test_policy,
           case s.locale / 10 when 1 then 'city' when 2 then 'suburb' when 3 then 'town' when 4 then 'rural' end as setting,
           s.hbcu, s.hsi, s.women_only, s.religious_affiliation
    from public.colleges c
    left join public.college_stats s on s.college_id = c.id
    left join public.college_admission_factors fa on fa.college_id = c.id
  )
  select jsonb_build_object(
    'total', (select count(*) from b),
    'states', (select coalesce(jsonb_object_agg(state, n order by state), '{}') from (select state, count(*) n from b where state is not null group by state) x),
    'control', (select coalesce(jsonb_object_agg(control, n), '{}') from (select control, count(*) n from b where control is not null group by control) x),
    'testPolicy', (select coalesce(jsonb_object_agg(test_policy, n), '{}') from (select test_policy, count(*) n from b where test_policy is not null group by test_policy) x),
    'setting', (select coalesce(jsonb_object_agg(setting, n), '{}') from (select setting, count(*) n from b where setting is not null group by setting) x),
    'hbcu', (select count(*) from b where hbcu),
    'hsi', (select count(*) from b where hsi),
    'womenOnly', (select count(*) from b where women_only),
    'religious', (select count(*) from b where religious_affiliation > 0),
    'netPriceBands', '["0-30000","30001-48000","48001-75000","75001-110000","110001-plus"]'::jsonb
  );
$$;

revoke all on function public.college_search_facets() from public, anon;
grant execute on function public.college_search_facets() to authenticated;
