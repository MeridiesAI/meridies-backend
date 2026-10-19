-- request_held_apply checks that the caller may still write the held item's student before it copies
-- that student's current values into import_changes.old_value.
--
-- Why: request_held_apply checked only can_manage_import, then set old_value on every staged change
-- to private.import_current_value(...), the student's live record (contact email, address, birthday,
-- citizenship, GPA, scores), read as SECURITY DEFINER. import_changes_select lets anyone who can view
-- the import read old_value. A firm admin keeps viewing a firm import after its uploader leaves the
-- firm with their students (remove_firm_member), so they could call
--   POST /rest/v1/rpc/request_held_apply {"p_item": "<held item>", "p_decisions": {}}
-- and read the departed student's current record from /rest/v1/import_changes, again each time the
-- worker returned the item to the queue. import_held_queue already hides currentValue without write
-- access (private.import_can_write_student), and apply_held_item refuses the write; this refuses the
-- copy too, with the same rule.
--
-- Body copied from 20261023010003_intake_held_import_default.sql; the only change is marked NEW.
--
-- Deploy order: apply after 20261023010003 (filename order; it uses private.intake_owns_current from
-- that file). Either order with the code: the API calls the function with the same arguments, and a
-- legitimate caller (the student's counselor, a write collaborator, or an admin of the firm the
-- student's counselor is in) passes the check. Safe for the previous build. Not in REQUIRED_SCHEMA.

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
  v_import_status text;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  -- Same lock order as apply and undo: the import first (shared), then the item.
  select ri.status into v_import_status
    from public.roster_imports ri
    join public.import_items x on x.import_id = ri.id
   where x.id = p_item
     for share of ri;
  select * into v from public.import_items where id = p_item for update;
  if not found or not private.can_manage_import(v.import_id, v_me) then
    raise exception 'That held import isn''t yours' using errcode = '42501';
  end if;
  -- NEW: the current values copied into old_value below are readable by anyone who can view the
  -- import, so only someone who may write this student gets them copied (import_held_queue and
  -- apply_held_item ask the same).
  if not private.import_can_write_student(v.import_id, v.student_id, v_me) then
    raise exception 'You no longer have access to this student' using errcode = '42501';
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
    if coalesce(p_decisions ->> k, '') not in ('accept','keep_old','reject') then
      raise exception 'Unknown decision %', p_decisions ->> k using errcode = '22023';
    end if;
  end loop;

  if v_import_status not in ('committed','complete') then
    raise exception 'That import is still being processed. Try again shortly.' using errcode = '55000';
  end if;

  -- Anything the counselor didn't decide gets the queue's default.
  -- The value the counselor decided against is recorded now; apply only
  -- writes if the record still holds it (same rule as commit).
  update public.import_changes ch
     set decision = coalesce(p_decisions ->> ch.id::text,
           case when ch.op = 'insert_row' then 'accept'
                when cur.v is null then 'accept'
                -- NEW: a value only the questionnaire wrote doesn't block the import.
                when private.intake_owns_current(v.student_id, ch.target_table, ch.field, cur.v) then 'accept'
                else 'keep_old' end),
         old_value = case when ch.op = 'set_field' then cur.v else ch.old_value end
    from (select x.id,
                 case when x.op = 'set_field'
                      then private.import_current_value(x.target_table, x.field, v.student_id) end as v
            from public.import_changes x
           where x.item_id = p_item and x.state = 'staged') cur
   where cur.id = ch.id and ch.item_id = p_item and ch.state = 'staged';

  update public.import_items
     set match_status = 'applying', job_actor = v_me, job_requested_at = now(), job_error = null
   where id = p_item;
end;
$$;

revoke all on function public.request_held_apply(uuid, jsonb) from public, anon;
grant execute on function public.request_held_apply(uuid, jsonb) to authenticated;
