-- Import pipeline, step 1: held data (spec §5.8). Data for an invited student
-- never attaches on acceptance; it waits in the counselor's "Ready to apply"
-- queue for 30 days. This also carries the old roster flow's staged values
-- into the queue, which fixes the lost-data bug.

create or replace function private.import_hold_legacy_rows(p_invitation uuid, p_student uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.roster_import_rows;
  v_item uuid;
begin
  for r in
    select * from public.roster_import_rows
    where invitation_id = p_invitation and status = 'invited'
  loop
    if exists (select 1 from public.import_items where legacy_row_id = r.id) then
      continue;
    end if;
    insert into public.import_items (import_id, legacy_row_id, locator, match_status, match_confidence,
                                     match_reasons, student_id, invitation_id, imported_name, match_key, held_until)
    values (r.import_id, r.id, jsonb_build_object('row', r.row_number), 'awaiting_counselor', 'medium',
            array['legacy'], p_student, p_invitation, r.full_name,
            jsonb_build_object('email', r.email, 'fullName', r.full_name),
            now() + interval '30 days')
    returning id into v_item;

    insert into public.import_changes (import_id, item_id, target_table, field, op, new_value, decision, source_ref, state)
    select r.import_id, v_item, x.t, x.f, 'set_field', x.v, 'keep_old', 'Row ' || r.row_number,
           case when private.import_value_ok(fl.value_type, x.v) then 'staged' else 'skipped_invalid' end
    from (values
      ('student_academics', 'gpa_weighted',   to_jsonb(r.gpa_weighted)),
      ('student_academics', 'gpa_unweighted', to_jsonb(r.gpa_unweighted)),
      ('student_academics', 'sat_superscore', to_jsonb(r.sat_total)),
      ('student_academics', 'act_composite',  to_jsonb(r.act_composite)),
      ('student_personal_details', 'intended_majors',
         case when r.intended_major is null or btrim(r.intended_major) = '' then null
              else jsonb_build_array(btrim(r.intended_major)) end)
    ) as x(t, f, v)
    join public.import_fields fl on fl.target_table = x.t and fl.field = x.f
    where x.v is not null;
  end loop;
end;
$$;
revoke all on function private.import_hold_legacy_rows(uuid, uuid) from public, anon, authenticated;

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user          uuid := auth.uid();
  v_role          text;
  v_counselor     uuid;
  v_inv           public.invitations;
  v_inviter_role  text;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select role, counselor_id into v_role, v_counselor
  from public.profiles where id = v_user;

  if v_role is distinct from 'student' then
    raise exception 'Only students can accept an invitation' using errcode = '42501';
  end if;
  if v_counselor is not null then
    raise exception 'You are already connected to a counselor' using errcode = '23505';
  end if;

  select * into v_inv
  from public.invitations
  where token = p_token
  for update;

  if not found then
    raise exception 'That invitation link is not valid' using errcode = 'P0002';
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'That invitation was revoked' using errcode = 'P0001';
  end if;
  if v_inv.status = 'accepted' then
    raise exception 'That invitation has already been used' using errcode = '23505';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'That invitation link has expired' using errcode = 'P0001';
  end if;
  if v_inv.counselor_id = v_user then
    raise exception 'You cannot accept your own invitation' using errcode = 'P0001';
  end if;

  select role into v_inviter_role from public.profiles where id = v_inv.counselor_id;
  if v_inviter_role is distinct from 'counselor' then
    raise exception 'That invitation is no longer valid' using errcode = 'P0001';
  end if;

  update public.invitations
     set status = 'accepted', accepted_by = v_user, accepted_at = now()
   where id = v_inv.id;

  update public.profiles
     set counselor_id = v_inv.counselor_id,
         grad_year    = coalesce(nullif(grad_year, ''), v_inv.grad_year::text),
         timezone     = coalesce(nullif(timezone, ''), v_inv.timezone)
   where id = v_user;

  -- NEW: imported data for this invitation waits for the counselor (§5.8).
  update public.import_items
     set match_status = 'awaiting_counselor', student_id = v_user,
         held_until = now() + interval '30 days'
   where invitation_id = v_inv.id and match_status = 'new_invite';

  -- NEW: the old roster flow's staged values join the same queue.
  perform private.import_hold_legacy_rows(v_inv.id, v_user);

  return v_inv.counselor_id;
end;
$function$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The "Ready to apply" queue
-- ---------------------------------------------------------------------------

create or replace function public.import_held_queue()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(entry order by entry ->> 'heldUntil'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'itemId', it.id,
      'importId', it.import_id,
      'importedName', it.imported_name,
      'studentId', it.student_id,
      'studentName', p.full_name,
      'studentEmail', p.email,
      'heldUntil', it.held_until,
      'jobError', it.job_error,
      'changes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', ch.id,
          'targetTable', ch.target_table,
          'field', ch.field,
          'op', ch.op,
          'newValue', ch.new_value,
          'currentValue', case when ch.op = 'set_field'
                               then private.import_current_value(ch.target_table, ch.field, it.student_id) end,
          'defaultDecision', case
             when ch.op = 'insert_row' then 'accept'
             when private.import_current_value(ch.target_table, ch.field, it.student_id) is null then 'accept'
             else 'keep_old' end
        ) order by ch.target_table, ch.field)
        from public.import_changes ch
        where ch.item_id = it.id and ch.state = 'staged'
      ), '[]'::jsonb)
    ) as entry
    from public.import_items it
    join public.profiles p on p.id = it.student_id
    where it.match_status = 'awaiting_counselor'
      and private.can_view_import(it.import_id, (select auth.uid()))
  ) q;
