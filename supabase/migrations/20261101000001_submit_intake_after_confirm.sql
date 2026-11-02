-- A student confirmed over open requests can still send them.
--
-- Why: a counselor may now confirm a new student without receiving every item
-- (PATCH /invites/:id { confirmed: true, waive: [...] }). The API stores that
-- waiver on the invitation itself: each request not yet received and named in
-- `waive` gets `"waived": true` in `invitations.intake_requests`, in the same
-- write that sets `confirmed_at`. Those items stay open tasks, and the student
-- keeps their red card for them until they send them.
--
-- 1. submit_intake() refused any Submit once `confirmed_at` was set ("Your
--    counselor already has everything"), which was true while confirming needed
--    every item received. It now refuses a confirmed invitation unless one of
--    its WAIVED requests still has an open task. The waiver is read from that
--    stored marker, never inferred from "confirmed and something is open": a
--    student confirmed before this (a legacy backfill, or a request removed
--    after its task was made) has open tasks too, and must stay exactly as they
--    were. A normal confirmation is refused as before. The rest of the function
--    is the 20261024000043 body, unchanged.
-- 2. my_waived_requests(): the ids of the requests the student's accepted
--    invitation was confirmed over, for the student's own red card
--    (GET /me/intake `waivedRequestIds`). Security definer like my_intake().
--
-- Deploy order: either. Safe for the previous build: same signatures, same
-- returns. Before this is applied the marker is still written (the column takes
-- any key), but a Submit from a student confirmed over open items answers 400
-- "Your counselor already has everything" (visible and harmless, the items stay
-- open), and `waivedRequestIds` reads empty, so the app's red card stays gone
-- after confirmation, as it was. Not in REQUIRED_SCHEMA.

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
  -- Confirmed and nothing waived is still open: the counselor has everything.
  -- Confirmed over a waived item: that item is still the student's to send.
  if v_inv.confirmed_at is not null
     and not exists (
       select 1
         from public.deliverables d
         join lateral jsonb_array_elements(v_inv.intake_requests) q on q->>'id' = d.intake_request_id
        where d.intake_invitation_id = v_inv.id
          and d.status <> 'complete'
          and q->>'waived' = 'true'
     ) then
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

create or replace function public.my_waived_requests()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(q->>'id'), '{}'::text[])
    from (
      -- The same invitation my_intake() reads: the newest the student accepted.
      select i.intake_requests, i.confirmed_at
        from public.invitations i
        join public.profiles p on p.id = i.accepted_by and p.counselor_id = i.counselor_id
       where i.accepted_by = auth.uid()
         and i.status = 'accepted'
         and i.audience = 'student'
       order by i.accepted_at desc nulls last
       limit 1
    ) latest
    cross join lateral jsonb_array_elements(latest.intake_requests) q
   where latest.confirmed_at is not null
     and q->>'waived' = 'true';
$$;

revoke all on function public.my_waived_requests() from public, anon;
grant execute on function public.my_waived_requests() to authenticated;
