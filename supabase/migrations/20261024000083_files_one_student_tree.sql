-- A file about one student is never filed in another student's folder tree,
-- whoever writes it.
--
-- A student folder (folders.kind = 'student') and every custom subfolder
-- under it belong to that student: a caseload transfer hands the whole tree
-- to the student's receiver. The files routes refuse filing a document or a
-- link about student B anywhere in student A's tree (routes/files.ts
-- folderTreeStudent, and routes/integrations.ts for Drive/OneDrive imports),
-- but a direct PostgREST write of documents.folder_id / document_links.folder_id
-- skipped that check, and so did a race between moving an empty folder under
-- A's tree and filing B's document into it while it was still outside. These
-- triggers decide it in the database:
--
-- - documents and document_links, on insert and whenever folder_id or
--   student_id changes: the nearest student folder above the target folder
--   (walking parent_id) must be about the same student, or be absent, or the
--   file must have no student. Otherwise 23514.
-- - folders, whenever parent_id, kind or student_id changes: no document or
--   link about another student may sit in the subtree this puts under a
--   student folder (stopping at nested student folders, which are their own
--   trees). Otherwise 23514.
--
-- Each walk locks the folder rows it reads (FOR SHARE) and the folder move
-- holds its row lock, so the two can't interleave: whichever commits second
-- sees the first and is refused. Rows already misfiled before this migration
-- are left alone (caseload transfer unfiles them, 20261024000082); these
-- triggers only refuse new ones, and an update that doesn't change folder_id
-- or student_id never fires them.
--
-- Deploy order: either, and after 20261024000082 in filename order (that
-- transfer unfiles misfiled rows before it moves folders, so it never trips
-- these triggers; the 20261023030002 transfer it replaces would refuse a
-- transfer that merges a folder holding a misfiled file, with the 400 below,
-- which is the safe failure). Code first: the routes already refuse it.
-- Not in REQUIRED_SCHEMA: nothing reads it.

-- The student of the nearest student folder at or above p_folder (null when
-- there is none, or the chain is broken or circular). Locks what it reads.
create or replace function private.folder_tree_student(p_folder uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id     uuid := p_folder;
  v_parent uuid;
  v_kind   text;
  v_sid    uuid;
  v_seen   uuid[] := '{}';
begin
  for i in 1..64 loop
    exit when v_id is null or v_id = any(v_seen);
    v_seen := v_seen || v_id;
    select f.parent_id, f.kind, f.student_id into v_parent, v_kind, v_sid
      from public.folders f where f.id = v_id
      for share;
    if not found then return null; end if;
    if v_kind = 'student' then return v_sid; end if;
    v_id := v_parent;
  end loop;
  return null;
end;
$$;
revoke all on function private.folder_tree_student(uuid) from public, anon, authenticated;

create or replace function private.files_one_student_tree()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if new.folder_id is null or new.student_id is null then
    return new;
  end if;
  v_owner := private.folder_tree_student(new.folder_id);
  if v_owner is not null and v_owner <> new.student_id then
    raise exception 'That folder belongs to a different student' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.files_one_student_tree() from public, anon, authenticated;

drop trigger if exists documents_one_student_tree_ins on public.documents;
create trigger documents_one_student_tree_ins
  before insert on public.documents
  for each row execute function private.files_one_student_tree();
drop trigger if exists documents_one_student_tree_upd on public.documents;
create trigger documents_one_student_tree_upd
  before update of folder_id, student_id on public.documents
  for each row
  when (new.folder_id is distinct from old.folder_id or new.student_id is distinct from old.student_id)
  execute function private.files_one_student_tree();

drop trigger if exists document_links_one_student_tree_ins on public.document_links;
create trigger document_links_one_student_tree_ins
  before insert on public.document_links
  for each row execute function private.files_one_student_tree();
drop trigger if exists document_links_one_student_tree_upd on public.document_links;
create trigger document_links_one_student_tree_upd
  before update of folder_id, student_id on public.document_links
  for each row
  when (new.folder_id is distinct from old.folder_id or new.student_id is distinct from old.student_id)
  execute function private.files_one_student_tree();

create or replace function private.folders_one_student_tree()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  v_target := case when new.kind = 'student' then new.student_id
                   else private.folder_tree_student(new.parent_id) end;
  if v_target is null then
    return new;
  end if;
  if exists (
    with recursive sub as (
      select new.id as id
      union
      select c.id
        from public.folders c join sub on c.parent_id = sub.id
       where c.kind is distinct from 'student'
    )
    select 1 from sub
     where exists (select 1 from public.documents d
                    where d.folder_id = sub.id and d.student_id is not null and d.student_id <> v_target)
        or exists (select 1 from public.document_links l
                    where l.folder_id = sub.id and l.student_id is not null and l.student_id <> v_target)
  ) then
    raise exception 'That folder holds files about a different student' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.folders_one_student_tree() from public, anon, authenticated;

drop trigger if exists folders_one_student_tree on public.folders;
create trigger folders_one_student_tree
  before update of parent_id, kind, student_id on public.folders
  for each row
  when (new.parent_id is distinct from old.parent_id or new.kind is distinct from old.kind
        or new.student_id is distinct from old.student_id)
  execute function private.folders_one_student_tree();

comment on function private.folder_tree_student(uuid) is
  'The student of the nearest student folder at or above a folder (null when none); locks the rows it walks.';
comment on function private.files_one_student_tree() is
  'Refuses filing a document or link about one student in another student''s folder tree (23514).';
comment on function private.folders_one_student_tree() is
  'Refuses moving a folder holding another student''s files under a student folder (23514).';
