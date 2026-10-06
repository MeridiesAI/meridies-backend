-- v10 sync, student-application (3 of 4): essays as one record per document,
-- grouped per college, and the supplement Google Docs.
--
-- Demo: lib/essays.ts (one record per essay, every word count counts its
-- text), lib/supplementDocs.ts (one pre-populated Doc per school: each prompt
-- in bold with its limit, a rule, room for the answer), lib/readDocument.ts,
-- components/student/EssaysPanel.tsx (v9: Drive-style rows under each
-- college's header, "+ Add essay" makes that school's Doc).
--
-- In the demo the Docs are mocked. Here a counselor with Google connected gets
-- a real Doc in their Drive (drive.file scope, shared with the student); one
-- without gets an honest refusal from the route, and can still file an essay
-- from an upload or a Drive / OneDrive import.

-- ---------------------------------------------------------------------------
-- Essays
-- ---------------------------------------------------------------------------

alter table public.essays
  add column if not exists essay_kind text not null default 'supplement'
    check (essay_kind in ('personal-statement','supplement','other')),
  add column if not exists student_college_id    uuid references public.student_colleges(id)    on delete set null,
  add column if not exists college_supplement_id uuid references public.college_supplements(id) on delete set null,
  add column if not exists document_id           uuid references public.documents(id)           on delete set null,
  add column if not exists text_status text not null default 'read'
    check (text_status in ('pending','read','unreadable')),
  add column if not exists text_synced_at timestamptz;

create index if not exists essays_student_college_idx
  on public.essays (student_college_id) where student_college_id is not null;
create index if not exists essays_document_idx
  on public.essays (document_id) where document_id is not null;

comment on column public.essays.text_status is
  'read: body holds the document''s text; pending: a read is in flight; unreadable: a PDF or scan, so no word count is shown.';

-- Word counts are the database's, like award_letters.net_price_cents: a client
-- can no longer send one that disagrees with the text. Non-breaking spaces
-- count as spaces so Postgres and the browser agree.
create or replace function private.essays_set_word_count()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
declare
  t text := btrim(translate(coalesce(new.body, ''), chr(160), ' '), E' \t\r\n');
begin
  new.word_count := case when t = '' then 0
    else coalesce(array_length(regexp_split_to_array(t, E'\\s+'), 1), 0) end;
  return new;
end;
$$;

revoke all on function private.essays_set_word_count() from public, anon, authenticated;

drop trigger if exists essays_set_word_count on public.essays;
create trigger essays_set_word_count before insert or update of body on public.essays
  for each row execute function private.essays_set_word_count();
drop trigger if exists essay_versions_set_word_count on public.essay_versions;
create trigger essay_versions_set_word_count before insert or update of body on public.essay_versions
  for each row execute function private.essays_set_word_count();

-- Recount once so existing rows agree with their text.
update public.essays set body = body where body is not null;

-- Links stay inside one student. An FK check bypasses RLS, so without this a
-- write could point an essay at another student's school row or document.
create or replace function private.essays_links_same_student()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.student_college_id is not null and not exists (
       select 1 from public.student_colleges
        where id = new.student_college_id and student_id = new.student_id) then
    raise exception 'That school is not on this student''s list' using errcode = '23514';
  end if;
  if new.document_id is not null and not exists (
       select 1 from public.documents
        where id = new.document_id and student_id = new.student_id) then
    raise exception 'That document is not filed to this student' using errcode = '23514';
  end if;
  if new.college_supplement_id is not null and new.student_college_id is not null and not exists (
       select 1 from public.college_supplements cs
         join public.student_colleges sc on sc.college_id = cs.college_id
        where cs.id = new.college_supplement_id and sc.id = new.student_college_id) then
    raise exception 'That prompt belongs to a different school' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.essays_links_same_student() from public, anon, authenticated;

drop trigger if exists essays_links_same_student on public.essays;
create trigger essays_links_same_student
  before insert or update of student_id, student_college_id, document_id, college_supplement_id
  on public.essays for each row execute function private.essays_links_same_student();

-- Backfill from the v5 free-text columns.
update public.essays set essay_kind = 'personal-statement'
 where (school is null or btrim(school) = '')
   and title ~* 'personal statement|common app';
update public.essays e set student_college_id = sc.id
  from public.student_colleges sc
 where sc.student_id = e.student_id
   and e.student_college_id is null
   and e.school is not null
   and lower(btrim(e.school)) = lower(sc.name);

-- ---------------------------------------------------------------------------
-- Supplement Docs: one Google Doc per student, school and cycle.
-- ---------------------------------------------------------------------------

