-- Import pipeline, step 1: the tables.
-- Spec: docs/superpowers/specs/2026-10-09-import-pipeline-design.md §3–§4.
-- Additive: roster_imports is extended, not renamed; roster_import_rows stays
-- for history. Policies arrive in 20261014000002; until then RLS denies all.

-- ---------------------------------------------------------------------------
-- roster_imports, extended
-- ---------------------------------------------------------------------------

alter table public.roster_imports drop constraint if exists roster_imports_source_check;
alter table public.roster_imports add constraint roster_imports_source_check
  check (source in ('csv','google','microsoft','manual','xlsx','google-sheet','pdf','mixed'));

-- Old statuses (mapping, importing, complete, failed) stay valid for the old
-- roster flow until it is retired.
alter table public.roster_imports drop constraint if exists roster_imports_status_check;
alter table public.roster_imports add constraint roster_imports_status_check
  check (status in ('mapping','importing','complete','failed',
                    'draft','profiling','staging','review','committing','committed',
                    'undoing','undone','expired'));

alter table public.roster_imports
  add column if not exists firm_id                 uuid references public.firms(id) on delete set null,
  add column if not exists source_system           text not null default 'unknown'
    check (source_system in ('naviance','scoir','cialfo','hubspot','collegeplannerpro',
                             'counselmore','gradbetter','other','unknown')),
  add column if not exists template_id             uuid,
  add column if not exists permission_confirmed_by uuid references public.profiles(id) on delete set null,
  add column if not exists permission_confirmed_at timestamptz,
  add column if not exists committed_at            timestamptz,
  add column if not exists undone_at               timestamptz,
  add column if not exists expires_at              timestamptz,
  add column if not exists undo_until              timestamptz,
  add column if not exists compacted_at            timestamptz,
  add column if not exists ai_spend_cents          integer not null default 0 check (ai_spend_cents >= 0),
  add column if not exists job_actor               uuid references public.profiles(id) on delete set null,
  add column if not exists job_requested_at        timestamptz,
  add column if not exists job_error               jsonb,
  add column if not exists job_result              jsonb;

comment on column public.roster_imports.firm_id is
  'The practice the import belongs to, stamped at creation (private.crm_workspace_firm) so leaving the firm does not change who may see it. Null for a solo counselor.';
comment on column public.roster_imports.source_system is
  'Where the data came from (not the file format). Drives provenance: a later import from the same system may update values this one wrote.';

update public.roster_imports i
   set firm_id = private.crm_workspace_firm(i.counselor_id)
 where i.firm_id is null;

create or replace function private.roster_imports_stamp_firm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.firm_id := private.crm_workspace_firm(new.counselor_id);
  return new;
end;
$$;
revoke all on function private.roster_imports_stamp_firm() from public, anon, authenticated;

drop trigger if exists roster_imports_stamp_firm on public.roster_imports;
create trigger roster_imports_stamp_firm before insert on public.roster_imports
  for each row execute function private.roster_imports_stamp_firm();

-- The browser may keep using the old roster flow's columns and statuses, but
-- every new-pipeline status and job column moves only through the
-- SECURITY DEFINER functions (which run as the function owner, not as
-- `authenticated`).
-- Deliberately NOT security definer: the guard keys off current_user.
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
       or new.template_id is not null or new.source_system <> 'unknown' then
      raise exception 'Import status changes go through the API' using errcode = '42501';
    end if;
    return new;
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
     or (new.status is distinct from old.status
         and not (old.status = any (v_old_statuses) and new.status = any (v_old_statuses))) then
    raise exception 'Import status changes go through the API' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.roster_imports_guard_client() from public, anon, authenticated;

drop trigger if exists roster_imports_guard_client on public.roster_imports;
create trigger roster_imports_guard_client before insert or update or delete on public.roster_imports
  for each row execute function private.roster_imports_guard_client();

-- ---------------------------------------------------------------------------
-- import_fields: the only things an import may write (spec §4.1)
-- ---------------------------------------------------------------------------

create table if not exists public.import_fields (
  target_table text not null check (target_table in
                 ('student_academics','student_personal_details','test_scores','courses','activities')),
  field        text not null check (length(field) between 1 and 63),
  value_type   text not null check (length(value_type) between 1 and 63),
  sensitivity  smallint not null check (sensitivity between 1 and 3),
  primary key (target_table, field)
);

