-- Data & privacy settings, per practice (stress test #2, 10/6).
--
-- The Settings › Data & privacy toggles were local React state: they flipped
-- and forgot. Each one that stays now has a column here and is enforced by the
-- API (lib/practiceSettings.ts); the ones that promised something the product
-- doesn't do were removed from the page rather than stored:
--   - "Improve models with anonymized data": Meridies trains nothing and
--     Anthropic doesn't train on API traffic, so there is nothing to opt into.
--   - "Team members can view all profiles": firm teams (adding a consultant to
--     a firm) aren't built yet; a toggle that gates nothing would mislead.
--   - "Students receive update confirmations": no such message exists.
--
-- One row per practice: a firm's row (firm_id set) or a solo counselor's row
-- (counselor_id set). Everyone in the practice reads it; only a firm
-- owner/admin, or the solo counselor, changes it. A missing row means the
-- defaults, so nothing needs backfilling.

create table if not exists public.practice_settings (
  id                           uuid primary key default gen_random_uuid(),
  firm_id                      uuid references public.firms(id) on delete cascade,
  counselor_id                 uuid references public.profiles(id) on delete cascade,
  -- AxIS summaries of a student, a family report, an aid report, a read link.
  ai_summaries                 boolean not null default true,
  -- AI filing and tracking of uploaded documents.
  auto_parse_documents         boolean not null default true,
  -- Whether a counselor may share a report flag with the student it is about.
  students_see_shared_reports  boolean not null default true,
  updated_by                   uuid references public.profiles(id) on delete set null,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint practice_settings_one_owner check ((firm_id is null) <> (counselor_id is null))
);

create unique index if not exists practice_settings_firm_key
  on public.practice_settings (firm_id) where firm_id is not null;
create unique index if not exists practice_settings_counselor_key
  on public.practice_settings (counselor_id) where counselor_id is not null;

drop trigger if exists practice_settings_set_updated_at on public.practice_settings;
create trigger practice_settings_set_updated_at before update on public.practice_settings
  for each row execute function public.set_updated_at();

alter table public.practice_settings enable row level security;

drop policy if exists practice_settings_select on public.practice_settings;
create policy practice_settings_select on public.practice_settings
  for select to authenticated
  using (
    case when firm_id is null then counselor_id = (select auth.uid())
         else private.crm_firm_member(firm_id, (select auth.uid())) end
  );

drop policy if exists practice_settings_insert on public.practice_settings;
create policy practice_settings_insert on public.practice_settings
  for insert to authenticated
  with check (
    private.is_counselor((select auth.uid()))
    and case when firm_id is null then counselor_id = (select auth.uid())
             else firm_id = private.crm_workspace_firm((select auth.uid()))
                  and private.crm_firm_admin(firm_id, (select auth.uid())) end
  );

drop policy if exists practice_settings_update on public.practice_settings;
create policy practice_settings_update on public.practice_settings
  for update to authenticated
  using (
    case when firm_id is null then counselor_id = (select auth.uid())
         else private.crm_firm_admin(firm_id, (select auth.uid())) end
  )
  with check (
    case when firm_id is null then counselor_id = (select auth.uid())
         else private.crm_firm_admin(firm_id, (select auth.uid())) end
  );

revoke all on public.practice_settings from public, anon, authenticated;
grant select, insert on public.practice_settings to authenticated;
grant update (ai_summaries, auto_parse_documents, students_see_shared_reports, updated_by)
  on public.practice_settings to authenticated;
