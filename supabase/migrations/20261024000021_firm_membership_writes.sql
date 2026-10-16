-- Firm membership changes only through the firm functions.
--
-- firm_members_write_admin (20260828000002) let any firm owner or admin
-- insert, update and delete firm_members rows straight through PostgREST:
-- add a counselor from another practice who never accepted anything (and
-- then read that counselor's roster through firm_consultant_students, put
-- work on their queue, email them with the staff blast), demote or delete
-- the owner's row, or skip the seat limit. firms_update_admin let an admin
-- write firms.owner_id and seats. The rules that should hold ("the owner's
-- seat never changes", "the owner can't leave", seats, an email-bound
-- invitation) live only inside the SECURITY DEFINER functions, which direct
-- table writes never pass through.
--
-- After this file:
--   - firm_members: clients read only. Rows change through create_firm,
--     accept_firm_invitation, set_firm_member_role, remove_firm_member and
--     transfer_caseload (all SECURITY DEFINER, so they keep working).
--   - firms: clients insert nothing (create_firm makes the row) and update
--     only the branding columns PATCH /firms/mine writes. owner_id, seats,
--     plan and slug are no longer client-writable.
--
-- Deploy order: either. The API never writes firm_members or a firm's
-- owner/seats on the caller's client (routes/firms.ts calls the functions,
-- and its branding PATCH writes only the columns granted below), so the
-- current build works with or without this file. Not in REQUIRED_SCHEMA:
-- nothing reads new schema.
--
-- Rows an attacker may already have planted are not deleted here. To audit:
--   select m.* from public.firm_members m join public.profiles p on p.id = m.profile_id
--    where p.firm_id is distinct from m.firm_id;

drop policy if exists firm_members_write_admin on public.firm_members;
revoke insert, update, delete, truncate on table public.firm_members from authenticated, anon;

drop policy if exists firms_insert_owner on public.firms;
revoke insert, delete, truncate on table public.firms from authenticated, anon;
revoke update on table public.firms from authenticated, anon;
grant update (name, website, logo_url, logo_updated_at, banner_url, accent_color, accent_color_source, updated_at)
  on table public.firms to authenticated;
