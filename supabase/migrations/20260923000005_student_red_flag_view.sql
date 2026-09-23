-- ---------------------------------------------------------------------------
-- The student's view of their own red flags.
--
-- Students could already SELECT their red flags (`red_flags_select` uses
-- can_view_student), but only as the whole row, and nothing in the app showed
-- them one: the notification pointed at the dashboard home. This migration adds
-- the narrow read the new `/dashboard/student/flags` page uses, closes a write
-- hole the student UPDATE policy left open, and repoints old notifications.
--
-- 1. `public.student_red_flags` — a security_invoker view over the columns a
--    student should see: what the flag is, why it was raised, what to do, and
--    where it stands. It leaves out the escalation machinery (baseline_words,
--    escalate_at, escalated_at) — that is the counselor's lever for when a
--    parent alert goes out, and parent alerts are counselor-side by design —
--    and issued_by_id. security_invoker means the caller's RLS on red_flags
--    applies, so the view can never show a row the table would not.
--
-- 2. `red_flags_acknowledge_self` let a student UPDATE any column of their own
--    flag. The API only ever sets `acknowledged`, but PostgREST is reachable
--    with the anon key and the student's own JWT, so a student could resolve
--    a flag, rewrite its message, or push escalate_at into next year. The
--    trigger below restricts a student-originated update to acknowledging.
--    Counselors (is_counselor_of) and the service role (auth.uid() is null —
--    the escalation sweep) are unaffected.
-- ---------------------------------------------------------------------------

create or replace view public.student_red_flags
with (security_invoker = true) as
select
  f.id,
  f.student_id,
  f.deliverable_id,
  f.deadline_id,
  f.severity,
  f.title,
  f.message,
  f.action_items,
  f.trigger,
  f.issued_by,
  f.status,
  f.acknowledged_at,
  f.resolved_at,
  f.created_at,
  f.updated_at
from public.red_flags f
-- A cancelled flag was withdrawn by the counselor; it is not the student's to act on.
where f.status <> 'cancelled';

comment on view public.student_red_flags is
  'Student-safe projection of red_flags. Omits escalation timing and issuer id. security_invoker: red_flags RLS applies.';

-- The schema's default privileges hand `authenticated` every privilege on a new
-- relation, and this view is auto-updatable, so revoke from it too: the view is
-- a read, and writes go to red_flags where the policies and guard live.
revoke all on public.student_red_flags from public, anon, authenticated;
grant select on public.student_red_flags to authenticated;

-- ---------------------------------------------------------------------------
-- A student may acknowledge their flag and nothing else.
-- ---------------------------------------------------------------------------

create or replace function private.red_flags_student_update_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  caller uuid := (select auth.uid());
begin
  -- Service role (the sweep) and counselors of this student pass untouched.
  if caller is null or private.is_counselor_of(old.student_id, caller) then
    return new;
  end if;

  if caller = old.student_id then
    if old.status not in ('open', 'escalated') or new.status <> 'acknowledged' then
      raise exception 'A student may only acknowledge an open red flag'
        using errcode = '42501';
    end if;

    if new.student_id      is distinct from old.student_id
      or new.deliverable_id is distinct from old.deliverable_id
      or new.deadline_id    is distinct from old.deadline_id
      or new.severity       is distinct from old.severity
      or new.title          is distinct from old.title
      or new.message        is distinct from old.message
      or new.action_items   is distinct from old.action_items
      or new.trigger        is distinct from old.trigger
      or new.issued_by      is distinct from old.issued_by
      or new.issued_by_id   is distinct from old.issued_by_id
      or new.baseline_words is distinct from old.baseline_words
      or new.escalate_at    is distinct from old.escalate_at
      or new.escalated_at   is distinct from old.escalated_at
      or new.resolved_at    is distinct from old.resolved_at
      or new.created_at     is distinct from old.created_at
    then
      raise exception 'A student may only acknowledge a red flag'
        using errcode = '42501';
    end if;

    -- The acknowledgement time is the database's, not the client's.
    new.acknowledged_at := now();
  end if;

  return new;
end;
$$;

revoke all on function private.red_flags_student_update_guard() from public, anon, authenticated;

drop trigger if exists red_flags_student_update_guard on public.red_flags;
create trigger red_flags_student_update_guard
  before update on public.red_flags
  for each row execute function private.red_flags_student_update_guard();

-- ---------------------------------------------------------------------------
-- Existing red-flag notifications pointed at the dashboard home, which never
-- showed the flag. Repoint them at the page that does.
-- ---------------------------------------------------------------------------

update public.notifications
set href = '/dashboard/student/flags'
where kind = 'red-flag'
  and (href is null or href = '/dashboard/student');
