-- A restored meeting sends its invitation again (Elvin, 11/8; AxIS security PR C's backend half).
--
-- meetings.delete removed the event from the counselor's connected calendar and emailed a cancellation (SEQUENCE =
-- the meeting's ics_sequence + 1), so a meeting the AxIS card's Restore puts back would be in Meridies while the
-- families think it's off. After a successful axis_trash_restore the undo route calls this, then sends the meeting
-- the same invite round a new meeting gets and puts it back on the counselor's calendar the way a new one gets there.
--
-- What it does, for the counselor who deleted and restored (auth.uid() = deleted_by, the restore's own rule):
--   - lists the meetings the action's restore brought back (trash rows of kind 'delete', restored), each with the
--     calendar it was on before the delete (axis_trash_restore cleared calendar_provider / calendar_event_id);
--   - raises each one's ics_sequence to at least what it was + 2, above the cancellation the delete sent. The
--     meetings_ics_sequence trigger would hold a client's write to the old value (it only keeps or adds one), so
--     this runs as the restore does, with meridies.axis_restore on for the update (the trigger is WHEN-guarded off).
-- Calling it again changes nothing more (greatest()). Anyone else, a non-counselor, or an action not restored gets [].
--
-- Deploy order: either. Before it, the route finds no function (PGRST202) and the restore sends nothing, as before.
-- Not in REQUIRED_SCHEMA. No table is created, so no RLS or approval gate to attach.

create or replace function public.axis_trash_restored_meetings(p_action uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null or p_action is null or not coalesce(private.is_counselor(v_uid), false) then
    return '[]'::jsonb;
  end if;
  perform set_config('meridies.axis_restore', 'on', true);
  with gone as (
    select (t.row_pk ->> 'id')::uuid as id,
           t.row_data ->> 'calendar_provider' as provider,
           nullif(t.row_data ->> 'calendar_event_id', '') is not null as had_event,
           coalesce((t.row_data ->> 'ics_sequence')::integer, 0) as seq
    from private.axis_trash t
    where t.action_id = p_action
      and t.table_name = 'meetings'
      and t.kind = 'delete'
      and t.deleted_by = v_uid
      and t.restored_at is not null
  ), bumped as (
    update public.meetings m
       set ics_sequence = greatest(m.ics_sequence, g.seq + 2)
      from gone g
     where m.id = g.id
    returning m.id, g.provider, g.had_event
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id,
           'calendarProvider', case when b.had_event and b.provider in ('google', 'microsoft') then b.provider end
         )), '[]'::jsonb)
    into v_out
    from bumped b;
  perform set_config('meridies.axis_restore', 'off', true);
  return v_out;
end;
$$;
revoke all on function public.axis_trash_restored_meetings(uuid) from public, anon, service_role;
grant execute on function public.axis_trash_restored_meetings(uuid) to authenticated;
