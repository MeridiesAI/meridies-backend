-- A student reads the texts and emails Meridies sent them (SV Demo v2
-- Notifications, "From your counselor"): rows addressed to the student
-- about themselves. Messages to their guardians and to the counselor stay
-- the counselor's to read, as before. Select only; writes remain the
-- backend's (service_role).

drop policy if exists message_deliveries_student_self on public.message_deliveries;
create policy message_deliveries_student_self on public.message_deliveries
  for select to authenticated
  using (
    recipient_kind = 'student'
    and student_id = (select auth.uid())
    and (recipient_id is null or recipient_id = (select auth.uid()))
  );
