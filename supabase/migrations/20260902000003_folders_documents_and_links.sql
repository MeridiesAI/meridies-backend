-- Native file organization: folders, a folder reference on documents, an
-- LLM-availability flag, and Upload links.
--
-- "Native organizational tool like google drive: create your own folders; each
-- student automatically receives a folder every time a new student is added."
--
-- The per-student folder is a trigger on the roster linkage rather than
-- something a route remembers to do, matching how this schema already derives
-- rows (handle_new_user, ensure_default_polygon_axes). A counselor who accepts
-- a student at 2am through a path nobody thought about still gets the folder.

-- ---------------------------------------------------------------------------
-- Folders — counselor-owned, arbitrarily nested.
-- ---------------------------------------------------------------------------

create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  parent_id   uuid references public.folders(id) on delete cascade,
  -- Set on the folder automatically created for one student. The student can
  -- read their own folder; that is the only cross-account read.
  student_id  uuid references public.profiles(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 200),
  description text check (length(description) <= 1000),
  kind        text not null default 'custom' check (kind in ('custom','student')),
  color       text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  -- System folders are created by the trigger and may not be deleted by hand;
  -- deleting one would orphan every document filed under a student.
  is_system   boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint folders_student_kind check (
    (kind = 'student' and student_id is not null)
    or (kind = 'custom')
  ),
  constraint folders_no_self_parent check (parent_id is distinct from id)
);

create index if not exists folders_owner_idx on public.folders (owner_id, sort_order);
create index if not exists folders_parent_idx on public.folders (parent_id);
create unique index if not exists folders_one_per_student
  on public.folders (owner_id, student_id) where kind = 'student';

drop trigger if exists folders_set_updated_at on public.folders;
create trigger folders_set_updated_at before update on public.folders
  for each row execute function public.set_updated_at();

-- A folder tree with a cycle is a tree that hangs every recursive read. CHECK
-- constraints can't see other rows, so the invariant needs a trigger.
create or replace function private.folders_reject_cycle()
returns trigger
language plpgsql
security definer
set search_path to 'private','public'
as $function$
declare
  v_parent uuid := new.parent_id;
  v_depth  integer := 0;
begin
  while v_parent is not null loop
    if v_parent = new.id then
      raise exception 'A folder cannot be inside itself' using errcode = '23514';
    end if;
    v_depth := v_depth + 1;
    if v_depth > 20 then
      raise exception 'Folders may not nest more than 20 deep' using errcode = '23514';
    end if;
    select parent_id into v_parent from public.folders where id = v_parent;
  end loop;
  return new;
end;
$function$;

revoke all on function private.folders_reject_cycle() from public, anon, authenticated;

drop trigger if exists folders_reject_cycle on public.folders;
create trigger folders_reject_cycle before insert or update of parent_id on public.folders
  for each row when (new.parent_id is not null)
  execute function private.folders_reject_cycle();

alter table public.folders enable row level security;

