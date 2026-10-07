-- Student view (SV Demo v2), 1 of 5: the signed-in student's own preferences.
--
-- One row per student: the Overview banner (a preset from a short allowlist,
-- or an image they uploaded), the theme, and how reminders reach them (text
-- and/or email, each with its own address).
--
-- These are the student's own choices about the student's own screen and
-- inbox, so the student writes them and nobody else does. The counselor may
-- read them (to see how a reminder will land), never write them.
--
-- This is deliberately NOT student_alert_prefs. That table is counselor-written
-- and decides whether parents are copied on accountability alerts; a student
-- who could write it could switch off the alerts sent about them. Nothing here
-- touches it.

create table if not exists public.student_preferences (
  student_id         uuid primary key references public.profiles(id) on delete cascade,
  banner_preset      text not null default 'pattern'
                       check (banner_preset in ('pattern','forest','dusk','sand')),
  -- A Storage object in the student-banners bucket, under the student's own
  -- prefix ("<student_id>/<file>"). Null means the preset is shown.
  banner_image_path  text check (
                       banner_image_path is null
                       or (length(banner_image_path) <= 300
                           and banner_image_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,200}$')),
  theme              text not null default 'system'
                       check (theme in ('light','dark','system')),
  sms_enabled        boolean not null default false,
  sms_phone          text check (sms_phone is null or sms_phone ~ '^\+[1-9][0-9]{6,14}$'),
  email_enabled      boolean not null default false,
  email_address      text check (email_address is null or (length(email_address) <= 320
                                   and email_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- The image must sit under this student's own prefix, so a row can't point
  -- at another student's upload.
  constraint student_preferences_banner_own_prefix
    check (banner_image_path is null or split_part(banner_image_path, '/', 1) = student_id::text),
  -- A channel switched on needs somewhere to send to.
  constraint student_preferences_sms_needs_phone
    check (not sms_enabled or sms_phone is not null),
  constraint student_preferences_email_needs_address
    check (not email_enabled or email_address is not null)
);

drop trigger if exists student_preferences_set_updated_at on public.student_preferences;
create trigger student_preferences_set_updated_at before update on public.student_preferences
  for each row execute function public.set_updated_at();

comment on table public.student_preferences is
  'SV Demo v2: the student''s own banner, theme and reminder channels. Student-written; the counselor reads. Not student_alert_prefs, which stays counselor-written.';

alter table public.student_preferences enable row level security;
revoke all on table public.student_preferences from anon, authenticated;
grant select, insert, update on table public.student_preferences to authenticated;

drop policy if exists student_preferences_select on public.student_preferences;
create policy student_preferences_select on public.student_preferences
  for select to authenticated
  using (private.can_view_student(student_id, (select auth.uid())));

-- Only the student themselves writes, and only while their account is a
-- student account (a counselor has no preferences row of this kind).
drop policy if exists student_preferences_insert_self on public.student_preferences;
create policy student_preferences_insert_self on public.student_preferences
  for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

drop policy if exists student_preferences_update_self on public.student_preferences;
create policy student_preferences_update_self on public.student_preferences
  for update to authenticated
  using (student_id = (select auth.uid()))
  with check (
    student_id = (select auth.uid())
    and private.user_role((select auth.uid())) = 'student'
  );

-- No delete policy: clearing a preference is an update back to the default.

-- ---------------------------------------------------------------------------
-- The banner image bucket. Private; objects live under "<student_id>/".
-- The student uploads (through a signed upload URL the API mints on the
-- student's own token, so these policies decide it) and may replace or remove
-- their own; their counselor may read, to see the banner the student sees.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-banners', 'student-banners', false, 5242880,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

drop policy if exists student_banners_select on storage.objects;
create policy student_banners_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'student-banners'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (
        (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and private.is_counselor_of(((storage.foldername(name))[1])::uuid, (select auth.uid()))
      )
    )
  );

drop policy if exists student_banners_insert_self on storage.objects;
create policy student_banners_insert_self on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'student-banners'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and private.user_role((select auth.uid())) = 'student'
  );

drop policy if exists student_banners_update_self on storage.objects;
create policy student_banners_update_self on storage.objects
  for update to authenticated
  using (bucket_id = 'student-banners' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'student-banners' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists student_banners_delete_self on storage.objects;
create policy student_banners_delete_self on storage.objects
  for delete to authenticated
  using (bucket_id = 'student-banners' and (storage.foldername(name))[1] = (select auth.uid())::text);
