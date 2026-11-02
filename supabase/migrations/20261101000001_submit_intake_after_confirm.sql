-- A student confirmed over open requests can still send them.
--
-- Why: a counselor may now confirm a new student without receiving every item
-- (PATCH /invites/:id { confirmed: true, waive: [...] }). The waived items stay
-- open tasks, and the student keeps their red card for them until they send
-- them. submit_intake() refused any Submit once `confirmed_at` was set ("Your
-- counselor already has everything"), which was true while confirming needed
-- every item received. It now refuses only when nothing is left open: an
-- invitation confirmed with an item not yet complete takes a Submit like any
-- other, and a normal confirmation (everything complete) is refused exactly as
-- before. The rest of the function is the 20261024000043 body, unchanged.
--
-- Deploy order: either. Safe for the previous build: same signature and the
-- same return. Before this is applied, a Submit from a student confirmed over
-- open items answers 400 "Your counselor already has everything" (visible and
-- harmless: the items stay open); no such student exists until the API with
-- `waive` deploys. Not in REQUIRED_SCHEMA.

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
  -- Confirmed with nothing left open: the counselor has everything. Confirmed
  -- over a waived item: that item is still the student's to send.
  if v_inv.confirmed_at is not null
     and not exists (select 1 from public.deliverables d
                      where d.intake_invitation_id = v_inv.id and d.status <> 'complete') then
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
