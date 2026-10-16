-- A request from New student, once submitted, stays with the counselor.
--
-- Why: the student may move their progress on a counselor task, and on a
-- New student request the guard refused only `complete`. So a student could
-- set an item in review (or received) back to in progress through PATCH
-- /tasks/:id or PostgREST and press Submit again: submit_intake moved it
-- again (20261024000043 moves anything not in review or complete), AxIS read
-- every attached file again on the student's quota and the counselor got
-- another notification and email, in a loop. Now, on a task with
-- intake_request_id, the student:
--   - can't change the status of an item in review or complete (it is with
--     the counselor; only the counselor's Send back or Received moves it);
--   - can't set it to review themselves through a client write: only
--     submit_intake() (SECURITY DEFINER, so current_user is its owner, not
--     authenticated) moves items into review.
-- The rest of the guard is unchanged from 20261015000001: the student's
-- progress fields, their typed answer, and never `complete`.
--
-- Deploy order: either. The API already refuses the same status changes at
-- PATCH /tasks/:id, caps AxIS reads per item and counselor notices per
-- student on Submit (lib/newStudentIntake.ts), so before this file a loop
-- through PostgREST sends at most three emails a day; this closes the
-- PostgREST door. Safe for the previous build: the counselor's sendItemBack
-- and receive run as the counselor and are not affected, and submit_intake
-- still moves items into review. Not in REQUIRED_SCHEMA.

create or replace function private.deliverables_guard_student_edits()
returns trigger
language plpgsql
security invoker
set search_path to 'private','public','pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  -- What a student may move on a task their counselor assigned: its progress,
  -- and on a request from New student, their typed answer.
  v_progress text[] := array['status','current_words','progress_pct','last_activity_at','updated_at'];
begin
  -- Service-role work (the sweep, deliveries) runs without a user.
  if v_uid is null then
    return new;
  end if;

  -- Who a task is for, who made it and which kind it is never change.
  if new.student_id is distinct from old.student_id
     or new.source is distinct from old.source
     or new.created_by is distinct from old.created_by then
    raise exception 'A task''s student, origin and author can''t change' using errcode = '42501';
  end if;

  if v_uid <> old.student_id then
    return new;
  end if;

  if old.intake_request_id is not null then
    v_progress := v_progress || array['intake_answer'];
    -- Received is the counselor's to say.
    if new.status = 'complete' and old.status is distinct from 'complete' then
      raise exception 'Your counselor marks this received' using errcode = '42501';
    end if;
    -- Submitted or received: it is with the counselor until they send it back.
    if old.status in ('review', 'complete') and new.status is distinct from old.status then
      raise exception 'This is with your counselor now' using errcode = '42501';
    end if;
    -- Only Submit (submit_intake, which runs as its owner) hands it in.
    if new.status = 'review' and old.status is distinct from 'review'
       and current_user in ('authenticated', 'anon') then
      raise exception 'Use Submit to send this to your counselor' using errcode = '42501';
    end if;
    -- Submit clears the counselor's send-back note; nothing else does.
    if new.sent_back_note is distinct from old.sent_back_note and new.sent_back_note is not null then
      raise exception 'Only your counselor can change this task' using errcode = '42501';
    end if;
    v_progress := v_progress || array['sent_back_note'];
  end if;

  if old.source = 'counselor' then
    if (to_jsonb(new) - v_progress) is distinct from (to_jsonb(old) - v_progress) then
      raise exception 'Only your counselor can change this task' using errcode = '42501';
    end if;
  else
    -- The student's own task: anything of theirs, but never dress it up as
    -- an assignment.
    if new.assigned_by is distinct from old.assigned_by
       or new.assigned_at is distinct from old.assigned_at then
      raise exception 'Only your counselor assigns tasks' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.deliverables_guard_student_edits() from public, anon, authenticated;
