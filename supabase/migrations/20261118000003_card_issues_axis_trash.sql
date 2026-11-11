-- AxIS keeps a deleted Contact Pipeline contact restorable (20261108000003). pipeline_card_issues
-- (20261118000002) cascades from the contact's package and from a card payment, so a covered delete
-- reaches its rows: they are captured with the contact like pipeline_payments, or Restore would bring
-- the contact back without its failed-payment and dispute history. The whole-branch check in
-- test/integration/axis-trash-db.test.mjs ("every child row a covered delete reaches is kept") names it.
--
-- Deploy order: after 20261118000002 and 20261108000003. Skipped when the trash migration isn't in.
-- Re-runnable. Not in REQUIRED_SCHEMA.
do $$
begin
  if to_regclass('private.axis_trash_rules') is not null
     and to_regprocedure('private.attach_axis_trash(regclass, text[], boolean)') is not null then
    insert into private.axis_trash_rules (table_name, rule, columns, student_col) values
      ('pipeline_card_issues', 'parent', '{contact_id}', null)
    on conflict (table_name) do update set rule = excluded.rule, columns = excluded.columns, student_col = excluded.student_col;
    perform private.attach_axis_trash('public.pipeline_card_issues');
  end if;
end;
$$;
