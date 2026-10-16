-- A documents row may be registered only where its writer could upload, and
-- never over another user's object.
--
-- Why: Storage lets anyone read an object that a documents row they can see
-- points at, and lets the row's owner delete it (student_documents_select /
-- _delete, 20261011000001). 20261024000041 checked a new row's path for its
-- shape only, so any signed-in user could register a row at the exact name
-- of an object that had no row (a counselor deleting a student's upload left
-- the object behind; storagePath is in the document DTO, so a former
-- counselor knows it) and then read or delete that object. Now, on insert by
-- `authenticated` or `anon`, the path must also pass
-- private.storage_first_segment_is_fileable (the bucket insert policy's own
-- rule: the writer's id, a student they can edit, a folder they can see, or
-- `unfiled`), and when an object is already at that name it must be the
-- writer's own (storage.objects.owner_id). A path with no object yet still
-- registers. Every refusal carries the same message, so the answer says no
-- more about who owns what than the refusal of a path the writer could never
-- upload to.
--
-- private.document_path_taken_by_other is SECURITY DEFINER because the writer
-- can't see another user's object under Storage RLS (which is the point). It
-- answers only for the documents bucket, only about the calling user, and is
-- callable by authenticated only through this trigger's use.
--
-- Deploy order: either. Before it, POST /files/documents makes the same two
-- checks (lib/documentClaim.ts), and DELETE /files/documents/:id now removes
-- the object with its row, so the code stands on its own; this closes the
-- PostgREST door. Safe for the previous build: it registers only rows for
-- files its own caller just uploaded, under a first segment the bucket let
-- them upload to. service_role, postgres and SECURITY DEFINER functions
-- (transfer_caseload) are unaffected, as in 20261024000041. Not in
-- REQUIRED_SCHEMA.

create or replace function private.document_path_taken_by_other(p_path text)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $$
  select exists (
    select 1 from storage.objects o
     where o.bucket_id = 'student-documents'
       and o.name = p_path
       and o.owner_id is distinct from (select auth.uid())::text
  );
$$;

revoke all on function private.document_path_taken_by_other(text) from public, anon;
grant execute on function private.document_path_taken_by_other(text) to authenticated;

create or replace function private.documents_guard_storage_path()
returns trigger
language plpgsql
set search_path to 'private', 'public', 'pg_temp'
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
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
