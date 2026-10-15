-- Questionnaire sync, 3 of 4: a counselor's held import beats the student's
-- own questionnaire answer by default.
--
-- Imported data for an invited student waits in the counselor's "Ready to
-- apply" queue (20261014000007), and the student usually fills in the
-- questionnaire while it waits, so the questionnaire may fill a field the
-- import also holds. The queue used to default a field to keep_old whenever
-- the record held anything. Now a field whose value is still exactly what the
-- questionnaire wrote (private.intake_owns_current) defaults to accept, so the
-- counselor's data wins unless they choose otherwise, and the queue says where
-- the current value came from (currentSource 'intake').
--
-- Bodies copied from 20261014000007; the only changes are marked NEW.

-- True when the field holds a value and it is exactly what the questionnaire
-- last wrote there (same hash rule as import provenance).
create or replace function private.intake_owns_current(p_student uuid, p_target text, p_field text, p_cur jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_cur is not null and exists (
    select 1 from public.intake_fills f
     where f.student_id = p_student and f.target_table = p_target and f.field = p_field
       and f.value_hash = private.import_value_hash(p_cur));
$$;
revoke all on function private.intake_owns_current(uuid, text, text, jsonb) from public, anon, authenticated;

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
          'currentValue', case when ch.op = 'set_field' and w.ok then cur.v end,
          -- NEW: where the current value came from, when it is the questionnaire's.
          'currentSource', case when ch.op = 'set_field' and w.ok
                                     and private.intake_owns_current(it.student_id, ch.target_table, ch.field, cur.v)
                                then 'intake' end,
          -- Without write access the stored value is unknown: keep it by default.
          'defaultDecision', case
             when ch.op = 'insert_row' then 'accept'
             when not w.ok then 'keep_old'
             when cur.v is null then 'accept'
             -- NEW: the student's own questionnaire answer doesn't beat the counselor's import.
             when private.intake_owns_current(it.student_id, ch.target_table, ch.field, cur.v) then 'accept'
             else 'keep_old' end
        ) order by ch.target_table, ch.field)
        from public.import_changes ch
        cross join lateral (
          select case when ch.op = 'set_field'
                      then private.import_current_value(ch.target_table, ch.field, it.student_id) end as v
        ) cur
        where ch.item_id = it.id and ch.state = 'staged'
      ), '[]'::jsonb)
    ) as entry
    from public.import_items it
    join public.profiles p on p.id = it.student_id
    cross join lateral (
      select private.import_can_write_student(it.import_id, it.student_id, (select auth.uid())) as ok
    ) w
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

revoke all on function public.import_held_queue() from public, anon;
revoke all on function public.request_held_apply(uuid, jsonb) from public, anon;
grant execute on function public.import_held_queue() to authenticated;
grant execute on function public.request_held_apply(uuid, jsonb) to authenticated;
