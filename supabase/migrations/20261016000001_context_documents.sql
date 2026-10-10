-- Context layer (spec §3.1–§3.3): document kinds the AI allowlist needs, the
-- per-document AI setting, FERPA-waived letters, and students never seeing
-- restricted documents. "Keep out of AI" (available_to_llm) is unchanged and
-- always wins (enforced in src/lib/context/documentAi.ts).

alter table public.documents drop constraint if exists documents_kind_check;
alter table public.documents add constraint documents_kind_check check (kind in
  ('transcript','resume','essay','test-report','award-letter','financial','common-app','other',
   'recommendation-letter','activity-list','iep-504','counselor-only'));

alter table public.documents
  add column if not exists ferpa_waived boolean not null default false,
  add column if not exists ai_access text not null default 'default';
alter table public.documents drop constraint if exists documents_ai_access_check;
alter table public.documents add constraint documents_ai_access_check
  check (ai_access in ('default','allowed','excluded'));
alter table public.documents drop constraint if exists documents_waived_letter_never_ai;
alter table public.documents add constraint documents_waived_letter_never_ai
  check (not (kind = 'recommendation-letter' and ferpa_waived and ai_access = 'allowed'));

comment on column public.documents.ai_access is
  'Context-layer AI setting: default (by kind: transcript, resume, test-report, activity-list allowed), allowed, excluded. available_to_llm=false always wins.';
comment on column public.documents.ferpa_waived is
  'Student waived their right to see this recommendation letter: hidden from the student and never allowed for AI.';

-- Students never see waived letters, IEP/504 or counselor-only documents
-- unless they uploaded them. Restrictive, so it narrows documents_select.
drop policy if exists documents_student_restricted_select on public.documents;
create policy documents_student_restricted_select on public.documents
  as restrictive for select to authenticated
  using (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or owner_id = (select auth.uid())
    or not (
      (kind = 'recommendation-letter' and ferpa_waived)
      or kind in ('iep-504','counselor-only')
    )
  );

-- ---------------------------------------------------------------------------
-- Only a counselor sets the two switches that decide what a student sees and
-- what AI reads (ai_access, ferpa_waived), and a student can't file a document
-- they didn't upload under a restricted kind.
--
-- documents_write lets a student update documents filed under them, also
-- directly through PostgREST, so the rule lives here and not only in the route.
-- Service-role and postgres writes carry no auth.uid() and pass untouched.
-- The other direction (a student re-kinding a restricted document that isn't
-- theirs) needs no code: they can't see the row, so UPDATE and DELETE match
-- nothing (documents_student_restricted_select applies to the WHERE clause).
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
  elsif new.ai_access is distinct from old.ai_access or new.ferpa_waived is distinct from old.ferpa_waived then
    raise exception 'Only your counselor can change those settings' using errcode = '42501';
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

drop trigger if exists documents_guard_student_restricted on public.documents;
create trigger documents_guard_student_restricted
  before insert or update on public.documents
  for each row execute function private.documents_guard_student_restricted();

-- ---------------------------------------------------------------------------
-- A task's document links follow the document: a student who can't see a
-- restricted document doesn't see that it is attached to a task either (its
-- id, role and note). Their own submission rows stay: the file is theirs, so
-- documents RLS shows it to them inside the subquery.
-- ---------------------------------------------------------------------------

drop policy if exists deliverable_documents_student_restricted_select on public.deliverable_documents;
create policy deliverable_documents_student_restricted_select on public.deliverable_documents
  as restrictive for select to authenticated
  using (
    coalesce(private.user_role((select auth.uid())), '') <> 'student'
    or document_id is null
    or exists (select 1 from public.documents d where d.id = document_id)
  );