create table if not exists public.supplement_docs (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references public.profiles(id) on delete cascade,
  student_college_id  uuid references public.student_colleges(id) on delete set null,
  college_id          uuid references public.colleges(id) on delete set null,
  college_name        text not null check (length(btrim(college_name)) between 1 and 300),
  admission_cycle     text not null check (admission_cycle ~ '^\d{4}-\d{4}$'),
  title               text not null check (length(btrim(title)) between 1 and 300),
  -- Whose Google grant created the Doc and reads it back for word counts.
  owner_id            uuid not null references public.profiles(id) on delete cascade,
  provider            text not null default 'google' check (provider in ('google')),
  external_file_id    text not null check (external_file_id ~ '^[A-Za-z0-9_-]+$' and length(external_file_id) between 5 and 300),
  web_url             text not null check (web_url ~ '^https://'),
  shared_with         text check (length(shared_with) <= 320),
  share_status        text not null default 'not-shared'
                      check (share_status in ('shared','not-shared','failed')),
  -- The prompts the Doc was written from, so a sync can find each answer and a
  -- new cycle's prompts can mark it outdated without rewriting it.
  prompts             jsonb not null default '[]'::jsonb check (jsonb_typeof(prompts) = 'array'),
  text_synced_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists supplement_docs_one_per_school_cycle
  on public.supplement_docs (student_id, lower(college_name), admission_cycle);
create index if not exists supplement_docs_student_idx on public.supplement_docs (student_id, created_at);
drop trigger if exists supplement_docs_set_updated_at on public.supplement_docs;
create trigger supplement_docs_set_updated_at before update on public.supplement_docs
  for each row execute function public.set_updated_at();

alter table public.essays
  add column if not exists supplement_doc_id uuid references public.supplement_docs(id) on delete set null;
create index if not exists essays_supplement_doc_idx
  on public.essays (supplement_doc_id) where supplement_doc_id is not null;

-- The pointer is resolved with owner_id's Google grant, so only that counselor
-- may create or repoint a row (the documents_external_pointer_guard reasoning),
-- and a student may read their Docs but never write the table.
alter table public.supplement_docs enable row level security;
revoke all on public.supplement_docs from anon, authenticated;
grant select, insert, update, delete on public.supplement_docs to authenticated;

drop policy if exists supplement_docs_select on public.supplement_docs;
create policy supplement_docs_select on public.supplement_docs
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

drop policy if exists supplement_docs_insert on public.supplement_docs;
create policy supplement_docs_insert on public.supplement_docs
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and student_id <> (select auth.uid())
    and private.can_edit_student(student_id, (select auth.uid()))
  );

drop policy if exists supplement_docs_update on public.supplement_docs;
create policy supplement_docs_update on public.supplement_docs
  for update to authenticated
  using (owner_id = (select auth.uid()) and private.can_edit_student(student_id, (select auth.uid())))
  with check (owner_id = (select auth.uid()) and private.can_edit_student(student_id, (select auth.uid())));

drop policy if exists supplement_docs_delete on public.supplement_docs;
create policy supplement_docs_delete on public.supplement_docs
  for delete to authenticated
  using (
    student_id <> (select auth.uid())
    and private.can_edit_student(student_id, (select auth.uid()))
  );

-- Without Google connected an essay can still carry a link to where it is
-- written (a Doc the student shared, a Word file online). The link is read back
-- for its word count only with the grant of whoever set it (link_owner_id), so a
-- student cannot plant a link to a counselor's private file and have the
-- counselor's sync copy it into a body the student can read.
alter table public.essays
  add column if not exists external_url  text check (external_url ~ '^https://' and length(external_url) <= 2000),
  add column if not exists link_owner_id uuid references public.profiles(id) on delete set null;

create or replace function private.essays_link_owner_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    return new;
  end if;
  if new.external_url is null then
    new.link_owner_id := null;
    return new;
  end if;
  if tg_op = 'INSERT'
    or new.external_url is distinct from old.external_url
    or new.link_owner_id is distinct from old.link_owner_id
  then
    new.link_owner_id := caller;
  end if;
  return new;
end;
$$;

revoke all on function private.essays_link_owner_guard() from public, anon, authenticated;

drop trigger if exists essays_link_owner_guard on public.essays;
create trigger essays_link_owner_guard
  before insert or update on public.essays
  for each row execute function private.essays_link_owner_guard();

-- An essay may only hang off its own student's Doc.
create or replace function private.essays_supplement_doc_same_student()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.supplement_doc_id is not null and not exists (
       select 1 from public.supplement_docs
        where id = new.supplement_doc_id and student_id = new.student_id) then
    raise exception 'That Doc belongs to a different student' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.essays_supplement_doc_same_student() from public, anon, authenticated;

drop trigger if exists essays_supplement_doc_same_student on public.essays;
create trigger essays_supplement_doc_same_student
  before insert or update of student_id, supplement_doc_id
  on public.essays for each row execute function private.essays_supplement_doc_same_student();
