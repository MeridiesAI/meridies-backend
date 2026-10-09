-- Import pipeline, step 1: undo (spec §5.9). Reverts every applied change
-- whose value is still what the import wrote; anything edited since is kept
-- and reported. Includes held data applied later from "Ready to apply".

create or replace function public.request_import_undo(p_import uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v public.roster_imports;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_manage_import(p_import, v_me) then
    raise exception 'That import isn''t yours' using errcode = '42501';
  end if;
  select * into v from public.roster_imports where id = p_import for update;
  if v.status in ('committing','undoing') then
    raise exception 'That import is already being saved' using errcode = '55000';
  end if;
  if v.status <> 'committed' then
    raise exception 'Only a saved import can be undone' using errcode = '55000';
  end if;
  if v.undo_until is null or now() >= v.undo_until then
    raise exception 'Undo is only available for 30 days after saving' using errcode = 'P0001';
  end if;
  update public.roster_imports
     set status = 'undoing', job_actor = v_me, job_requested_at = now(), job_error = null
   where id = p_import;
end;
$$;

create or replace function public.undo_import(p_import uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.roster_imports;
  c record;
  v_ok boolean;
  v_reverted integer := 0;
  v_kept integer := 0;
  v_revoked integer := 0;
  v_result jsonb;
begin
  select * into v from public.roster_imports where id = p_import for update skip locked;
  if not found then
    if exists (select 1 from public.roster_imports where id = p_import) then
      return jsonb_build_object('status', 'busy');
    end if;
    raise exception 'No such import' using errcode = 'P0002';
  end if;
  if v.status <> 'undoing' then
    return jsonb_build_object('status', 'not-requested', 'current', v.status);
  end if;
  if v.job_actor is distinct from p_actor then
    return jsonb_build_object('status', 'not-requested', 'current', v.status);
  end if;
  if not private.can_manage_import(p_import, p_actor) or v.undo_until is null or now() >= v.undo_until then
    update public.roster_imports
       set status = 'committed',
           job_error = jsonb_build_object('message', 'Undo is only available for 30 days after saving, by someone with access')
     where id = p_import;
    return jsonb_build_object('status', 'committed');
  end if;

  -- Exact reverse of application order.
  for c in
    select ch.id, ch.op, ch.target_table, ch.field, ch.old_value, ch.applied_value, ch.target_row_id, it.student_id
    from public.import_changes ch
    join public.import_items it on it.id = ch.item_id
    where ch.import_id = p_import and ch.state = 'applied'
    order by ch.applied_at desc, ch.created_at desc
    for update of ch
  loop
    if c.op = 'set_field' then
      if c.field in ('gpa_scale','gpa_weighted','gpa_unweighted') then
        begin
          v_ok := private.import_set_field(c.target_table, c.field, c.student_id, c.applied_value, c.old_value);
        exception when check_violation then
          -- e.g. restoring a 4.0 scale under a GPA someone set to 93 since.
          v_ok := false;
        end;
      else
        v_ok := private.import_set_field(c.target_table, c.field, c.student_id, c.applied_value, c.old_value);
      end if;
    elsif private.import_row_snapshot(c.target_table, c.target_row_id) is not distinct from c.applied_value then
      v_ok := private.import_delete_row(c.target_table, c.target_row_id);
    else
      v_ok := false;
    end if;
    if v_ok then
      update public.import_changes set state = 'undone' where id = c.id;
      v_reverted := v_reverted + 1;
    else
      update public.import_changes set state = 'undo_skipped', error = 'Edited since the import; kept' where id = c.id;
      v_kept := v_kept + 1;
    end if;
  end loop;

  update public.invitations
     set status = 'revoked'
   where status = 'pending'
     and id in (select it.invitation_id from public.import_items it
                where it.import_id = p_import and it.match_status = 'new_invite' and it.invitation_id is not null);
  get diagnostics v_revoked = row_count;

  with skipped as (
    update public.import_items
       set match_status = 'skipped', skip_reason = 'The import was undone'
     where import_id = p_import and match_status in ('new_invite','awaiting_counselor','applying')
    returning id
  )
  update public.import_changes
     set state = 'undone', new_value = null
   where import_id = p_import and state = 'staged'
     and item_id in (select id from skipped);

  v_result := jsonb_build_object('reverted', v_reverted, 'kept', v_kept, 'invitationsRevoked', v_revoked);
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'import.undone', 'roster_import', p_import, v_result);

  update public.roster_imports
     set status = 'undone', undone_at = now(), job_error = null, job_result = v_result
   where id = p_import;

  return jsonb_build_object('status', 'undone') || v_result;
end;
$$;

revoke all on function public.request_import_undo(uuid) from public, anon;
grant execute on function public.request_import_undo(uuid) to authenticated;
revoke all on function public.undo_import(uuid, uuid) from public, anon, authenticated;
grant execute on function public.undo_import(uuid, uuid) to import_worker, service_role;