-- The owner sees their whole drive; a student sees only the folder that is
-- theirs, and a shared collaborator sees it through can_view_student.
drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (student_id is not null and private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists folders_write_owner on public.folders;
create policy folders_write_owner on public.folders
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Every student gets a folder, automatically, the moment they join a roster.
-- ---------------------------------------------------------------------------

create or replace function private.ensure_student_folder(p_student uuid, p_counselor uuid)
returns uuid
language plpgsql
security definer
set search_path to 'private','public'
as $function$
declare
  v_name   text;
  v_folder uuid;
begin
  if p_student is null or p_counselor is null then
    return null;
  end if;

  select coalesce(nullif(btrim(full_name), ''), 'Student')
    into v_name
    from public.profiles where id = p_student;

  insert into public.folders (owner_id, student_id, name, kind, is_system, sort_order)
  values (p_counselor, p_student, v_name, 'student', true, 0)
  on conflict (owner_id, student_id) where kind = 'student' do nothing
  returning id into v_folder;

  if v_folder is null then
    select id into v_folder
      from public.folders
     where owner_id = p_counselor and student_id = p_student and kind = 'student';
  end if;

  return v_folder;
end;
$function$;

revoke all on function private.ensure_student_folder(uuid, uuid) from public, anon;
grant execute on function private.ensure_student_folder(uuid, uuid) to authenticated;

create or replace function private.student_folder_trigger()
returns trigger
language plpgsql
security definer
set search_path to 'private','public'
as $function$
begin
  if new.role = 'student' and new.counselor_id is not null then
    perform private.ensure_student_folder(new.id, new.counselor_id);
  end if;
  return new;
end;
$function$;

revoke all on function private.student_folder_trigger() from public, anon, authenticated;

-- Fires on the roster linkage, not on sign-up: a student without a counselor
-- has nobody's drive to live in. accept_invitation() sets counselor_id, so
-- acceptance is what creates the folder.
drop trigger if exists profiles_student_folder on public.profiles;
create trigger profiles_student_folder
  after insert or update of counselor_id on public.profiles
  for each row execute function private.student_folder_trigger();

-- Backfill for everyone already on a roster.
insert into public.folders (owner_id, student_id, name, kind, is_system, sort_order)
select p.counselor_id, p.id, coalesce(nullif(btrim(p.full_name), ''), 'Student'), 'student', true, 0
from public.profiles p
where p.role = 'student' and p.counselor_id is not null
on conflict (owner_id, student_id) where kind = 'student' do nothing;

-- ---------------------------------------------------------------------------
-- documents: filing + LLM availability
-- ---------------------------------------------------------------------------

alter table public.documents
  add column if not exists folder_id        uuid references public.folders(id) on delete set null,
  add column if not exists title            text check (length(title) <= 300),
  add column if not exists description      text check (length(description) <= 2000),
  -- Whether this document may be pulled into an AI context window. Opt-out
  -- rather than opt-in, because the tracker and the assistant are the product —
  -- but a counselor must be able to keep a custody order or a medical note out
  -- of every prompt, and that switch has to be per document.
  add column if not exists available_to_llm boolean not null default true,
  add column if not exists source           text not null default 'upload'
                                            check (source in ('upload','link','integration','generated'));

create index if not exists documents_folder_idx on public.documents (folder_id, created_at desc);
create index if not exists documents_llm_idx on public.documents (student_id) where available_to_llm;

comment on column public.documents.available_to_llm is
  'False keeps the document out of every AI context window. Checked in code before a document is read into a prompt; it is not a display preference.';

-- ---------------------------------------------------------------------------
-- Upload links — "send in links to websites or domains, software will read it
-- and aggregate all information that is relevant."
--
-- The row is created immediately with status 'queued' so the UI has something
-- to render; the backend fetches, extracts and summarizes, then moves it to
-- 'read'. A failure is a status, not a lost row.
-- ---------------------------------------------------------------------------

create table if not exists public.document_links (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles(id) on delete cascade,
  student_id      uuid references public.profiles(id) on delete cascade,
  folder_id       uuid references public.folders(id) on delete set null,
  url             text not null check (url ~* '^https?://' and length(url) <= 2000),
  -- Registrable host, kept separate so "everything we've read from ivywise.com"
  -- is an index scan rather than a LIKE over URLs.
  domain          text,
  title           text check (length(title) <= 300),
  kind            text not null default 'page'
                  check (kind in ('page','domain','pdf','feed','unknown')),
  status          text not null default 'queued'
                  check (status in ('queued','reading','read','failed','skipped')),
  -- What the reader pulled out. `summary` is counselor-facing prose about a
  -- third-party page, never student essay content.
  summary         text check (length(summary) <= 4000),
  key_points      text[] not null default '{}',
  extracted       jsonb not null default '{}'::jsonb,
  relevance       text check (relevance in ('high','medium','low','none')),
  content_chars   integer check (content_chars >= 0),
  error           text,
  available_to_llm boolean not null default true,
  ai_run_id       uuid,
  added_by        uuid references public.profiles(id) on delete set null,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists document_links_owner_idx on public.document_links (owner_id, created_at desc);
create index if not exists document_links_student_idx on public.document_links (student_id, created_at desc);
create index if not exists document_links_folder_idx on public.document_links (folder_id);
create index if not exists document_links_domain_idx on public.document_links (lower(domain));
create index if not exists document_links_pending_idx on public.document_links (created_at)
  where status in ('queued','reading');

drop trigger if exists document_links_set_updated_at on public.document_links;
create trigger document_links_set_updated_at before update on public.document_links
  for each row execute function public.set_updated_at();

alter table public.document_links enable row level security;

-- Same shape as documents: the owner, or anyone who may view the student it
-- was filed against.
drop policy if exists document_links_select on public.document_links;
create policy document_links_select on public.document_links
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (student_id is not null and private.can_view_student(student_id, (select auth.uid())))
  );

drop policy if exists document_links_write on public.document_links;
create policy document_links_write on public.document_links
  for all to authenticated
  using (
    owner_id = (select auth.uid())
    or (student_id is not null and private.can_edit_student(student_id, (select auth.uid())))
  )
  with check (
    owner_id = (select auth.uid())
    or (student_id is not null and private.can_edit_student(student_id, (select auth.uid())))
  );
