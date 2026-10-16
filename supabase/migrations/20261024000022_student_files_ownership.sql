-- Documents, links and folders only about a student the caller can edit.
--
-- documents_write and document_links_write (20260828000006, 20260902000003)
-- accept a write when owner_id is the caller OR the caller can edit the
-- student, and the owner branch never looks at student_id. So any approved
-- counselor could insert a document owned by themselves about a student in
-- another practice: kind 'transcript', ai_access 'allowed' and their own
-- parsed_data, which that student, their counselor's Files and the AI context
-- layer then read. folders_write_owner checked only owner_id, so the same
-- counselor could add a kind = 'student' folder pointing at that student,
-- which shows up in the student's "My documents". 20261010000004 closed the
-- hole for a caller whose role is student; this closes it for everyone.
--
-- RESTRICTIVE policies layered on the existing permissive ones, so nothing a
-- caller may do today about their own students changes:
--   - documents, document_links: a row written (insert or update) names no
--     student, or a student the caller can edit (private.can_edit_student:
--     the student themselves, their primary counselor, a write
--     collaborator). A new row lands unfiled, in one of the caller's own
--     folders, or in the student folder of a student they can edit.
--   - folders: a client creates only plain folders (kind 'custom', no
--     student) under a parent of their own; student folders come from
--     private.ensure_student_folder (SECURITY DEFINER, so unaffected), and
--     an update can't point a folder at a student the caller can't edit.
--   - documents, document_links: a client inserts a row only as its owner
--     (owner_id = the caller). The permissive policies accept a write when
--     the caller can edit the student, whoever owner_id names, so without
--     this a counselor could plant a row "owned" by a counselor in another
--     practice, which then showed in that counselor's Files and, filed into
--     their Policy & research folder, in their college-research prompt.
--   - documents, document_links: a client update never changes owner_id, and
--     moves a row only into a folder the caller may file into (a trigger,
--     because a policy can't compare the old row with the new one).
-- SECURITY DEFINER functions (caseload transfer, the student-folder trigger)
-- run as the table owner and are not subject to these policies or the
-- trigger, which keys off current_user.
--
-- Deploy order: either. The API already checks all of this in code
-- (resolveStudentId(..., "edit") and assertFileableFolder in routes/files.ts
-- and the other upload paths), so the current build works with or without
-- this file, and every client write the API makes passes these policies.
-- Not in REQUIRED_SCHEMA.
--
-- Rows already planted are not deleted. To audit (and the same for
-- public.document_links):
--   select id, owner_id, student_id from public.documents
--    where student_id is not null and not private.can_edit_student(student_id, owner_id);
--   select d.id, d.owner_id, d.folder_id from public.documents d
--     join public.folders f on f.id = d.folder_id
--    where not private.can_file_into_folder(d.folder_id, d.owner_id);

-- True when `viewer` may file a document or link into `folder`: their own
-- folder, or the student folder of a student they can edit.
create or replace function private.can_file_into_folder(folder uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private','public'
as $$
  select exists (
    select 1 from public.folders f
    where f.id = folder
      and (f.owner_id = viewer
           or (f.kind = 'student' and f.student_id is not null
               and private.can_edit_student(f.student_id, viewer)))
  );
$$;

revoke all on function private.can_file_into_folder(uuid, uuid) from public, anon;
grant execute on function private.can_file_into_folder(uuid, uuid) to authenticated;

-- True when `folder` is one of `viewer`'s own. SECURITY DEFINER because a
-- folders policy can't read folders itself (the policy would recurse).
create or replace function private.owns_folder(folder uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'private','public'
as $$
  select exists (select 1 from public.folders f where f.id = folder and f.owner_id = viewer);
$$;

revoke all on function private.owns_folder(uuid, uuid) from public, anon;
grant execute on function private.owns_folder(uuid, uuid) to authenticated;

-- ---- documents --------------------------------------------------------------

drop policy if exists documents_student_editable_insert on public.documents;
create policy documents_student_editable_insert on public.documents
  as restrictive for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (student_id is null or private.can_edit_student(student_id, (select auth.uid())))
    and (folder_id is null or private.can_file_into_folder(folder_id, (select auth.uid())))
  );

drop policy if exists documents_student_editable_update on public.documents;
create policy documents_student_editable_update on public.documents
  as restrictive for update to authenticated
  using (true)
  with check (student_id is null or private.can_edit_student(student_id, (select auth.uid())));

-- ---- document_links ---------------------------------------------------------

drop policy if exists document_links_student_editable_insert on public.document_links;
create policy document_links_student_editable_insert on public.document_links
  as restrictive for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (student_id is null or private.can_edit_student(student_id, (select auth.uid())))
    and (folder_id is null or private.can_file_into_folder(folder_id, (select auth.uid())))
  );

drop policy if exists document_links_student_editable_update on public.document_links;
create policy document_links_student_editable_update on public.document_links
  as restrictive for update to authenticated
  using (true)
  with check (student_id is null or private.can_edit_student(student_id, (select auth.uid())));

-- ---- owner and folder on update (both tables) -------------------------------

-- Deliberately NOT security definer: it keys off current_user, so the
-- SECURITY DEFINER functions that move rows (caseload transfer) and the
-- service role are not affected.
create or replace function private.student_files_guard_client()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'A file keeps its owner' using errcode = '42501';
  end if;
  if new.folder_id is distinct from old.folder_id and new.folder_id is not null
     and not private.can_file_into_folder(new.folder_id, (select auth.uid())) then
    raise exception 'That folder isn''t one you can file into' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.student_files_guard_client() from public, anon, authenticated;

drop trigger if exists documents_guard_client on public.documents;
create trigger documents_guard_client
  before update on public.documents
  for each row execute function private.student_files_guard_client();

drop trigger if exists document_links_guard_client on public.document_links;
create trigger document_links_guard_client
  before update on public.document_links
  for each row execute function private.student_files_guard_client();

-- ---- folders ----------------------------------------------------------------

drop policy if exists folders_client_plain_insert on public.folders;
create policy folders_client_plain_insert on public.folders
  as restrictive for insert to authenticated
  with check (
    kind = 'custom' and student_id is null
    and (parent_id is null or private.owns_folder(parent_id, (select auth.uid())))
  );

drop policy if exists folders_student_editable_update on public.folders;
create policy folders_student_editable_update on public.folders
  as restrictive for update to authenticated
  using (true)
  with check (student_id is null or private.counselor_can_edit_student(student_id, (select auth.uid())));
