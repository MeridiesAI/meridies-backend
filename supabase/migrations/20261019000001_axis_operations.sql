-- AxIS changes things: axis_actions records every operation AxIS ran or
-- proposed (lib/axis/ops), not only Work Queue proposals and email drafts.
--
--  type 'operation'   : a catalog operation; payload = { op, area, summary,
--                       details, warning, reason, input }.
--  status 'executed'  : an operation that ran at once (its result carries the
--                       reversal for Undo).
--  status 'failed'    : a confirmed operation the API refused.
--  status 'undone'    : the counselor clicked Undo and the reversal ran.
--
-- Safe to apply before the code (nothing writes the new values yet) and the
-- code is safe before it: an auto change still runs and only its audit row is
-- skipped, and a change that needs confirmation is refused with a message
-- naming this migration.

do $$
declare
  c record;
begin
  -- The column CHECKs from 20261018000001 were declared inline, so their
  -- names are Postgres's; find them by what they check rather than by name.
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.axis_actions'::regclass
      and con.contype = 'c'
      and (
        pg_get_constraintdef(con.oid) ~ '\mtype\M'
        or pg_get_constraintdef(con.oid) ~ '\mstatus\M'
        or pg_get_constraintdef(con.oid) ~ '\mpayload\M'
      )
  loop
    execute format('alter table public.axis_actions drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.axis_actions
  add constraint axis_actions_type_check
    check (type in ('work_item', 'email_draft', 'operation')),
  add constraint axis_actions_status_check
    check (status in ('pending', 'confirmed', 'dismissed', 'executed', 'failed', 'undone')),
  -- An email an operation would send is carried whole (its card shows it), so the cap is wider than a proposal's.
  add constraint axis_actions_payload_check
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32000);

-- The trail a turn reads ("what AxIS did earlier in this chat"), newest first.
create index if not exists axis_actions_conversation_recent_idx
  on public.axis_actions (conversation_id, created_at desc);
