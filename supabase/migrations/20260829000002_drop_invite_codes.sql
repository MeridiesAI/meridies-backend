-- Remove the retired invite-code system. Superseded by public.invitations +
-- accept_invitation() (migration 20260829000001). Nothing references
-- invite_codes any more (no inbound FKs; the routes were rewritten).
--
-- Apply this AFTER the rewritten backend is deployed, so the live API is never
-- pointing at a table that's been dropped.

drop function if exists public.redeem_invite_code(text);
drop table if exists public.invite_codes cascade;
