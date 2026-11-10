-- AxIS keeps a deleted email template restorable (20261108000003). The Seasonal-emails migration (20261110000003)
-- gave email_blasts a key to the template a blast was queued from, set null when that template is deleted. A row
-- whose key is set null by a covered delete has to be kept too, or Restore would bring the template back and leave
-- every blast it had queued forgetting where it came from. The whole-branch check in
-- test/integration/axis-trash-db.test.mjs ("every child row a covered delete reaches is kept") names exactly this.
--
-- email_blasts is not deleted by AxIS, so it gets only the set-null trigger (like message_deliveries and
-- alumni_records). Its rule is the template's own: the row is the counselor's.
--
-- Deploy order: after 20261110000003 (the column) and 20261108000003 (the trash). Re-runnable.

insert into private.axis_trash_rules (table_name, rule, columns, student_col) values
  ('email_blasts', 'owner', '{counselor_id}', null)
on conflict (table_name) do nothing;

select private.attach_axis_trash('public.email_blasts', '{source_template_id}', false);
