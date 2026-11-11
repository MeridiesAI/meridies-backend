-- AxIS trash: public_bookings.contact_id is ON DELETE SET NULL to pipeline_contacts, so a contact AxIS deletes
-- (and can restore) clears it. Register the table like email_blasts' source_template_id: the counselor owns the
-- row, the trash keeps the cleared link so Restore puts it back, and the table's own deletes aren't trashed.
do $$
begin
  if to_regclass('private.axis_trash_rules') is not null
     and to_regprocedure('private.attach_axis_trash(regclass, text[], boolean)') is not null then
    insert into private.axis_trash_rules (table_name, rule, columns, student_col) values
      ('public_bookings', 'owner', '{counselor_id}', null)
    on conflict (table_name) do update set rule = excluded.rule, columns = excluded.columns, student_col = excluded.student_col;
    perform private.attach_axis_trash('public.public_bookings', '{contact_id}', false);
  end if;
end;
$$;
