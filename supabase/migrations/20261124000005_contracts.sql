-- Invoice composer, part 3 of 3: contracts (uploaded PDF/DOCX files) that go with an invoice.
--
--   * A private `contracts` bucket (PDF and DOCX, 10 MB), no storage.objects policy: nothing writes
--     there but a signed upload URL the API mints (POST /pipeline/contracts/upload-url) under
--     `<practice id>/<uuid>.<pdf|docx>`, and nothing reads but the API (service role) after its own checks.
--   * `contract_files`  the practice's contract library: name, the object's path, type, size and the
--     file's SHA-256 (computed by the API from the stored bytes). The practice's own, like its packages:
--     members read, a firm owner/admin or the solo counselor writes.
--   * Attaching a contract to an invoice makes a regular `agreements` row bound to the file. This file
--     relaxes `agreements.storage_path` (it was CHECKed NULL, "reserved") to "null or a contract object",
--     adds `agreements.contract_file_id`, and has the guard trigger set `storage_path` and `body_text`
--     FROM THE FILE'S ROW: the text the family accepts is "Contract file: <name> / File SHA-256: <hash>",
--     so `body_sha256` (and the acceptance certificate, which records it) binds the typed-name acceptance
--     to the exact bytes. A client can't choose either. Everything else about agreements is untouched.
--
-- Deploy order: after 20261111000010. Either order with the code: without this file the contract routes
-- answer 503 `contracts_unavailable`; invoices and agreements work as before. Additive only (the old
-- storage_path check is replaced by a weaker named one; every existing row is null). Not in
-- REQUIRED_SCHEMA. Re-runnable.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contracts', 'contracts', false, 10485760,
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.contract_files (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  practice_id   uuid not null,
  name          text not null check (length(btrim(name)) between 1 and 160),
  storage_path  text not null unique,
  mime          text not null check (mime in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes    bigint not null check (size_bytes between 1 and 10485760),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  archived_at   timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint contract_files_scope check (practice_id = coalesce(firm_id, counselor_id)),
  -- The practice's own folder, an API-named object.
  constraint contract_files_path_shape check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx)$'
    and storage_path like practice_id::text || '/%')
);

create index if not exists contract_files_practice_idx on public.contract_files (practice_id, created_at desc);

alter table public.contract_files enable row level security;

drop policy if exists contract_files_select on public.contract_files;
create policy contract_files_select on public.contract_files
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists contract_files_insert on public.contract_files;
create policy contract_files_insert on public.contract_files
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid()))
              and private.crm_can_admin(firm_id, counselor_id, (select auth.uid()))
              and created_by = (select auth.uid()));

