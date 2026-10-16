-- A documents row may point only at the documents bucket, at a path the
-- bucket's insert policy could have accepted, and never moves afterwards.
--
-- Why: `documents.bucket` and `documents.storage_path` were whatever the
-- client sent. Code that downloads by them (submission review did, with the
-- service role) could be pointed at the `imports` or `axis-attachments`
-- buckets, or at another user's object through a path that is a different
-- row but the same object: storage-js strips a leading "/", and the request
-- URL resolves "." and ".." segments, so "/x" and "a/../x" reach "x" while
-- the unique (bucket, storage_path) index sees three different strings.
-- The API now refuses those at registration (lib/storagePath.ts) and
-- downloads only on the caller's own client; this is the same rule for a
-- client writing through PostgREST.
--
-- The rule, for the `authenticated` and `anon` roles only (service_role,
-- postgres and SECURITY DEFINER functions such as transfer_caseload are
-- trusted writers and unaffected):
--   insert  bucket = 'student-documents', and storage_path passes
--           private.document_storage_path_ok: 1 to 500 characters, no
--           surrounding spaces, no control characters, backslash, "?", "#",
--           no percent-encoded ".", "/" or "\", at least two segments, none
--           empty, "." or "..", the first a uuid or 'unfiled' (what
--           private.storage_first_segment_is_fileable accepts);
--   update  bucket and storage_path never change (no route changes them).
-- Existing rows are not touched or re-checked.
--
-- Deploy order: either. Before it, the API already refuses the same paths at
-- POST /files/documents and submission review never follows a row's path
-- with the service role, so the code stands on its own; this closes the
-- PostgREST door. Safe for the previous build: every path the app writes is
-- `<uuid or unfiled>/<timestamp>-<safe name>`, and no route updates either
-- column. Not in REQUIRED_SCHEMA: nothing reads it.

create or replace function private.document_storage_path_ok(p_path text)
returns boolean
language plpgsql
immutable
set search_path to 'pg_catalog', 'pg_temp'
as $$
declare
  v_parts text[];
  v_part  text;
begin
  if p_path is null or length(p_path) = 0 or length(p_path) > 500 then
    return false;
  end if;
  if p_path <> btrim(p_path, E' \t\r\n') then
    return false;
  end if;
  if p_path ~ '[[:cntrl:]]'
     or strpos(p_path, E'\\') > 0
     or strpos(p_path, '?') > 0
     or strpos(p_path, '#') > 0
     or p_path ~* '%(2e|2f|5c)' then
    return false;
  end if;
  v_parts := string_to_array(p_path, '/');
  if cardinality(v_parts) < 2 then
    return false;
  end if;
  foreach v_part in array v_parts loop
    if v_part = '' or v_part = '.' or v_part = '..' then
      return false;
    end if;
  end loop;
  return v_parts[1] = 'unfiled'
      or v_parts[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
end;
$$;

revoke all on function private.document_storage_path_ok(text) from public, anon;
grant execute on function private.document_storage_path_ok(text) to authenticated;

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
  if not private.document_storage_path_ok(new.storage_path) then
    raise exception 'That file path isn''t one the app uploads to' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.documents_guard_storage_path() from public, anon, authenticated;

drop trigger if exists documents_guard_storage_path on public.documents;
create trigger documents_guard_storage_path
  before insert or update of bucket, storage_path on public.documents
  for each row execute function private.documents_guard_storage_path();
