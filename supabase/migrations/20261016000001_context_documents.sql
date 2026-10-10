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