$$;

create or replace function public.request_held_apply(p_item uuid, p_decisions jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.import_items;
  k text;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v from public.import_items where id = p_item for update;
  if not found or not private.can_manage_import(v.import_id, v_me) then
    raise exception 'That held import isn''t yours' using errcode = '42501';
  end if;
  if v.match_status = 'applying' then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v.match_status <> 'awaiting_counselor' then
    raise exception 'That data is no longer waiting to be applied' using errcode = '55000';
  end if;
  if p_decisions is null or jsonb_typeof(p_decisions) <> 'object' then
    raise exception 'Decisions are required' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_decisions) loop
    if p_decisions ->> k not in ('accept','keep_old','reject') then
      raise exception 'Unknown decision %', p_decisions ->> k using errcode = '22023';
    end if;
  end loop;

  update public.import_changes ch
     set decision = p_decisions ->> ch.id::text
   where ch.item_id = p_item and ch.state = 'staged' and p_decisions ? ch.id::text;

  update public.import_items
     set match_status = 'applying', job_actor = v_me, job_requested_at = now(), job_error = null
   where id = p_item;
end;
$$;

create or replace function public.apply_held_item(p_item uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it public.import_items;
  v_problems jsonb;
  c record;
  v_current jsonb;
  v_after jsonb;
  v_ok boolean;
  v_row uuid;
  v_applied integer := 0;
  v_stale integer := 0;
  v_result jsonb;
  v_import_status text;
begin
  -- Same lock order as undo: the import first (shared), then the item.
  select ri.status into v_import_status
    from public.roster_imports ri
    join public.import_items x on x.import_id = ri.id
   where x.id = p_item
     for share of ri;
  if not found then
    raise exception 'No such item' using errcode = 'P0002';
  end if;
  if v_import_status not in ('committed','complete') then
    return jsonb_build_object('status', 'not-requested', 'current', v_import_status);
  end if;

  select * into it from public.import_items where id = p_item for update skip locked;
  if not found then
    if exists (select 1 from public.import_items where id = p_item) then
      return jsonb_build_object('status', 'busy');
    end if;
    raise exception 'No such item' using errcode = 'P0002';
  end if;
  if it.match_status <> 'applying' then
    return jsonb_build_object('status', 'not-requested', 'current', it.match_status);
  end if;
  -- A job claimed by someone else is not this caller's to run.
  if it.job_actor is distinct from p_actor then
    return jsonb_build_object('status', 'not-requested', 'current', it.match_status);
  end if;
  if not private.can_manage_import(it.import_id, p_actor)
     or not private.import_can_write_student(it.import_id, it.student_id, p_actor) then
    update public.import_items
       set match_status = 'awaiting_counselor',
           job_error = jsonb_build_object('message', 'You no longer have access to this student')
     where id = p_item;
    return jsonb_build_object('status', 'awaiting_counselor');
  end if;

  v_problems := private.import_validate(it.import_id, p_item);
  if jsonb_array_length(v_problems) > 0 then
    update public.import_items
       set match_status = 'awaiting_counselor',
           job_error = jsonb_build_object('message', 'Some values need fixing before applying', 'problems', v_problems)
     where id = p_item;
    return jsonb_build_object('status', 'awaiting_counselor', 'problems', v_problems);
  end if;

  for c in
    select ch.id, ch.op, ch.target_table, ch.field, ch.new_value
    from public.import_changes ch
    where ch.item_id = p_item and ch.state = 'staged' and ch.decision in ('auto','accept')
    order by case when ch.field in ('gpa_weighted','gpa_unweighted') and private.import_num(ch.new_value) <= 10 then 0
                  when ch.field = 'gpa_scale' then 1 else 2 end,
             ch.created_at
    for update of ch
  loop
    if c.op = 'set_field' then
      -- The counselor decided against what the record holds now.
      v_current := private.import_current_value(c.target_table, c.field, it.student_id);
      v_ok := private.import_set_field(c.target_table, c.field, it.student_id, v_current, c.new_value);
      if v_ok then
        v_after := private.import_current_value(c.target_table, c.field, it.student_id);
        update public.import_changes
           set old_value = v_current, state = 'applied', applied_at = clock_timestamp(),
               applied_value = v_after,
               new_value_hash = private.import_value_hash(v_after)
         where id = c.id;
        v_applied := v_applied + 1;
      else
        update public.import_changes
           set state = 'skipped_stale', error = 'Changed while applying; the newer value was kept'
         where id = c.id;
        v_stale := v_stale + 1;
      end if;
    else
      v_row := private.import_insert_row(c.target_table, it.student_id, c.new_value);
      if v_row is null then
        update public.import_changes set state = 'skipped_stale', error = 'Already on the student''s record' where id = c.id;
        v_stale := v_stale + 1;
      else
        v_after := private.import_row_snapshot(c.target_table, v_row);
        update public.import_changes
           set state = 'applied', applied_at = clock_timestamp(), target_row_id = v_row,
               applied_value = v_after,
               new_value_hash = private.import_value_hash(v_after)
         where id = c.id;
        v_applied := v_applied + 1;
      end if;
    end if;
  end loop;

  v_result := jsonb_build_object('applied', v_applied, 'stale', v_stale);
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'import.held_applied', 'import_item', p_item, v_result);
  update public.import_items set match_status = 'applied', job_error = null where id = p_item;
  return jsonb_build_object('status', 'applied') || v_result;
