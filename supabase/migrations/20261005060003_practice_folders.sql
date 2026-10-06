-- Files: the practice-wide folders every counselor's drive starts with.
--
-- The demo seeds two beside the per-student folders: "Practice templates" and
-- "Policy & research". The second is load-bearing since v8 — the Colleges
-- tab's Search & Research files every pasted resource into it, one subfolder
-- per school — so it has to exist for every counselor rather than depend on
-- someone having made a folder with that exact name.
--
-- `system_key` names the folder a feature looks up; the name stays the
-- counselor's to change. These are `is_system`, like the student folders:
-- they can be renamed but not deleted or moved, because the Colleges filing
-- path looks them up by key.

alter table public.folders
  add column if not exists system_key text
    check (system_key in ('practice-templates','policy-research'));

-- A plain (non-partial) unique index, so PostgREST's upsert can name it as
-- the conflict target. NULLs are distinct, so ordinary folders are unaffected.
create unique index if not exists folders_owner_system_key
  on public.folders (owner_id, system_key);

alter table public.folders drop constraint if exists folders_system_key_custom;
alter table public.folders add constraint folders_system_key_custom
  check (system_key is null or (kind = 'custom' and parent_id is null and student_id is null));

comment on column public.folders.system_key is
  'Names a practice folder a feature files into (policy-research: Colleges research). Set by the API, never by a client.';

-- Make them for every counselor already here. New counselors get them from
-- the API on their first Files read (lib/practiceFolders.ts).
insert into public.folders (owner_id, name, kind, is_system, sort_order, system_key)
select p.id, v.name, 'custom', true, v.sort_order, v.key
from public.profiles p
cross join (values
  ('practice-templates', 'Practice templates', 1),
  ('policy-research',    'Policy & research',  2)
) as v(key, name, sort_order)
where p.role = 'counselor'
on conflict (owner_id, system_key) do nothing;
