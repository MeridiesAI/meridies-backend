-- ---------------------------------------------------------------------------
-- Make the alert recipient preferences actually bind.
--
-- 20260918000001 added `student_alert_prefs` and nothing read it: the send path
-- picked the first guardian with `alerts_enabled` regardless of `copy_parents`,
-- and `copy_student` had no effect on the wire at all. A switch that does
-- nothing is worse than no switch, because the counselor believes it worked.
--
-- The decision is frozen onto the alert row at queue time rather than re-read at
-- delivery. An alert queued while the student was copied should go out that way
-- even if the preference changes in the hour between queueing and sending —
-- delivery should not silently re-decide something a counselor already approved.
-- ---------------------------------------------------------------------------

alter table public.parent_alerts
  add column if not exists copy_student boolean not null default false;

comment on column public.parent_alerts.copy_student is
  'Whether the student was copied, as decided from student_alert_prefs when the alert was queued. Frozen here on purpose: delivery must not re-decide it from a preference that changed afterwards.';

-- `guardian_id` was already nullable, which is what lets a student-only alert
-- exist at all. Make that explicit rather than incidental: an alert must reach
-- somebody.
alter table public.parent_alerts drop constraint if exists parent_alerts_has_a_recipient;
alter table public.parent_alerts add constraint parent_alerts_has_a_recipient
  check (guardian_id is not null or copy_student);
