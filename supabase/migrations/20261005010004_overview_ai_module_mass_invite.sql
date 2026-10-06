-- Mass invite (v10): AxIS sorts a pasted list of addresses. Its runs are
-- audited in ai_runs like every other module, so the module CHECK has to
-- allow it.
--
-- Additive on purpose: several v10 migrations extend this constraint, and a
-- migration that re-declares the whole list would silently drop whatever a
-- sibling added. This one reads the values already allowed and appends.

do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  -- Postgres renders the list either as ARRAY['a'::text, ...] or as
  -- '{a,b}'::text[] (after a rewrite like this one); read both.
  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if 'mass-invite' = any(v_values) then
    return;
  end if;
  v_values := array_append(v_values, 'mass-invite'::text);

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
