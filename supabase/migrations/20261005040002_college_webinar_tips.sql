-- "Supplemental advice from webinars" on the college profile (v8, p. 26-27):
-- what a school's own admissions sessions said, as a rolling feed.
--
-- The demo authors six tips per school from a template. Those are not real
-- sessions, so nothing is seeded: a tip is something a counselor heard and
-- wrote down (or a Meridies curator did, as a firm-less row). Written as
-- paraphrase attributed to the session, never quotation of a person.
--
-- Visibility:
--   - created_by null and firm_id null  -> a Meridies-wide note (service_role
--     writes these), readable by every counselor
--   - firm_id set                       -> the author's firm
--   - firm_id null, created_by set      -> the author alone
-- Only counselors read or write; a student has no view of this page.

create table if not exists public.college_webinar_tips (
  id            uuid primary key default gen_random_uuid(),
  college_id    uuid not null references public.colleges(id) on delete cascade,
  -- "Stanford admissions info session"
  source        text not null check (length(btrim(source)) between 1 and 200),
  session_date  date,
  tip           text not null check (length(btrim(tip)) between 1 and 600),
  source_url    text check (source_url is null or source_url ~ '^https?://'),
  firm_id       uuid references public.firms(id) on delete cascade,
  created_by    uuid references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists college_webinar_tips_college_idx
  on public.college_webinar_tips (college_id, session_date desc nulls last, created_at desc);

drop trigger if exists college_webinar_tips_set_updated_at on public.college_webinar_tips;
create trigger college_webinar_tips_set_updated_at before update on public.college_webinar_tips
  for each row execute function public.set_updated_at();

alter table public.college_webinar_tips enable row level security;

drop policy if exists college_webinar_tips_select on public.college_webinar_tips;
create policy college_webinar_tips_select on public.college_webinar_tips
  for select to authenticated
  using (
    private.is_counselor((select auth.uid()))
    and (
      (created_by is null and firm_id is null)
      or created_by = (select auth.uid())
      or (firm_id is not null and private.is_firm_member(firm_id, (select auth.uid())))
    )
  );

drop policy if exists college_webinar_tips_insert on public.college_webinar_tips;
create policy college_webinar_tips_insert on public.college_webinar_tips
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.is_counselor((select auth.uid()))
    and (firm_id is null or private.is_firm_member(firm_id, (select auth.uid())))
  );

drop policy if exists college_webinar_tips_update on public.college_webinar_tips;
create policy college_webinar_tips_update on public.college_webinar_tips
  for update to authenticated
  using (created_by = (select auth.uid()))
  with check (
    created_by = (select auth.uid())
    and (firm_id is null or private.is_firm_member(firm_id, (select auth.uid())))
  );

drop policy if exists college_webinar_tips_delete on public.college_webinar_tips;
create policy college_webinar_tips_delete on public.college_webinar_tips
  for delete to authenticated
  using (created_by = (select auth.uid()));

revoke all on public.college_webinar_tips from anon, authenticated;
grant select, insert, update, delete on public.college_webinar_tips to authenticated;
grant all on public.college_webinar_tips to service_role;
