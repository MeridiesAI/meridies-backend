-- Import pipeline, step 2 (CSV/XLSX path): the columns staging and review
-- need, the client guard on roster_imports re-created, and the ai_runs labels.
-- Spec: docs/superpowers/specs/2026-10-09-import-pipeline-design.md §5.1-§5.7.
-- Additive and safe to apply before the code: nothing reads these columns
-- until the step-2 routes run, and the guard below is a superset of the old.

-- ---------------------------------------------------------------------------
-- roster_imports: the confirmed parse plan, review counts, the invitation hold
-- ---------------------------------------------------------------------------

alter table public.roster_imports
  add column if not exists plan                jsonb,
  add column if not exists stats               jsonb,
  add column if not exists staged_at           timestamptz,
  -- Set at commit when a counselor's first import would send more than 50
  -- invitations (§5.1); Meridies staff approve by hand (invites_approved_at).
  add column if not exists invites_held_reason text check (length(invites_held_reason) <= 200),
  add column if not exists invites_approved_at timestamptz;

comment on column public.roster_imports.plan is
  'The confirmed parse plan (lib/imports/plan.ts). Written only by the import worker.';
comment on column public.roster_imports.stats is
  'Review counts, refreshed by staging and every review decision. Counts only.';

-- ---------------------------------------------------------------------------
-- import_files: the row count outlives the profile, which is wiped after commit
-- ---------------------------------------------------------------------------

alter table public.import_files
  add column if not exists row_count integer check (row_count >= 0);

-- ---------------------------------------------------------------------------
-- import_items: flags, and a claim for sending invitations (§5.7)
-- ---------------------------------------------------------------------------

alter table public.import_items
  add column if not exists flags             text[] not null default '{}',
  add column if not exists invite_claimed_at timestamptz;

-- 'sending' is the claim: one request owns the item until it records sent or
-- failed, or until the claim is ten minutes old (a crash mid-send).
alter table public.import_items drop constraint if exists import_items_invite_state_check;
alter table public.import_items add constraint import_items_invite_state_check
  check (invite_state in ('unsent','sending','sent','failed'));

-- ---------------------------------------------------------------------------
-- import_changes: conflicting values in one file, the source column, flags
-- ---------------------------------------------------------------------------

alter table public.import_changes
  add column if not exists alternatives  jsonb,
  add column if not exists source_column text check (length(source_column) <= 200),
  add column if not exists flags         text[] not null default '{}';

create index if not exists import_changes_pattern_idx on public.import_changes (import_id, pattern_key);

-- ---------------------------------------------------------------------------
-- The client guard, re-created. It names every protected column, so every new
-- roster_imports column must be added here (AGENTS.md "Import pipeline").
--
-- A new-pipeline import (permission_confirmed_at is set; only start_import
-- sets it) is the API's alone: the browser may not change or delete it at
-- all. Without this, roster_imports_update_own would let a counselor move one
-- between the statuses the old roster flow shares ('mapping', 'complete'...)
-- or write its plan, stats or invitation approval through PostgREST.
-- Deliberately NOT security definer: the guard keys off current_user.
-- ---------------------------------------------------------------------------

create or replace function private.roster_imports_guard_client()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_statuses constant text[] := array['mapping','importing','complete','failed'];
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.permission_confirmed_at is not null then
      raise exception 'Discard an import through the API' using errcode = '42501';
    end if;
    if old.status in ('committing','committed','undoing','undone') then
      raise exception 'A saved import can''t be deleted; undo it instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('mapping','draft')
       or new.committed_at is not null or new.undo_until is not null or new.undone_at is not null
       or new.compacted_at is not null or new.job_actor is not null or new.job_requested_at is not null
       or new.job_error is not null or new.job_result is not null
       or new.ai_spend_cents <> 0 or new.expires_at is not null
       or new.permission_confirmed_by is not null or new.permission_confirmed_at is not null
       or new.template_id is not null or new.source_system <> 'unknown'
       or new.plan is not null or new.stats is not null or new.staged_at is not null
       or new.invites_held_reason is not null or new.invites_approved_at is not null then
      raise exception 'Import status changes go through the API' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.permission_confirmed_at is not null then
    raise exception 'Imports change through the API' using errcode = '42501';
  end if;
  if new.counselor_id is distinct from old.counselor_id
     or new.firm_id is distinct from old.firm_id
     or new.committed_at is distinct from old.committed_at
     or new.undo_until is distinct from old.undo_until
     or new.undone_at is distinct from old.undone_at
     or new.compacted_at is distinct from old.compacted_at
     or new.job_actor is distinct from old.job_actor
     or new.job_requested_at is distinct from old.job_requested_at
     or new.job_error is distinct from old.job_error
     or new.job_result is distinct from old.job_result
     or new.ai_spend_cents is distinct from old.ai_spend_cents
     or new.expires_at is distinct from old.expires_at
     or new.permission_confirmed_by is distinct from old.permission_confirmed_by
     or new.permission_confirmed_at is distinct from old.permission_confirmed_at
     or new.template_id is distinct from old.template_id
     or new.source_system is distinct from old.source_system
     or new.plan is distinct from old.plan
     or new.stats is distinct from old.stats
     or new.staged_at is distinct from old.staged_at
     or new.invites_held_reason is distinct from old.invites_held_reason
     or new.invites_approved_at is distinct from old.invites_approved_at
     or (new.status is distinct from old.status
         and not (old.status = any (v_old_statuses) and new.status = any (v_old_statuses))) then
    raise exception 'Import status changes go through the API' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.roster_imports_guard_client() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ai_runs: the column mapping (now) and cell cleanup (deferred; the label is
-- here so adding it later needs no migration). Additive: the current CHECK is
-- read back and these two appended, never restated.
-- ---------------------------------------------------------------------------

do $$
declare
  v_def    text;
  v_values text[];
  v_label  text;
  v_added  boolean := false;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';
  if v_def is null then
    return;
  end if;

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(v_def, '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  foreach v_label in array array['import-mapping','import-cleanup'] loop
    if not (v_label = any (v_values)) then
      v_values := array_append(v_values, v_label);
      v_added := true;
    end if;
  end loop;
  if not v_added then
    return;
  end if;

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
