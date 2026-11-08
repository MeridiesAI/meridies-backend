-- Curated college data (item 16, part 2): cited proposals from a school's own pages.
--
-- Extends catalog_change_proposals (20261007000005) rather than adding a sibling
-- table: its RLS (proposer or catalog editor reads; no client writes), approval
-- gate, editor list and review route already say what a proposal is, and the
-- three new kinds fit it with three nullable columns. A second table would
-- need a second list and review flow that the editor must check twice.
--
-- New kinds of proposal (written by lib/catalogProposals.ts, service role):
--   personal_statement_read  'true' | 'false'
--   test_reporting           'official-only' | 'self-report' | 'score-send' | 'not-applicable'
--   supplement               payload {cycle, sortOrder, title, prompt, wordLimit};
--                            proposed_value is '<cycle>#<sortOrder>' (the slot)
-- Each new-kind row must carry an https source_url, the verbatim quote it rests
-- on (evidence, 12+ characters), its admission_cycle and fact_key (sha256 hex of
-- college, cycle, field and value). One pending or approved row per fact_key per
-- school: the same fact is never proposed twice while one is waiting or was
-- accepted (a rejected one may come back on a later run).
--
-- review_catalog_proposal(id, decision, note): the review, in ONE transaction.
-- Only a catalog editor (auth.uid() in catalog_editors) may call it. It locks
-- the row (and, for a supplement, takes a per-school-and-cycle advisory lock so
-- concurrent supplement approvals run their checks one after another),
-- refuses one already reviewed, re-checks the value or payload, and on
-- approve writes the curated row: college_supplements (its slot, with
-- source_url and source_verified_at = now(); refused when the slot holds a
-- different prompt or the prompt is on file at another slot, so an approval
-- never overwrites a row students' essays point to; the proposer assigns a
-- new prompt the next free slot itself, never the model), college_policies
-- (only that column, plus sources.<field> = {url, checkedAt, verifiedAt,
-- verifiedBy};
-- provenance stays 'curated') or colleges.test_policy; then stamps the status,
-- reviewed_by and reviewed_at. A reject changes only the proposal.
--
-- RLS and grants are unchanged (the table already has RLS, the approval gate
-- and no client writes). The ai_runs label 'catalog-proposals' is added the
-- additive way.
--
-- Deploy order: either. Before this file the API's review falls back to its
-- older path for the six research fields (no new-kind rows can exist), and the
-- proposer's inserts fail (the CHECK refuses the new fields), so the machine
-- route reports a failed run and writes nothing. Not in REQUIRED_SCHEMA.

alter table public.catalog_change_proposals
  add column if not exists admission_cycle text,
  add column if not exists payload jsonb,
  add column if not exists fact_key text;

alter table public.catalog_change_proposals drop constraint if exists catalog_change_proposals_field_check;
alter table public.catalog_change_proposals add constraint catalog_change_proposals_field_check check (field in (
  'test_policy', 'superscore', 'self_report_scores', 'css_profile_required', 'stars_required', 'fairtest_status',
  'personal_statement_read', 'test_reporting', 'supplement'));

alter table public.catalog_change_proposals drop constraint if exists catalog_change_proposals_cycle_check;
alter table public.catalog_change_proposals add constraint catalog_change_proposals_cycle_check
  check (admission_cycle is null or admission_cycle ~ '^\d{4}-\d{4}$');

alter table public.catalog_change_proposals drop constraint if exists catalog_change_proposals_fact_key_check;
alter table public.catalog_change_proposals add constraint catalog_change_proposals_fact_key_check
  check (fact_key is null or fact_key ~ '^[0-9a-f]{64}$');

alter table public.catalog_change_proposals drop constraint if exists catalog_change_proposals_payload_check;
alter table public.catalog_change_proposals add constraint catalog_change_proposals_payload_check
  check ((field = 'supplement') = (payload is not null) and (payload is null or jsonb_typeof(payload) = 'object'));

-- The new kinds are cited: https, a quote, the cycle and the key.
alter table public.catalog_change_proposals drop constraint if exists catalog_change_proposals_cited_check;
alter table public.catalog_change_proposals add constraint catalog_change_proposals_cited_check
  check (field not in ('personal_statement_read', 'test_reporting', 'supplement')
         or (source_url ~ '^https://' and evidence is not null and length(btrim(evidence)) >= 12
             and admission_cycle is not null and fact_key is not null));

create unique index if not exists catalog_change_proposals_fact_key_open
  on public.catalog_change_proposals (college_id, fact_key)
  where fact_key is not null and status in ('pending', 'approved');

comment on column public.catalog_change_proposals.payload is
  'A supplement proposal''s prompt: {cycle, sortOrder, title, prompt, wordLimit}. Null for every other field.';
comment on column public.catalog_change_proposals.fact_key is
  'sha256 hex of (college, cycle, field, value): one pending or approved row per fact (lib/catalogProposals.ts factKey).';

-- ---------------------------------------------------------------------------
-- The review, in one transaction
-- ---------------------------------------------------------------------------