insert into public.import_fields (target_table, field, value_type, sensitivity) values
  ('student_academics', 'gpa_unweighted',   'gpa',              3),
  ('student_academics', 'gpa_weighted',     'gpa',              3),
  ('student_academics', 'gpa_scale',        'text:20',          3),
  ('student_academics', 'class_rank',       'text:40',          3),
  ('student_academics', 'class_rank_value', 'text:40',          3),
  ('student_academics', 'test_status',      'enum:test_status', 3),
  ('student_academics', 'sat_ebrw',         'sat_section',      3),
  ('student_academics', 'sat_math',         'sat_section',      3),
  ('student_academics', 'sat_superscore',   'sat_total',        3),
  ('student_academics', 'act_composite',    'act_composite',    3),
  ('student_personal_details', 'contact_email',   'email',            1),
  ('student_personal_details', 'address',         'text:400',         2),
  ('student_personal_details', 'gender',          'enum:gender',      2),
  ('student_personal_details', 'birthday',        'date',             2),
  ('student_personal_details', 'citizenship',     'enum:citizenship', 2),
  ('student_personal_details', 'first_gen',       'bool',             2),
  ('student_personal_details', 'intended_majors', 'text[]',           1),
  ('test_scores', '*', 'row:test_score', 3),
  ('courses',     '*', 'row:course',     1),
  ('activities',  '*', 'row:activity',   1)
on conflict (target_table, field) do update
  set value_type = excluded.value_type, sensitivity = excluded.sensitivity;

alter table public.import_fields enable row level security;
revoke all on table public.import_fields from anon, authenticated;

-- ---------------------------------------------------------------------------
-- import_templates, import_files, import_items, import_changes
-- ---------------------------------------------------------------------------

create table if not exists public.import_templates (
  id            uuid primary key default gen_random_uuid(),
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 200),
  source_system text not null default 'unknown'
                check (source_system in ('naviance','scoir','cialfo','hubspot','collegeplannerpro',
                                         'counselmore','gradbetter','other','unknown')),
  fingerprint   text not null check (length(fingerprint) between 8 and 128),
  parse_plan    jsonb not null default '{}'::jsonb,
  use_count     integer not null default 0 check (use_count >= 0),
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (counselor_id, fingerprint)
);
drop trigger if exists import_templates_set_updated_at on public.import_templates;
create trigger import_templates_set_updated_at before update on public.import_templates
  for each row execute function public.set_updated_at();
alter table public.import_templates enable row level security;
revoke all on table public.import_templates from anon, authenticated;

alter table public.roster_imports drop constraint if exists roster_imports_template_fk;
alter table public.roster_imports add constraint roster_imports_template_fk
  foreign key (template_id) references public.import_templates(id) on delete set null;

