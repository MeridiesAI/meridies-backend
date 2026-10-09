-- Import pipeline, step 1: saving an import (spec §5.7).
-- The browser requests; the backend's import_worker runs commit_import in one
-- transaction on a direct connection. Two runners can't both apply: the
-- import row is locked with SKIP LOCKED and the status must be 'committing'.

create or replace function public.request_import_commit(p_import uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_status text;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select status into v_status from public.roster_imports where id = p_import for update;
  if v_status in ('committing','undoing') then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v_status <> 'review' then
    raise exception 'Only an import in review can be saved' using errcode = '55000';
  end if;
  update public.roster_imports
     set status = 'committing', job_actor = v_me, job_requested_at = now(), job_error = null
   where id = p_import;
end;
$$;

create or replace function public.commit_import(p_import uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  v_problems jsonb;
  c record;
  v_ok boolean;
  v_row uuid;
  v_applied integer := 0;
  v_stale integer := 0;
  v_skipped_items integer := 0;
  v_students integer := 0;
  v_result jsonb;
  v_cur jsonb;
begin
  select * into v from public.roster_imports where id = p_import for update skip locked;
  if not found then
    if exists (select 1 from public.roster_imports where id = p_import) then
      return jsonb_build_object('status', 'busy');
    end if;
    raise exception 'No such import' using errcode = 'P0002';
  end if;
  if v.status <> 'committing' then
    return jsonb_build_object('status', 'not-requested', 'current', v.status);
  end if;
  -- A job claimed by someone else is not this caller's to run.
  if v.job_actor is distinct from p_actor then
    return jsonb_build_object('status', 'not-requested', 'current', v.status);
  end if;

  if not private.can_manage_import(p_import, p_actor) then
    update public.roster_imports
       set status = 'review', job_error = jsonb_build_object('message', 'You no longer have access to this import')
     where id = p_import;
    return jsonb_build_object('status', 'review');
  end if;

  -- Steps 2 and 3 share one sub-transaction: if validation finds problems the
  -- item skips are rolled back too, so nothing at all is changed.
  begin
    -- Step 2: students the actor may no longer write are skipped with a reason.
    update public.import_items i
       set match_status = 'skipped', skip_reason = 'This student is no longer on your roster'
     where i.import_id = p_import
       and i.match_status in ('matched_email','confirmed')
       and not private.import_can_write_student(p_import, i.student_id, p_actor);
    get diagnostics v_skipped_items = row_count;

    -- Step 3: one validation pass; any problem sends the import back untouched.
    v_problems := private.import_validate(p_import, null);
    if jsonb_array_length(v_problems) > 0 then
      raise exception 'Import has problems' using errcode = 'IMP01';
    end if;
  exception when sqlstate 'IMP01' then
    v_skipped_items := 0;
    update public.roster_imports
       set status = 'review',
           job_error = jsonb_build_object('message', 'Some values need fixing before saving', 'problems', v_problems)
     where id = p_import;
    return jsonb_build_object('status', 'review', 'problems', v_problems);
  end;

  -- Step 4: apply. A GPA scale is written before the GPA on the same item.
  for c in
    select ch.id, ch.op, ch.target_table, ch.field, ch.old_value, ch.new_value, it.student_id
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    where ch.import_id = p_import
      and ch.state = 'staged'
      and ch.decision in ('auto','accept')
      and it.match_status in ('matched_email','confirmed')
    order by it.id, (ch.field = 'gpa_scale') desc, ch.created_at
    for update of ch
  loop
    if c.op = 'set_field' then
      v_ok := private.import_set_field(c.target_table, c.field, c.student_id, c.old_value, c.new_value);
      if v_ok then
        v_cur := private.import_current_value(c.target_table, c.field, c.student_id);
        update public.import_changes
           set state = 'applied', applied_at = now(),
               applied_value = v_cur,
               new_value_hash = private.import_value_hash(v_cur)
         where id = c.id;
        v_applied := v_applied + 1;
      else
        update public.import_changes
           set state = 'skipped_stale', error = 'Changed since you reviewed it; the newer value was kept'
         where id = c.id;
        v_stale := v_stale + 1;
      end if;
    else
      v_row := private.import_insert_row(c.target_table, c.student_id, c.new_value);
      if v_row is null then
        update public.import_changes
           set state = 'skipped_stale', error = 'Already on the student''s record'
         where id = c.id;
        v_stale := v_stale + 1;
      else
        v_cur := private.import_row_snapshot(c.target_table, v_row);
        update public.import_changes
           set state = 'applied', applied_at = now(), target_row_id = v_row,
               applied_value = v_cur,
               new_value_hash = private.import_value_hash(v_cur)
         where id = c.id;
        v_applied := v_applied + 1;
      end if;
    end if;
  end loop;

  select count(distinct it.student_id) into v_students
  from public.import_changes ch
  join public.import_items it on it.id = ch.item_id
  where ch.import_id = p_import and ch.state = 'applied';

  v_result := jsonb_build_object('applied', v_applied, 'stale', v_stale,
                                 'skippedItems', v_skipped_items, 'students', v_students);

  -- Step 5: the audit row is part of the same transaction. Counts only.
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'import.committed', 'roster_import', p_import, v_result);

  -- Step 6.
  update public.roster_imports
     set status = 'committed', committed_at = now(), undo_until = now() + interval '30 days',
         job_error = null, job_result = v_result
   where id = p_import;

  return jsonb_build_object('status', 'committed') || v_result;
end;
$$;

create or replace function public.fail_import_job(p_kind text, p_id uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'commit' then
    update public.roster_imports set status = 'review', job_error = jsonb_build_object('message', p_message)
     where id = p_id and status = 'committing';
  elsif p_kind = 'undo' then
    update public.roster_imports set status = 'committed', job_error = jsonb_build_object('message', p_message)
     where id = p_id and status = 'undoing';
  elsif p_kind = 'apply' then
    update public.import_items set match_status = 'awaiting_counselor', job_error = jsonb_build_object('message', p_message)
     where id = p_id and match_status = 'applying';
  else
    raise exception 'Unknown import job kind: %', p_kind using errcode = '22023';
  end if;
end;
$$;

create or replace function public.import_jobs_due(p_stale_seconds integer)
returns table (kind text, id uuid, actor uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select case i.status when 'committing' then 'commit' else 'undo' end, i.id, i.job_actor
  from public.roster_imports i
  where i.status in ('committing','undoing')
    and i.job_actor is not null
    and coalesce(i.job_requested_at, 'epoch'::timestamptz) < now() - make_interval(secs => p_stale_seconds)
  union all
  select 'apply', it.id, it.job_actor
  from public.import_items it
  where it.match_status = 'applying'
    and it.job_actor is not null
    and coalesce(it.job_requested_at, 'epoch'::timestamptz) < now() - make_interval(secs => p_stale_seconds);
$$;

revoke all on function public.request_import_commit(uuid) from public, anon;
grant execute on function public.request_import_commit(uuid) to authenticated;

revoke all on function public.commit_import(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_import_job(text, uuid, text) from public, anon, authenticated;
revoke all on function public.import_jobs_due(integer) from public, anon, authenticated;
grant execute on function public.commit_import(uuid, uuid) to import_worker, service_role;
grant execute on function public.fail_import_job(text, uuid, text) to import_worker, service_role;
grant execute on function public.import_jobs_due(integer) to import_worker, service_role;
