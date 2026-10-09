-- New-student onboarding: the student submits what was asked for, the
-- counselor receives each item and confirms the student.
--
-- 1. invitations.submitted_at / confirmed_at. The student presses Submit once
--    every outstanding request has a file or a typed answer; the counselor
--    ticks each request received (intake_requests[].provided, unchanged, so
--    the 20261012000001 triggers keep the task in step) and then confirms.
--    Confirmed is what takes the student off "Building profile" on Overview
--    (GET /invites/building), replacing intake_responses.submitted_at, which
--    nothing in the app wrote.
--
-- 2. deliverables.intake_answer: a short typed answer ("3.92 weighted") for a
--    request that isn't a file. deliverables.sent_back_note: why the counselor
--    sent an item back. The student writes the first, only on intake tasks;
--    the second is the counselor's.
--
-- 3. On an intake task the student never sets "complete": received is the
--    counselor's call. Their files and answers go in by Submit.
--
-- 4. public.submit_intake(): the student's Submit. SECURITY DEFINER because
--    the student can't update the invitation; it only ever touches the
--    caller's own accepted invitation and its tasks.
--
-- 5. public.my_intake(): what the student's request card needs from the
--    invitation (submitted, confirmed), without a SELECT policy on it.
--
-- 6. Backfill: a joined student whose intake questionnaire was submitted is
--    already a normal card; mark them confirmed so they stay one.

-- ---------------------------------------------------------------------------
-- 1. Invitations
-- ---------------------------------------------------------------------------

alter table public.invitations
  add column if not exists submitted_at timestamptz,
  add column if not exists confirmed_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Tasks: the typed answer and the send-back note
-- ---------------------------------------------------------------------------

alter table public.deliverables
  add column if not exists intake_answer  text check (intake_answer is null or char_length(intake_answer) <= 500),
  add column if not exists sent_back_note text check (sent_back_note is null or char_length(sent_back_note) <= 500);

-- ---------------------------------------------------------------------------
-- 3. The student's edits on an intake task
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 4. The student's Submit
-- ---------------------------------------------------------------------------

-- Returns the ids of the tasks it handed in, so the API can have AxIS read
-- their files. Refuses with a message the student can act on.
create or replace function public.submit_intake()
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_inv     public.invitations;
  v_missing text;
  v_ids     uuid[];
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  select i.* into v_inv
    from public.invitations i
    join public.profiles p on p.id = i.accepted_by and p.counselor_id = i.counselor_id
   where i.accepted_by = v_uid
     and i.status = 'accepted'
     and i.audience = 'student'
     and jsonb_array_length(i.intake_requests) > 0
   order by i.accepted_at desc nulls last
   limit 1
   for update of i;
  if not found then
    raise exception 'Your counselor hasn''t asked you for anything' using errcode = 'P0002';
  end if;
  if v_inv.confirmed_at is not null then
    raise exception 'Your counselor already has everything' using errcode = '23514';
  end if;

  -- Every item not yet received needs a file or an answer.
  select string_agg(d.title, ', ' order by d.created_at) into v_missing
    from public.deliverables d
   where d.intake_invitation_id = v_inv.id
     and d.status <> 'complete'
     and nullif(btrim(coalesce(d.intake_answer, '')), '') is null
     and not exists (select 1 from public.deliverable_documents dd
                      where dd.deliverable_id = d.id and dd.role = 'submission');
  if v_missing is not null then
    raise exception 'Still needed: %', v_missing using errcode = '23514';
  end if;

  with handed as (
    update public.deliverables d
       set status = 'review', sent_back_note = null, last_activity_at = now()
     where d.intake_invitation_id = v_inv.id
       and d.status <> 'complete'
    returning d.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from handed;

  update public.invitations set submitted_at = now() where id = v_inv.id;

  insert into public.progress_events (student_id, entity_type, entity_id, event, actor_id, metadata)
  values (v_uid, 'intake', v_inv.id, 'status-changed', v_uid, jsonb_build_object('submitted', true, 'tasks', to_jsonb(v_ids)));

  return v_ids;
end;
$$;

revoke all on function public.submit_intake() from public, anon;
grant execute on function public.submit_intake() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. What the student's request card reads off the invitation
-- ---------------------------------------------------------------------------

create or replace function public.my_intake()
returns table (invitation_id uuid, submitted_at timestamptz, confirmed_at timestamptz, counselor_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select i.id, i.submitted_at, i.confirmed_at, c.full_name
    from public.invitations i
    join public.profiles p on p.id = i.accepted_by and p.counselor_id = i.counselor_id
    left join public.profiles c on c.id = i.counselor_id
   where i.accepted_by = auth.uid()
     and i.status = 'accepted'
     and i.audience = 'student'
   order by i.accepted_at desc nulls last
   limit 1;
$$;

revoke all on function public.my_intake() from public, anon;
grant execute on function public.my_intake() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Backfill
-- ---------------------------------------------------------------------------

update public.invitations i
   set confirmed_at = coalesce(r.submitted_at, now())
  from public.intake_responses r
 where r.student_id = i.accepted_by
   and r.submitted_at is not null
   and i.status = 'accepted'
   and i.confirmed_at is null;
