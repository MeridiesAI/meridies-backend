-- The `student-documents` Storage bucket and who may touch its objects.
--
-- Every upload in the app (Files, a student's Files, essays, task attachments,
-- the Colleges tab's research, Drive/OneDrive imports) writes here, and every
-- open is a signed URL from it. The bucket was set up by hand in the
-- dashboard of an earlier project and never existed in this one, so on
-- production every upload failed. It now lives in the repo (STEPS.md 6.1).
--
-- Object names are `<first>/<timestamp>-<filename>`, where <first> is what the
-- uploader was filing into: a student id (StudentFiles, AssignTaskModal, the
-- integrations import), a folder id (FolderBrowser, the Colleges tab), or
-- `unfiled`. The rules:
--
--   read    the uploader, or anyone who can see the documents row that points
--           at the object (documents RLS decides, so Storage can't be more
--           generous than the file list);
--   upload  into a student the caller can edit, a folder the caller can see,
--           their own id, or `unfiled`;
--   delete  the uploader, or the owner of the documents row;
--   update  nobody (uploads never overwrite: upsert is off everywhere).

insert into storage.buckets (id, name, public, file_size_limit)
values ('student-documents', 'student-documents', false, 52428800)
on conflict (id) do update set public = false;

create or replace function private.storage_first_segment_is_fileable(p_name text, p_viewer uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path to 'private', 'public', 'pg_temp'
as $$
declare
  v_first text := split_part(p_name, '/', 1);
  v_id uuid;
begin
  if p_viewer is null or v_first = '' then
    return false;
  end if;
  if v_first = 'unfiled' then
    return true;
  end if;
  if v_first !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  v_id := v_first::uuid;
  return v_id = p_viewer
      or private.can_edit_student(v_id, p_viewer)
      -- Runs as the caller, so folders RLS decides whether they can see it.
      or exists (select 1 from public.folders f where f.id = v_id);
end;
$$;
revoke all on function private.storage_first_segment_is_fileable(text, uuid) from public, anon;
grant execute on function private.storage_first_segment_is_fileable(text, uuid) to authenticated;

drop policy if exists student_documents_select on storage.objects;
create policy student_documents_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'student-documents'
    and (
      owner_id = (select auth.uid())::text
      -- documents RLS applies inside this subquery: visible row, readable file.
      or exists (
        select 1 from public.documents d
        where d.bucket = 'student-documents' and d.storage_path = storage.objects.name
      )
    )
  );

drop policy if exists student_documents_insert on storage.objects;
create policy student_documents_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'student-documents'
    and private.storage_first_segment_is_fileable(name, (select auth.uid()))
  );

drop policy if exists student_documents_delete on storage.objects;
create policy student_documents_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'student-documents'
    and (
      owner_id = (select auth.uid())::text
      or exists (
        select 1 from public.documents d
        where d.bucket = 'student-documents' and d.storage_path = storage.objects.name
          and d.owner_id = (select auth.uid())
      )
    )
  );