end;
$$;

create or replace function public.expire_import_holds()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired integer := 0;
  v_more integer := 0;
  v_warn jsonb;
begin
  -- Never-accepted invitations: the data goes when the invitation does.
  with gone as (
    update public.import_items it
       set match_status = 'expired', skip_reason = 'The invitation expired before it was accepted'
      from public.invitations i
     where it.invitation_id = i.id
       and it.match_status = 'new_invite'
       and (i.status = 'revoked' or (i.status = 'pending' and i.expires_at < now()))
    returning it.id
  ), del as (
    delete from public.import_changes ch using gone where ch.item_id = gone.id and ch.state = 'staged'
    returning 1
  )
  select count(*) into v_expired from gone;

  -- Accepted but never applied within 30 days.
  with gone as (
    update public.import_items
       set match_status = 'expired', skip_reason = 'Held data expired after 30 days'
     where match_status = 'awaiting_counselor' and held_until < now()
    returning id
  ), del as (
    delete from public.import_changes ch using gone where ch.item_id = gone.id and ch.state = 'staged'
    returning 1
  )
  select count(*) into v_more from gone;
  v_expired := v_expired + v_more;

  -- Warn once, 7 days before.
  with due as (
    update public.import_items it
       set hold_warned_at = now()
     where it.match_status = 'awaiting_counselor'
       and it.hold_warned_at is null
       and it.held_until < now() + interval '7 days'
    returning it.id, it.import_id, it.imported_name, it.held_until
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', due.id, 'counselorId', i.counselor_id, 'counselorEmail', p.email,
           'counselorName', p.full_name, 'importedName', due.imported_name, 'heldUntil', due.held_until)), '[]'::jsonb)
    into v_warn
    from due
    join public.roster_imports i on i.id = due.import_id
    join public.profiles p on p.id = i.counselor_id;

  if v_expired > 0 then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (null, 'import.holds_expired', 'import_item', null, jsonb_build_object('expired', v_expired));
  end if;
  return jsonb_build_object('expired', v_expired, 'warn', v_warn);
end;
$$;

revoke all on function public.import_held_queue() from public, anon;
revoke all on function public.request_held_apply(uuid, jsonb) from public, anon;
grant execute on function public.import_held_queue() to authenticated;
grant execute on function public.request_held_apply(uuid, jsonb) to authenticated;
revoke all on function public.apply_held_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.expire_import_holds() from public, anon, authenticated;
grant execute on function public.apply_held_item(uuid, uuid) to import_worker, service_role;
grant execute on function public.expire_import_holds() to import_worker, service_role;
