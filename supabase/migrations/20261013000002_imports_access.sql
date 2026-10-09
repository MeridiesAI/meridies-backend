-- Import pipeline, step 1: who can see and run imports (spec §6.3–§6.4), the
-- private `imports` bucket (§3) and the restricted worker role (§6.2).

-- ---------------------------------------------------------------------------
-- The two access functions. Every policy and every job calls these, so
-- widening access later is a change here only (Appendix A).
-- ---------------------------------------------------------------------------

create or replace function private.can_view_import(p_import uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null and exists (
    select 1 from public.roster_imports i
    where i.id = p_import
      and (
        (i.counselor_id = p_viewer
         and (i.firm_id is null or private.crm_firm_member(i.firm_id, p_viewer)))
        or (i.firm_id is not null and private.crm_firm_admin(i.firm_id, p_viewer))
      )
  );
$$;

-- Same rule today; kept separate so "who may undo" can diverge from "who may see".
create or replace function private.can_manage_import(p_import uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_view_import(p_import, p_viewer);
$$;

-- May this actor write this student's record on behalf of this import?
-- The student's counselor (or a write collaborator), or an admin of the
-- import's firm when the student's counselor is in that firm.
create or replace function private.import_can_write_student(p_import uuid, p_student uuid, p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_student is not null and p_actor is not null and (
    private.counselor_can_edit_student(p_student, p_actor)
    or exists (
      select 1
      from public.roster_imports i
      join public.profiles s on s.id = p_student
      where i.id = p_import
        and i.firm_id is not null
        and private.crm_firm_admin(i.firm_id, p_actor)
        and s.counselor_id is not null
        and private.crm_firm_member(i.firm_id, s.counselor_id)
    )
  );
$$;

revoke all on function private.can_view_import(uuid, uuid) from public, anon;
revoke all on function private.can_manage_import(uuid, uuid) from public, anon;
revoke all on function private.import_can_write_student(uuid, uuid, uuid) from public, anon;
grant execute on function private.can_view_import(uuid, uuid) to authenticated;
grant execute on function private.can_manage_import(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- roster_imports: reads follow can_view_import; the old flow's own writes stay.
-- ---------------------------------------------------------------------------

drop policy if exists roster_imports_owner on public.roster_imports;
drop policy if exists roster_imports_select on public.roster_imports;
create policy roster_imports_select on public.roster_imports
  for select to authenticated
  using (private.can_view_import(id, (select auth.uid())));

drop policy if exists roster_imports_insert_own on public.roster_imports;
create policy roster_imports_insert_own on public.roster_imports
  for insert to authenticated
  with check (counselor_id = (select auth.uid()));

drop policy if exists roster_imports_update_own on public.roster_imports;
create policy roster_imports_update_own on public.roster_imports
  for update to authenticated
  using (counselor_id = (select auth.uid()) and private.can_view_import(id, (select auth.uid())))
  with check (counselor_id = (select auth.uid()));

drop policy if exists roster_imports_delete_own on public.roster_imports;
create policy roster_imports_delete_own on public.roster_imports
  for delete to authenticated
  using (counselor_id = (select auth.uid()) and private.can_view_import(id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- New tables: the browser reads; it never writes (§6.3).
-- ---------------------------------------------------------------------------

grant select on table public.import_files, public.import_items, public.import_changes,
                      public.import_templates, public.import_fields to authenticated;

drop policy if exists import_files_select on public.import_files;
create policy import_files_select on public.import_files
  for select to authenticated using (private.can_view_import(import_id, (select auth.uid())));

drop policy if exists import_items_select on public.import_items;
create policy import_items_select on public.import_items
  for select to authenticated using (private.can_view_import(import_id, (select auth.uid())));

drop policy if exists import_changes_select on public.import_changes;
create policy import_changes_select on public.import_changes
  for select to authenticated using (private.can_view_import(import_id, (select auth.uid())));

drop policy if exists import_templates_select on public.import_templates;
create policy import_templates_select on public.import_templates
  for select to authenticated using (counselor_id = (select auth.uid()));

drop policy if exists import_fields_select on public.import_fields;
create policy import_fields_select on public.import_fields
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Storage: the private `imports` bucket (§3)
-- Path: <counselor_id>/<import_id>/<file_id>-<safe name>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 26214400, array[
  'text/csv', 'text/plain', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.import_object_import_id(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_second text := split_part(p_name, '/', 2);
begin
  if split_part(p_name, '/', 3) = '' then
    return null;
  end if;
  if v_second !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_second::uuid;
end;
$$;

create or replace function private.import_upload_allowed(p_name text, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null
     and split_part(p_name, '/', 1) = p_viewer::text
     and exists (
       select 1 from public.roster_imports i
       where i.id = private.import_object_import_id(p_name)
         and i.counselor_id = p_viewer
         and i.status = 'draft'
     );
$$;

revoke all on function private.import_object_import_id(text) from public, anon;
revoke all on function private.import_upload_allowed(text, uuid) from public, anon;
grant execute on function private.import_object_import_id(text) to authenticated;
grant execute on function private.import_upload_allowed(text, uuid) to authenticated;

drop policy if exists imports_objects_insert on storage.objects;
create policy imports_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'imports' and private.import_upload_allowed(name, (select auth.uid())));

drop policy if exists imports_objects_select on storage.objects;
create policy imports_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'imports'
         and private.can_view_import(private.import_object_import_id(name), (select auth.uid())));
-- No update or delete policy: uploads never overwrite, and the backend deletes.

-- ---------------------------------------------------------------------------
-- import_worker: the only login the backend's direct connection may use.
-- Created NOLOGIN; LOGIN and its password are set by hand outside git
-- (production) or by CI/local setup. It gets EXECUTE on the job functions in
-- the migrations that define them, and nothing else.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'import_worker') then
    create role import_worker nologin noinherit;
  end if;
end;
$$;
grant usage on schema public to import_worker;