create table if not exists public.import_files (
  id            uuid primary key default gen_random_uuid(),
  import_id     uuid not null references public.roster_imports(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  storage_path  text not null unique check (length(storage_path) between 3 and 600),
  filename      text not null check (length(btrim(filename)) between 1 and 300),
  mime_type     text check (length(mime_type) <= 200),
  detected_type text check (detected_type in ('csv','xlsx','pdf','unknown')),
  size_bytes    bigint check (size_bytes >= 0),
  sha256        text check (sha256 ~ '^[0-9a-f]{64}$'),
  kind          text not null check (kind in ('sheet','pdf')),
  status        text not null default 'registered' check (status in ('registered','profiled','failed','excluded')),
  error         text check (length(error) <= 500),
  profile       jsonb,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists import_files_import_idx on public.import_files (import_id);
drop trigger if exists import_files_set_updated_at on public.import_files;
create trigger import_files_set_updated_at before update on public.import_files
  for each row execute function public.set_updated_at();
alter table public.import_files enable row level security;
revoke all on table public.import_files from anon, authenticated;

create table if not exists public.import_items (
  id               uuid primary key default gen_random_uuid(),
  import_id        uuid not null references public.roster_imports(id) on delete cascade,
  file_id          uuid references public.import_files(id) on delete set null,
  -- Set when the item was carried over from the old roster flow (§5.8).
  legacy_row_id    uuid unique references public.roster_import_rows(id) on delete set null,
  locator          jsonb not null default '{}'::jsonb,
  match_status     text not null check (match_status in
                     ('matched_email','suggested','confirmed','new_invite','awaiting_counselor',
                      'applying','applied','skipped','expired','failed')),
  match_confidence text check (match_confidence in ('high','medium','low')),
  match_reasons    text[] not null default '{}',
  -- Cascade: deleting a student's account deletes their import data and
  -- fingerprints with it (spec §5.10, §10).
  student_id       uuid references public.profiles(id) on delete cascade,
  invitation_id    uuid references public.invitations(id) on delete set null,
  imported_name    text check (length(imported_name) <= 200),
  match_key        jsonb not null default '{}'::jsonb,
  candidates       jsonb not null default '[]'::jsonb,
  skip_reason      text check (length(skip_reason) <= 300),
  held_until       timestamptz,
  hold_warned_at   timestamptz,
  invite_state     text not null default 'unsent' check (invite_state in ('unsent','sent','failed')),
  job_actor        uuid references public.profiles(id) on delete set null,
  job_requested_at timestamptz,
  job_error        jsonb,
  error            text check (length(error) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint import_items_student_when_matched check (
    match_status not in ('matched_email','confirmed','awaiting_counselor','applying','applied')
    or student_id is not null)
);
create index if not exists import_items_import_idx on public.import_items (import_id, match_status);
create index if not exists import_items_student_idx on public.import_items (student_id) where student_id is not null;
create index if not exists import_items_invitation_idx on public.import_items (invitation_id) where invitation_id is not null;
drop trigger if exists import_items_set_updated_at on public.import_items;
create trigger import_items_set_updated_at before update on public.import_items
  for each row execute function public.set_updated_at();
alter table public.import_items enable row level security;
revoke all on table public.import_items from anon, authenticated;

create table if not exists public.import_changes (
  id             uuid primary key default gen_random_uuid(),
  import_id      uuid not null references public.roster_imports(id) on delete cascade,
  item_id        uuid not null references public.import_items(id) on delete cascade,
  target_table   text not null,
  field          text not null,
  op             text not null check (op in ('set_field','insert_row')),
  target_row_id  uuid,
  old_value      jsonb,
  new_value      jsonb,
  -- What the database actually holds after applying (normalized, e.g. 3.800),
  -- the value undo compares against. Dropped at compaction.
  applied_value  jsonb,
  -- sha256 of applied_value, kept after compaction for provenance (§5.6).
  -- Personal data: reversible for low-variety fields; deleted with the student.
  new_value_hash text check (new_value_hash ~ '^[0-9a-f]{64}$'),
  old_source     text check (old_source in ('empty','student','counselor','intake','import')),
  risk           numeric(8,3) not null default 0 check (risk >= 0),
  pattern_key    text check (length(pattern_key) <= 200),
  decision       text not null default 'keep_old' check (decision in ('auto','accept','keep_old','reject')),
  state          text not null default 'staged' check (state in
                   ('staged','applied','skipped_stale','skipped_invalid','undone','undo_skipped','failed')),
  source_ref     text check (length(source_ref) <= 200),
  ai_cleaned     boolean not null default false,
  error          text check (length(error) <= 500),
  applied_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint import_changes_field_fk foreign key (target_table, field)
    references public.import_fields (target_table, field),
  constraint import_changes_op_matches_field check ((op = 'insert_row') = (field = '*')),
  constraint import_changes_staged_has_value check (state <> 'staged' or new_value is not null)
);
create index if not exists import_changes_import_idx on public.import_changes (import_id, state);
create index if not exists import_changes_item_idx on public.import_changes (item_id);
create index if not exists import_changes_provenance_idx
  on public.import_changes (target_table, field, applied_at desc) where state = 'applied';
drop trigger if exists import_changes_set_updated_at on public.import_changes;
create trigger import_changes_set_updated_at before update on public.import_changes
  for each row execute function public.set_updated_at();
alter table public.import_changes enable row level security;
revoke all on table public.import_changes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- GPA: stored as given with its scale, never converted (§2, §4.1)
-- ---------------------------------------------------------------------------

alter table public.student_academics drop constraint if exists student_academics_gpa_unweighted_check;
alter table public.student_academics drop constraint if exists student_academics_gpa_weighted_check;
alter table public.student_academics
  alter column gpa_unweighted type numeric(6,3),
  alter column gpa_weighted   type numeric(6,3);
alter table public.student_academics drop constraint if exists student_academics_gpa_range;
alter table public.student_academics add constraint student_academics_gpa_range check (
  (gpa_unweighted is null or (gpa_unweighted >= 0 and gpa_unweighted <=
     case when coalesce(gpa_scale, '') ~ '^\s*100' then 110 else 10 end))
  and
  (gpa_weighted is null or (gpa_weighted >= 0 and gpa_weighted <=
     case when coalesce(gpa_scale, '') ~ '^\s*100' then 110 else 10 end))
);
comment on constraint student_academics_gpa_range on public.student_academics is
  'Up to 10 on 4/5/10-point scales; up to 110 (weighted bonus) when gpa_scale starts with 100. Readers must check gpa_scale (src/lib/gpa.ts).';

-- ---------------------------------------------------------------------------
-- Imported rows say so (§7.5): every AI module treats them as data.
-- ---------------------------------------------------------------------------

alter table public.test_scores
  add column if not exists source text not null default 'manual'
    check (source in ('manual','intake','import','ai'));
alter table public.courses
  add column if not exists source text not null default 'manual'
    check (source in ('manual','intake','import','ai'));

-- ---------------------------------------------------------------------------
-- The import sweep's heartbeat (lib/heartbeat.ts)
-- ---------------------------------------------------------------------------

alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
alter table public.job_heartbeats add constraint job_heartbeats_job_check
  check (job in ('accountability-sweep','message-dispatch','scorecard-ingest','resources-link-check','import-sweep'));
insert into public.job_heartbeats (job, expected_every)
values ('import-sweep', interval '15 minutes')
on conflict (job) do nothing;