drop policy if exists contract_files_update on public.contract_files;
create policy contract_files_update on public.contract_files
  for update to authenticated
  using (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

-- No delete: a contract a family may have accepted stays on the record (archive it).
revoke all on public.contract_files from public, anon, authenticated;
grant select, insert on public.contract_files to authenticated;
grant update (name, archived_at) on public.contract_files to authenticated;

select private.attach_approval_gate('public.contract_files');

-- ---------------------------------------------------------------------------
-- Agreements bound to a file
-- ---------------------------------------------------------------------------

alter table public.agreements add column if not exists contract_file_id uuid
  references public.contract_files(id) on delete restrict;

alter table public.agreements drop constraint if exists agreements_storage_path_check;
alter table public.agreements drop constraint if exists agreements_storage_path_contract;
alter table public.agreements add constraint agreements_storage_path_contract
  check ((storage_path is null) = (contract_file_id is null));

grant insert (contract_file_id) on public.agreements to authenticated;

-- The same guard as 20261111000010, plus: a row naming a contract file takes its path and its text
-- from that file (same practice as the contact; unarchived on a new attach), and neither changes later.
create or replace function private.agreements_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_client boolean := coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon');
  v_restore boolean := tg_op = 'INSERT' and current_setting('meridies.axis_restore', true) = 'on';
  f public.contract_files;
  v_practice uuid;
begin
  if v_restore then
    -- AxIS Restore (20261108000003) puts back a row its trash kept when the contact was deleted, as it was: a sent
    -- agreement stays sent with its times, so its link works again. Never an accepted one: a signed agreement can't
    -- be deleted (its acceptance RESTRICTs), so no trash row can honestly hold one, and a restore must not be able
    -- to forge that state. The hash is recomputed and the workspace re-read, as on any insert.
    if new.status not in ('draft', 'sent', 'void') or new.accepted_at is not null then
      raise exception 'An accepted agreement can''t be restored' using errcode = '42501';
    end if;
    select c.firm_id into new.firm_id from public.pipeline_contacts c where c.id = new.contact_id;
  elsif tg_op = 'INSERT' then
    new.status := 'draft';
    new.sent_at := null;
    new.accepted_at := null;
    new.voided_at := null;
    new.created_at := now();
    select c.firm_id into new.firm_id from public.pipeline_contacts c where c.id = new.contact_id;
  end if;

  if tg_op = 'INSERT' then
    if new.contract_file_id is null then
      new.storage_path := null;
    else
      select * into f from public.contract_files where id = new.contract_file_id;
      select coalesce(c.firm_id, c.counselor_id) into v_practice from public.pipeline_contacts c where c.id = new.contact_id;
      if not found or v_practice is distinct from f.practice_id or (f.archived_at is not null and not v_restore) then
        raise exception 'That contract isn''t available for this family' using errcode = '42501';
      end if;
      new.storage_path := f.storage_path;
      new.body_text := 'Contract file: ' || f.name || E'\nFile SHA-256: ' || f.sha256;
    end if;
    new.body_sha256 := encode(sha256(convert_to(new.body_text, 'UTF8')), 'hex');
    return new;
  end if;

  if old.status in ('accepted', 'void') then
    raise exception 'This agreement can no longer be changed' using errcode = 'P0001';
  end if;

  new.id := old.id;
  new.counselor_id := old.counselor_id;
  new.contact_id := old.contact_id;
  new.firm_id := old.firm_id;
  new.created_at := old.created_at;
  new.storage_path := old.storage_path;
  new.contract_file_id := old.contract_file_id;

  if old.contract_file_id is not null then
    -- A contract's text is the file's; it never edits.
    new.title := coalesce(new.title, old.title);
    new.body_text := old.body_text;
  elsif (new.title, new.body_text) is distinct from (old.title, old.body_text) and old.status <> 'draft' then
    raise exception 'An agreement can''t be edited once it has been sent' using errcode = 'P0001';
  end if;
  if old.contract_file_id is not null and new.title is distinct from old.title and old.status <> 'draft' then
    raise exception 'An agreement can''t be edited once it has been sent' using errcode = 'P0001';
  end if;
  new.body_sha256 := encode(sha256(convert_to(new.body_text, 'UTF8')), 'hex');

  if v_client then
    new.sent_at := old.sent_at;
    new.accepted_at := old.accepted_at;
    new.voided_at := old.voided_at;
    new.consent_version := old.consent_version;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'sent' then
      new.sent_at := coalesce(case when v_client then null else new.sent_at end, now());
    elsif old.status = 'sent' and new.status = 'accepted' and not v_client then
      new.accepted_at := coalesce(new.accepted_at, now());
    elsif old.status in ('draft', 'sent') and new.status = 'void' then
      new.voided_at := now();
    else
      raise exception 'That change of status isn''t allowed' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.agreements_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A contract's family link: the pay page mints one on click (service role), no earlier link expires
-- ---------------------------------------------------------------------------
-- (No SQL: agreement_tokens already takes a service-role insert; routes/pay.ts does it, and flips a draft
--  to sent with the service role, which the guard above allows for a non-client session.)
