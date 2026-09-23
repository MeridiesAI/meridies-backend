-- Backfilled from the live project (version 20260806133434). Verbatim.

-- Revoking from anon/authenticated alone doesn't override an implicit PUBLIC grant —
-- revoke from PUBLIC directly so these aren't RPC-exposed to anyone.
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.set_updated_at() from public;
