-- Legal promises, part 1: the 13-and-older rule in the database, family consent, and platform terms acceptances.
--
--   private.intake_birthday      the onboarding questionnaire's birthday now has to be 13 to 25 years back (was 10 to 25).
--                                A younger date is skipped, as any other invalid answer is (never written, never quoted).
--   family_consent_requests      one row per consent link a Consultant creates for a student's family. The token is
--                                random and only its sha256 is stored. The public form on meridiesai.com reads and
--                                signs it through the API (routes/familyConsent.ts). Service role writes; a Consultant
--                                reads their own rows. `submission` holds what the guardian typed.
--   platform_terms_acceptances   who accepted which version of the Meridies platform terms, and when. A NEW table: the
--                                existing agreement_acceptances belongs to Consultants' client agreements and is not touched.
--
-- Additive. Deploy order: either. Until applied, the new routes answer 503 and nothing else changes.

create or replace function private.intake_birthday(p text, p_today date)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  d date;
  n integer;
begin
  if p is null or p_today is null or p !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  begin
    d := p::date;
  exception when others then
    return null;
  end;
  -- Postgres reads '2009-02-29' as an error, never as March 1; check anyway.
  if to_char(d, 'YYYY-MM-DD') <> p or d > p_today then
    return null;
  end if;
  n := extract(year from age(p_today, d))::integer;
  if n < 13 or n > 25 then
    return null;
  end if;
  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Family consent
-- ---------------------------------------------------------------------------

create table if not exists public.family_consent_requests (
  id              uuid primary key default gen_random_uuid(),
  counselor_id    uuid not null references public.profiles(id) on delete cascade,
  student_id      uuid not null references public.profiles(id) on delete cascade,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status          text not null default 'pending' check (status in ('pending', 'signed', 'revoked')),
  guardian_email  text check (guardian_email is null or length(guardian_email) <= 254),
  expires_at      timestamptz not null,
  signed_at       timestamptz,
  revoked_at      timestamptz,
  consent_version text check (consent_version is null or length(consent_version) <= 40),
  submission      jsonb check (submission is null or (jsonb_typeof(submission) = 'object' and pg_column_size(submission) <= 8000)),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint family_consent_signed_has_submission check (status <> 'signed' or (signed_at is not null and submission is not null))
);

create index if not exists family_consent_requests_student on public.family_consent_requests (student_id, created_at desc);
create index if not exists family_consent_requests_counselor on public.family_consent_requests (counselor_id, created_at desc);

drop trigger if exists family_consent_requests_set_updated_at on public.family_consent_requests;
create trigger family_consent_requests_set_updated_at before update on public.family_consent_requests
  for each row execute function public.set_updated_at();

alter table public.family_consent_requests enable row level security;
revoke all on public.family_consent_requests from public, anon, authenticated;
grant select on public.family_consent_requests to authenticated;
grant all on public.family_consent_requests to service_role;

-- A Consultant reads the requests they made for their own students. Nobody else: not the student, not a parent.
drop policy if exists family_consent_requests_select on public.family_consent_requests;
create policy family_consent_requests_select on public.family_consent_requests
  for select to authenticated
  using (counselor_id = (select auth.uid()) and private.is_counselor_of(student_id, (select auth.uid())));

select private.attach_approval_gate('public.family_consent_requests');

-- ---------------------------------------------------------------------------
-- Platform terms acceptances
-- ---------------------------------------------------------------------------

create table if not exists public.platform_terms_acceptances (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  terms_version text not null check (length(terms_version) between 1 and 40),
  accepted_at   timestamptz not null default now(),
  constraint platform_terms_acceptances_user_version_key unique (user_id, terms_version)
);

alter table public.platform_terms_acceptances enable row level security;
revoke all on public.platform_terms_acceptances from public, anon, authenticated;
grant select on public.platform_terms_acceptances to authenticated;
grant all on public.platform_terms_acceptances to service_role;

-- Immutable: a person reads their own acceptances; the API (service role) is the only writer, and there is no update or delete.
drop policy if exists platform_terms_acceptances_select on public.platform_terms_acceptances;
create policy platform_terms_acceptances_select on public.platform_terms_acceptances
  for select to authenticated using (user_id = (select auth.uid()));

select private.attach_approval_gate('public.platform_terms_acceptances');
