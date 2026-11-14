-- invitation_documents: files a consultant adds for a student who has been invited but has not joined yet.
--
-- Why: an invitation is the only record of a new student until they accept (no profiles row, no
-- student folder), so there was nowhere to put their transcript, essays or resume while they fill in
-- the intake form. These rows hold the file (already uploaded to `student-documents`) against the
-- invitation; the moment the invitation is accepted, a trigger files each one as a real `documents`
-- row in the student's folder and deletes the staged row. The object never moves.
--
-- Storage needs no change: staged objects live at `<counselor id>/<invitation id>/<ts>-<name>`, and the
-- first segment (the uploader's own id) is already accepted by the bucket policy and by
-- private.document_storage_path_ok.
--
-- Additive. Deploy order: this migration first, then the API (routes read the table). Safe for the
-- previous build: nothing reads it. NOT in REQUIRED_SCHEMA until the routes ship.

create table if not exists public.invitation_documents (
  id             uuid primary key default gen_random_uuid(),
  invitation_id  uuid not null references public.invitations(id) on delete cascade,
  counselor_id   uuid not null references public.profiles(id) on delete cascade,
  bucket         text not null default 'student-documents' check (bucket = 'student-documents'),
  storage_path   text not null,
  filename       text not null check (length(filename) between 1 and 300),
  title          text check (title is null or length(title) <= 300),
  mime_type      text,
  size_bytes     bigint check (size_bytes >= 0),
  kind           text not null default 'other' check (kind in
                   ('transcript','resume','essay','test-report','award-letter','financial','common-app','other',
                    'recommendation-letter','activity-list','iep-504','counselor-only')),
  created_at     timestamptz not null default now()
);

create unique index if not exists invitation_documents_path on public.invitation_documents (bucket, storage_path);
create index if not exists invitation_documents_invitation_idx on public.invitation_documents (invitation_id, created_at);
create index if not exists invitation_documents_counselor_idx on public.invitation_documents (counselor_id);

alter table public.invitation_documents enable row level security;

revoke all on public.invitation_documents from anon;

drop policy if exists invitation_documents_owner on public.invitation_documents;
create policy invitation_documents_owner on public.invitation_documents
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (
    counselor_id = (select auth.uid())
    and exists (
      select 1 from public.invitations i
       where i.id = invitation_id and i.counselor_id = (select auth.uid()) and i.status = 'pending'
    )
  );

select private.attach_approval_gate('public.invitation_documents');

-- ---------------------------------------------------------------------------
-- The student guard on `documents` must let this migration's trigger through.
--
-- accept_invitation() is called by the STUDENT's session, so inside the trigger below auth.uid() is the
-- student, and private.documents_guard_student_restricted (a user-session check) would refuse the rows: it
-- forbids a student session from queueing extraction and from filing a restricted kind under another owner.
-- The counselor made these rows, not the student. Same rule the storage-path guard uses
-- (20261024000041): only the `authenticated` and `anon` roles are held to it; postgres, service_role and
-- SECURITY DEFINER functions (the trigger below, transfer_caseload) are trusted writers. The body is
-- 20261024000001's, unchanged apart from the first check.
-- ---------------------------------------------------------------------------

create or replace function private.documents_guard_student_restricted()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if v_uid is null then
    return new;
  end if;
  if coalesce(private.user_role(v_uid), '') <> 'student' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.ai_access is distinct from 'default' or new.ferpa_waived is distinct from false then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
    if new.kind_confirmed is distinct from true or new.kind_guess is not null or new.extraction_requested_at is not null
       or new.extraction_attempts is distinct from 0 or new.extraction_lease_until is not null then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
  else
    if new.ai_access is distinct from old.ai_access or new.ferpa_waived is distinct from old.ferpa_waived then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
    if new.kind_confirmed is distinct from old.kind_confirmed
       or new.kind_guess is distinct from old.kind_guess
       or new.extraction_requested_at is distinct from old.extraction_requested_at
       or new.extraction_attempts is distinct from old.extraction_attempts
       or new.extraction_lease_until is distinct from old.extraction_lease_until then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
  end if;

  if new.kind in ('recommendation-letter', 'iep-504', 'counselor-only')
     and new.owner_id is distinct from v_uid
     and (tg_op = 'INSERT' or new.kind is distinct from old.kind) then
    raise exception 'Only your counselor can file a document under that kind' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.documents_guard_student_restricted() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Accepting the invitation files the staged documents into the student's folder.
-- ---------------------------------------------------------------------------

create or replace function private.invitation_documents_on_accepted()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_folder uuid;
begin
  if new.status = 'accepted' and new.accepted_by is not null
     and (old.status is distinct from 'accepted' or old.accepted_by is distinct from new.accepted_by)
     and exists (select 1 from public.invitation_documents where invitation_id = new.id) then

    -- Idempotent; does not depend on whether profiles_student_folder has already fired.
    v_folder := private.ensure_student_folder(new.accepted_by, new.counselor_id);

    -- Files kept out of AI by default (the sort's keepOut kinds) are not queued for text extraction.
    insert into public.documents
      (owner_id, student_id, folder_id, bucket, storage_path, filename, title, mime_type, size_bytes,
       kind, source, available_to_llm, uploaded_by, extraction_requested_at)
    select d.counselor_id, new.accepted_by, v_folder, d.bucket, d.storage_path, d.filename, d.title, d.mime_type,
           d.size_bytes, d.kind, 'upload',
           d.kind not in ('financial', 'iep-504', 'counselor-only'),
           d.counselor_id,
           case when d.kind not in ('financial', 'iep-504', 'counselor-only') then now() end
      from public.invitation_documents d
     where d.invitation_id = new.id
    on conflict (bucket, storage_path) do nothing;

    delete from public.invitation_documents where invitation_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function private.invitation_documents_on_accepted() from public, anon, authenticated;

drop trigger if exists invitation_documents_on_accepted on public.invitations;
create trigger invitation_documents_on_accepted
  after update on public.invitations
  for each row execute function private.invitation_documents_on_accepted();
