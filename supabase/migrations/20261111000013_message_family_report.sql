-- A family report sent through the composer's delivery path remembers which report it is.
--
--   student_messages.family_report_id   set by POST /reports/family/:id/approve-send on every message row it
--                                       writes (one per channel, audience parent). The dispatch cron reads it:
--                                       a message carrying a report goes only to guardians who still have
--                                       `receives_reports` on when it leaves (on top of the existing checks), and
--                                       is cancelled with the reason when none do. Null for every other message,
--                                       which dispatch treats exactly as before.
--
-- The column rides on the table's existing table-level INSERT grant (a counselor's client writes the rows, the
-- same guard as any composer insert); it is not in the client UPDATE grant, so it can't change after the insert.
-- A trigger keeps it pointing at a report about the same student, so a row can't name another student's report.
-- ON DELETE SET NULL: deleting a report never removes the record of a message that went out.
--
-- Deploy order: before the code that writes it. Without this file approve-send answers 503
-- `family_report_send_unavailable` (it refuses rather than send without the receives_reports re-check) and the
-- rest of the API is unchanged; with it and the previous build, nothing writes the column. Additive only; not in
-- REQUIRED_SCHEMA.

alter table public.student_messages
  add column if not exists family_report_id uuid references public.family_reports(id) on delete set null;

comment on column public.student_messages.family_report_id is
  'The family report this message carries (approve-send). Dispatch re-checks each guardian''s receives_reports for it.';

create index if not exists student_messages_family_report_idx
  on public.student_messages (family_report_id)
  where family_report_id is not null;

create or replace function private.student_messages_report_same_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.family_report_id is not null and not exists (
    select 1 from public.family_reports r where r.id = new.family_report_id and r.student_id = new.student_id
  ) then
    raise exception 'family_report_id must name a report about this student' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.student_messages_report_same_student() from public, anon, authenticated;

drop trigger if exists student_messages_report_same_student on public.student_messages;
create trigger student_messages_report_same_student
  before insert or update of family_report_id, student_id on public.student_messages
  for each row execute function private.student_messages_report_same_student();
