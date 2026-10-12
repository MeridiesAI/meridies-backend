-- Invitation delivery status (B5 + E5, the UI half).
--
-- An invitation email is logged in message_deliveries like every other send,
-- but with no student yet (student_id null) and nothing tying it back to the
-- invitation, so the counselor could not read it: message_deliveries_counselor
-- needs a student_id. The Invitations page showed "Invitation sent" even after
-- the webhook had moved the row to delivered or bounced.
--
-- This adds the link and one select policy: the inviting counselor reads the
-- delivery rows of their own invitations. Writes stay service_role only (the
-- backend, lib/email.ts), and the restrictive approval_gate already on the
-- table still applies.

alter table public.message_deliveries
  add column if not exists invitation_id uuid references public.invitations(id) on delete set null;

create index if not exists message_deliveries_invitation_idx
  on public.message_deliveries (invitation_id, created_at desc)
  where invitation_id is not null;

drop policy if exists message_deliveries_invitation_counselor on public.message_deliveries;
create policy message_deliveries_invitation_counselor on public.message_deliveries
  for select to authenticated
  using (
    invitation_id is not null
    and exists (
      select 1 from public.invitations i
      where i.id = message_deliveries.invitation_id
        and i.counselor_id = (select auth.uid())
    )
  );