create or replace function public.review_catalog_proposal(p_id uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_now    timestamptz := now();
  r        public.catalog_change_proposals%rowtype;
  v_status text;
  v_p      jsonb;
  v_sort   numeric;
  v_limit  numeric;
  v_title  text;
  v_prompt text;
  v_src    jsonb;
begin
  if v_uid is null or not private.is_catalog_editor(v_uid) then
    raise exception 'Only a Meridies catalog editor can review catalog changes' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject' using errcode = '22023';
  end if;

  select * into r from public.catalog_change_proposals where id = p_id for update;
  if not found then
    raise exception 'That proposal doesn''t exist' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'That proposal was already reviewed' using errcode = '55000';
  end if;

  if p_decision = 'approve' then
    if r.field = 'supplement' then
      -- One supplement approval at a time per school and cycle: a second one waits here, then runs its slot and
      -- duplicate checks against what the first committed, so two approvals can't both pass them and overwrite
      -- or double-file a prompt. Released at the end of the transaction.
      perform pg_advisory_xact_lock(hashtext('catalog-supp:' || r.college_id::text || ':' || coalesce(r.admission_cycle, '')));
      v_p := r.payload;
      if v_p is null or jsonb_typeof(v_p) <> 'object'
         or v_p ->> 'cycle' is distinct from r.admission_cycle
         or jsonb_typeof(v_p -> 'sortOrder') <> 'number'
         or jsonb_typeof(v_p -> 'title') <> 'string'
         or jsonb_typeof(v_p -> 'prompt') <> 'string'
         or coalesce(jsonb_typeof(v_p -> 'wordLimit'), 'null') not in ('number', 'null')
         or r.source_url !~ '^https://' then
        raise exception 'That proposal''s supplement isn''t valid' using errcode = '22023';
      end if;
      v_sort := (v_p ->> 'sortOrder')::numeric;
      v_limit := (v_p ->> 'wordLimit')::numeric;
      v_title := btrim(v_p ->> 'title');
      v_prompt := btrim(v_p ->> 'prompt');
      if v_sort <> trunc(v_sort) or v_sort not between 0 and 50
         or length(v_title) not between 1 and 120 or length(v_prompt) not between 1 and 2000
         or (v_limit is not null and (v_limit <> trunc(v_limit) or v_limit not between 1 and 5000)) then
        raise exception 'That proposal''s supplement isn''t valid' using errcode = '22023';
      end if;
      -- The slot the open-proposal index keys on is the slot written.
      if r.proposed_value is distinct from r.admission_cycle || '#' || v_sort::integer::text then
        raise exception 'That proposal''s supplement isn''t valid' using errcode = '22023';
      end if;
      -- Never overwrite a different prompt (students' essays point at these rows), and never file the same
      -- prompt twice under another slot. Prompts compare case- and white-space-folded.
      if exists (select 1 from public.college_supplements s
                  where s.college_id = r.college_id and s.admission_cycle = r.admission_cycle and s.sort_order = v_sort
                    and lower(regexp_replace(btrim(s.prompt), '\s+', ' ', 'g')) <> lower(regexp_replace(v_prompt, '\s+', ' ', 'g'))) then
        raise exception 'That slot already holds a different prompt' using errcode = '22023';
      end if;
      if exists (select 1 from public.college_supplements s
                  where s.college_id = r.college_id and s.admission_cycle = r.admission_cycle and s.sort_order <> v_sort
                    and lower(regexp_replace(btrim(s.prompt), '\s+', ' ', 'g')) = lower(regexp_replace(v_prompt, '\s+', ' ', 'g'))) then
        raise exception 'That prompt is already on file' using errcode = '22023';
      end if;
      insert into public.college_supplements (college_id, admission_cycle, sort_order, title, prompt, word_limit, source_url, source_verified_at)
      values (r.college_id, r.admission_cycle, v_sort::integer, v_title, v_prompt, v_limit::integer, r.source_url, v_now)
      on conflict (college_id, admission_cycle, sort_order) do update
        set title = excluded.title, prompt = excluded.prompt, word_limit = excluded.word_limit,
            source_url = excluded.source_url, source_verified_at = excluded.source_verified_at;

    elsif r.field = 'test_policy' then
      if r.proposed_value not in ('required', 'optional', 'blind', 'recommended') then
        raise exception 'That proposal''s value isn''t allowed' using errcode = '22023';
      end if;
      update public.colleges set test_policy = r.proposed_value where id = r.college_id;

    else
      if not (
        (r.field in ('self_report_scores', 'css_profile_required', 'stars_required', 'personal_statement_read') and r.proposed_value in ('true', 'false'))
        or (r.field = 'superscore' and r.proposed_value in ('sat', 'act', 'both', 'none'))
        or (r.field = 'fairtest_status' and r.proposed_value in ('required', 'optional', 'blind', 'flexible'))
        or (r.field = 'test_reporting' and r.proposed_value in ('official-only', 'self-report', 'score-send', 'not-applicable'))
      ) then
        raise exception 'That proposal''s value isn''t allowed' using errcode = '22023';
      end if;
      v_src := jsonb_build_object(r.field, jsonb_build_object(
        'url', r.source_url,
        'checkedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD'),
        'verifiedAt', v_now,
        'verifiedBy', v_uid));
      -- Only this column (and its source) changes; a school with no row gets one.
      execute format(
        'insert into public.college_policies (college_id, %1$I, sources, updated_at) values ($1, $2::%2$s, $3, $4)
           on conflict (college_id) do update
             set %1$I = excluded.%1$I, sources = public.college_policies.sources || excluded.sources, updated_at = excluded.updated_at',
        r.field,
        case when r.field in ('self_report_scores', 'css_profile_required', 'stars_required', 'personal_statement_read') then 'boolean' else 'text' end)
      using r.college_id, r.proposed_value, v_src, v_now;
    end if;
  end if;

  v_status := case when p_decision = 'approve' then 'approved' else 'rejected' end;
  update public.catalog_change_proposals
     set status = v_status, reviewed_by = v_uid, reviewed_at = v_now, review_note = left(p_note, 500)
   where id = p_id;
  return jsonb_build_object('id', p_id, 'status', v_status);
end;
$$;

revoke all on function public.review_catalog_proposal(uuid, text, text) from public, anon;
grant execute on function public.review_catalog_proposal(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- ai_runs.module: 'catalog-proposals', added without dropping another label
-- ---------------------------------------------------------------------------

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if 'catalog-proposals' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'catalog-proposals'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
