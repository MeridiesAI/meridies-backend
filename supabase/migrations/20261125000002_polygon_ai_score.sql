-- AI-estimated polygon axes: a counselor's "Estimate with AI" click stores a 0-100
-- read of each axis, with the reason, beside the formula's auto_score. Precedence
-- is manual_score > ai_score > auto_score, so a counselor's typed number always
-- wins and clearing it falls back to the AI's read, then the formula.
--
-- `score` is a stored generated column, so its expression can only change by
-- dropping and re-adding it (the table is one row per axis per student; the
-- rewrite is trivial). The history trigger reads `score`, so an AI estimate that
-- moves an axis is recorded like any other movement.
--
-- Deploy order: this migration first. The app and API read the new columns, but
-- nothing breaks without them until someone clicks the button (the update fails).
-- Not in REQUIRED_SCHEMA.

alter table public.student_polygon_axes
  add column if not exists ai_score      numeric(6,2) check (ai_score >= 0),
  add column if not exists ai_rationale  text check (length(ai_rationale) <= 600),
  add column if not exists ai_scored_at  timestamptz;

comment on column public.student_polygon_axes.ai_score is
  'The AI estimate (Estimate with AI). Wins over auto_score, loses to manual_score. Null when never run or the model said there was too little data.';

alter table public.student_polygon_axes drop column score;
alter table public.student_polygon_axes
  add column score numeric(6,2) generated always as (coalesce(manual_score, ai_score, auto_score, 0)) stored;

-- The audit label for POST /ai/polygon-estimate. Additive and idempotent: it reads
-- the current CHECK back and adds one label (same shape as 20261110000002).
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

  if 'polygon-estimate' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'polygon-estimate'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
