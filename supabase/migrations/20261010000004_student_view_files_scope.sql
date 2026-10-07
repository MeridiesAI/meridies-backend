-- Student view (SV Demo v2), 4 of 5: a student's Files is "My documents" and
-- nothing else.
--
-- The student sees and files into their own student folder (the one the
-- roster trigger made in their counselor's drive), uploads documents about
-- themselves, and pastes links. The existing policies were written for a
-- counselor's drive: "owner_id = me" let any signed-in user insert a document
-- or link owned by themselves pointing at any folder or any student, and
-- folders_write_owner let a student create folders of their own.
--
-- These are RESTRICTIVE policies layered on the permissive ones, so nothing a
-- counselor can do today changes. For a caller whose role is student, a write
-- must be about themselves and land either unfiled or in their own student
-- folder; and a student creates no folders.

-- True when `folder` is a student folder belonging to `student`.
create or replace function private.is_student_folder_of(folder uuid, student uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private','public'
as $$
  select exists (
    select 1 from public.folders f
    where f.id = folder and f.kind = 'student' and f.student_id = student
  );
$$;

revoke all on function private.is_student_folder_of(uuid, uuid) from public, anon;
grant execute on function private.is_student_folder_of(uuid, uuid) to authenticated;

-- ---- documents --------------------------------------------------------------

drop policy if exists documents_student_scope_insert on public.documents;
create policy documents_student_scope_insert on public.documents
  as restrictive for insert to authenticated
  with check (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or (student_id = (select auth.uid())
        and (folder_id is null or private.is_student_folder_of(folder_id, (select auth.uid()))))
  );

drop policy if exists documents_student_scope_update on public.documents;
create policy documents_student_scope_update on public.documents
  as restrictive for update to authenticated
  using (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or student_id = (select auth.uid())
  )
  with check (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or (student_id = (select auth.uid())
        and (folder_id is null or private.is_student_folder_of(folder_id, (select auth.uid()))))
  );

-- ---- document_links ---------------------------------------------------------

drop policy if exists document_links_student_scope_insert on public.document_links;
create policy document_links_student_scope_insert on public.document_links
  as restrictive for insert to authenticated
  with check (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or (student_id = (select auth.uid())
        and (folder_id is null or private.is_student_folder_of(folder_id, (select auth.uid()))))
  );

drop policy if exists document_links_student_scope_update on public.document_links;
create policy document_links_student_scope_update on public.document_links
  as restrictive for update to authenticated
  using (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or student_id = (select auth.uid())
  )
  with check (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or (student_id = (select auth.uid())
        and (folder_id is null or private.is_student_folder_of(folder_id, (select auth.uid()))))
  );

-- ---- folders ----------------------------------------------------------------

drop policy if exists folders_student_no_create on public.folders;
create policy folders_student_no_create on public.folders
  as restrictive for insert to authenticated
  with check (coalesce(private.user_role((select auth.uid())), '') <> 'student');
