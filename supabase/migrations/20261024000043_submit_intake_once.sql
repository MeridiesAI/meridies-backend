-- A repeated Submit from New student moves nothing and returns nothing.
--
-- Why: submit_intake() moved every item that wasn't complete to `review`,
-- the ones already there included, re-stamped `submitted_at` and returned
-- every id, so each repeated POST /me/intake/submit (10 a minute) had AxIS
-- read every attached file again on the student's quota and emailed the
-- counselor again. It now moves only items that are not already in review
-- or complete, returns only those, and when nothing moved on an invitation
-- already submitted it changes nothing (no `submitted_at`, no
-- progress_events row). A Submit after the counselor sent one item back
-- moves, and returns, that item alone.
--
-- Deploy order: either. The API (lib/newStudentIntake.ts) already drops ids
-- that were in review before it called the function, so on a database
-- without this file a repeat still reads and emails nothing; this makes the
-- function itself idempotent and closes the race between two Submits at
-- once (the invitation row is locked FOR UPDATE). Safe for the previous
-- build: same signature, and it reads the returned ids the same way. Not in
-- REQUIRED_SCHEMA.

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

  -- Only what is not already with the counselor moves; a repeated Submit
  -- moves nothing, stamps nothing and returns no ids, so the API reads no
  -- file again and tells nobody again.
  with handed as (
    update public.deliverables d
       set status = 'review', sent_back_note = null, last_activity_at = now()
     where d.intake_invitation_id = v_inv.id
       and d.status not in ('complete', 'review')
    returning d.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from handed;

  if cardinality(v_ids) = 0 and v_inv.submitted_at is not null then
    return v_ids;
  end if;

  update public.invitations set submitted_at = now() where id = v_inv.id;

  insert into public.progress_events (student_id, entity_type, entity_id, event, actor_id, metadata)
  values (v_uid, 'intake', v_inv.id, 'status-changed', v_uid, jsonb_build_object('submitted', true, 'tasks', to_jsonb(v_ids)));

  return v_ids;
end;
$$;

revoke all on function public.submit_intake() from public, anon;
grant execute on function public.submit_intake() to authenticated;
