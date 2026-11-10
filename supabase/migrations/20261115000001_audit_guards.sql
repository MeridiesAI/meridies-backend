-- Security audit 2026-11-05: active content stays out of the documents bucket; a
-- pipeline family is handed over only by an admin or its owner (at the end).
--
-- The API refuses to register a file whose name or declared type a browser
-- would run script from (lib/storagePath.ts isActiveContentFile): a student's
-- crafted SVG never reaches a counselor's file list or a signed link. Two
-- doors stayed open beside it:
--   1. The bucket has no type allowlist, so an object could be PUT with
--      Content-Type text/html under a .pdf name; a signed URL then serves
--      it as HTML on the Storage origin.
--   2. documents.filename / mime_type carry no such rule, so a row could be
--      renamed to .svg through PostgREST after registration.
-- The insert policy now refuses an object whose stored mimetype or name is
-- active content, and the documents guard refuses such a filename or
-- mime_type on insert and update. Service-role writes are untouched.
--
-- Deploy order: either order with the code. Not in REQUIRED_SCHEMA.

create or replace function private.is_active_content(p_filename text, p_mime text)
returns boolean
language sql
immutable
set search_path to 'pg_temp'
as $$
  select lower(btrim(split_part(coalesce(p_mime, ''), ';', 1)))
           in ('image/svg+xml', 'text/html', 'application/xhtml+xml')
      or btrim(coalesce(p_filename, '')) ~* '\.(svgz?|html?|xht(ml)?)$';
$$;
revoke all on function private.is_active_content(text, text) from public, anon;
grant execute on function private.is_active_content(text, text) to authenticated;

drop policy if exists student_documents_insert on storage.objects;
create policy student_documents_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'student-documents'
    and private.storage_first_segment_is_fileable(name, (select auth.uid()))
    and not private.is_active_content(name, metadata->>'mimetype')
  );

create or replace function private.documents_guard_storage_path()
returns trigger
language plpgsql
set search_path to 'private', 'public', 'pg_temp'
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if private.is_active_content(new.filename, new.mime_type) then
    raise exception 'SVG and HTML files can''t be filed' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.bucket is distinct from old.bucket or new.storage_path is distinct from old.storage_path then
      raise exception 'A file''s storage location can''t be changed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.bucket is distinct from 'student-documents' then
    raise exception 'Files are registered in the documents bucket only' using errcode = '23514';
  end if;
  if not private.document_storage_path_ok(new.storage_path)
     or not private.storage_first_segment_is_fileable(new.storage_path, auth.uid())
     or private.document_path_taken_by_other(new.storage_path) then
    raise exception 'That file path isn''t one the app uploads to' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.documents_guard_storage_path() from public, anon, authenticated;

-- The guard used to run only when the location changed; a rename must reach it too.
drop trigger if exists documents_guard_storage_path on public.documents;
create trigger documents_guard_storage_path
  before insert or update of bucket, storage_path, filename, mime_type on public.documents
  for each row execute function private.documents_guard_storage_path();

-- A pipeline contact's owner may bill the family (private.crm_can_bill), and any
-- firm member could set owner_id to themselves. Handing a family over is for a
-- firm admin or its current owner; the API refuses it too (routes/pipeline.ts).
-- The service role (no auth.uid()) is untouched.
create or replace function private.pipeline_contacts_owner_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or new.owner_id is not distinct from old.owner_id then
    return new;
  end if;
  if not (
    old.owner_id = caller
    or (new.firm_id is null and new.counselor_id = caller)
    or (new.firm_id is not null and private.crm_firm_admin(new.firm_id, caller))
  ) then
    raise exception 'Only a firm admin or this family''s owner can change who owns them' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.pipeline_contacts_owner_guard() from public, anon, authenticated;

drop trigger if exists pipeline_contacts_owner_guard on public.pipeline_contacts;
create trigger pipeline_contacts_owner_guard before update of owner_id on public.pipeline_contacts
  for each row execute function private.pipeline_contacts_owner_guard();

-- profiles: the client never inserts its own row (handle_new_user, SECURITY
-- DEFINER, creates it at signup), yet the table-level INSERT grant stayed when
-- UPDATE was re-issued per column (20260828000016). Were a row ever missing, a
-- user could insert one with role, counselor_approved_at and firm_id of their
-- choosing. The API and the app only read and update profiles.
revoke insert on public.profiles from authenticated, anon;

-- pipeline_sequences: a firm member could insert a sequence with any
-- counselor_id (attribution only: reads go by firm_id). The insert now has to
-- name the caller's own workspace, as pipeline_contacts does; the API already
-- writes counselor_id = the caller (routes/pipelineSequences.ts).
drop policy if exists pipeline_sequences_insert on public.pipeline_sequences;
create policy pipeline_sequences_insert on public.pipeline_sequences
  for insert to authenticated with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid())));
