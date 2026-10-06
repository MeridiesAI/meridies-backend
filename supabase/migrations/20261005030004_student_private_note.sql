-- ---------------------------------------------------------------------------
-- The "Add notes" box on a student's Overview card (demo v8-v10).
--
-- The counselor types and it stays: one free-text note per student, saved as
-- they type. It is the counselor's own working note about the student, so it
-- is counselor-only in both directions, like student_status_overrides: the
-- student never reads it.
-- ---------------------------------------------------------------------------

create table if not exists public.student_private_notes (
  student_id  uuid primary key references public.profiles(id) on delete cascade,
  body        text not null default '' check (length(body) <= 4000),
  updated_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists student_private_notes_set_updated_at on public.student_private_notes;
create trigger student_private_notes_set_updated_at before update on public.student_private_notes
  for each row execute function public.set_updated_at();

comment on table public.student_private_notes is
  'The counselor''s free-text note on a student''s Overview card. Counselor-only for select as well as write.';

alter table public.student_private_notes enable row level security;
revoke all on table public.student_private_notes from anon;
grant select, insert, update, delete on table public.student_private_notes to authenticated;

drop policy if exists student_private_notes_counselor on public.student_private_notes;
create policy student_private_notes_counselor on public.student_private_notes
  for all to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())))
  with check (private.is_counselor_of(student_id, (select auth.uid())));
