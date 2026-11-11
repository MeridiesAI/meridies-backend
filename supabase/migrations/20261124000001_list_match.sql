-- List-match scoring (lib/listMatch.ts, lib/listMatchLoad.ts), used only while LIST_MATCH_ENABLED=true.
--
--   student_interest_embeddings   one row per student: the embedding of their interest paragraph (built from their
--                                 record by lib/listMatch.ts interestParagraph) and the sha256 of the model name and
--                                 that paragraph, so a student is embedded again only when the paragraph changes.
--                                 Service role only, like list_builder_impressions: no grants and no policies for
--                                 anon or authenticated. Deleting the student's account deletes the row.
--   match_college_opportunities() for a list of colleges and one vector: each college's best K active
--                                 opportunities by cosine similarity, each similarity times its category's prior
--                                 weight. The weights are passed in (lib/listContract.ts OPPORTUNITY_CATEGORIES), so
--                                 the numbers live in one place; an opportunity whose category has no weight is left
--                                 out. SECURITY INVOKER: it reads college_opportunities as the caller, under its RLS
--                                 and the approval gate.
--
-- Neither is in the data export: the export reads as the caller under RLS and no client can read the embeddings
-- (a vector, not text; the paragraph itself is never stored).
--
-- Deploy order: either. Before this file, with the flag on, the list builder ranks by core features only (the
-- RPC is missing, so there is no opportunity score) and nothing is cached; with the flag off nothing reads either.
-- With this file and the previous build, nothing calls them. Not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- 1. student_interest_embeddings
-- ---------------------------------------------------------------------------

create table if not exists public.student_interest_embeddings (
  student_id    uuid primary key references public.profiles(id) on delete cascade,
  -- sha256 hex of "<model>\n<paragraph>".
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  model         text not null check (length(model) between 1 and 200),
  embedding     extensions.vector(384) not null,
  updated_at    timestamptz not null default now()
);

alter table public.student_interest_embeddings enable row level security;
revoke all on public.student_interest_embeddings from public, anon, authenticated;
grant all on public.student_interest_embeddings to service_role;
select private.attach_approval_gate('public.student_interest_embeddings');

-- ---------------------------------------------------------------------------
-- 2. match_college_opportunities
-- ---------------------------------------------------------------------------

create or replace function public.match_college_opportunities(
  p_college_ids uuid[],
  -- The student's interest vector in pgvector's text form, "[0.1,0.2,...]", 384 numbers.
  p_embedding   text,
  -- {"<category>": <prior weight>, ...}
  p_weights     jsonb,
  p_top_k       integer
)
returns table (
  college_id     uuid,
  opportunity_id uuid,
  name           text,
  category       text,
  quote          text,
  source_url     text,
  similarity     double precision,
  weighted       double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select p_embedding::extensions.vector(384) as v
  ),
  ids as (
    -- At most 200 colleges a call (the code sends 100); duplicates once.
    select distinct x.id from unnest(p_college_ids[1:200]) as x(id) where x.id is not null
  )
  select ids.id, o.id, o.name, o.category, o.quote, o.source_url, o.similarity,
         o.similarity * (p_weights ->> o.category)::double precision
  from ids
  cross join q
  cross join lateral (
    select op.id, op.name, op.category, op.quote, op.source_url,
           1 - (op.embedding operator(extensions.<=>) q.v) as similarity
    from public.college_opportunities op
    where op.college_id = ids.id
      and op.active
      and op.embedding is not null
      and op.category is not null
      and jsonb_typeof(p_weights -> op.category) = 'number'
    order by op.embedding operator(extensions.<=>) q.v, op.id
    limit least(greatest(coalesce(p_top_k, 1), 1), 20)
  ) o
$$;

comment on function public.match_college_opportunities(uuid[], text, jsonb, integer) is
  'List-match scoring: each college''s top K active opportunities by cosine similarity to one vector, each times its category''s prior weight (passed in). SECURITY INVOKER: reads as the caller.';

revoke all on function public.match_college_opportunities(uuid[], text, jsonb, integer) from public, anon;
grant execute on function public.match_college_opportunities(uuid[], text, jsonb, integer) to authenticated, service_role;
