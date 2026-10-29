-- AI meeting-note summaries: the ai_runs audit label for POST /ai/meeting-summary.
--
-- Deploy order: either. An unknown module label fails the audit insert, not the
-- request, so the route works before this is applied; the audit row for it is
-- simply skipped until then. Not in REQUIRED_SCHEMA.
--
-- Additive and idempotent: it reads the current CHECK back and adds one label,
-- so it never drops another area's label and re-running it is harmless.

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

  if 'meeting-summary' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'meeting-summary'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
