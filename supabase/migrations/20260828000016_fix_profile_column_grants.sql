-- Backfilled from the live project (version 20260828221722), where it ran
-- between protect_privileged_profile_columns and
-- fix_handle_new_user_null_role_confirmed. 20260828000014 in this folder
-- already carries the same revoke-then-grant, so on a fresh build this is a
-- no-op; it is kept so the folder and the live history name the same steps.
--
-- The previous migration's column-level REVOKE did nothing: Supabase grants
-- table-level UPDATE on public.profiles to authenticated, and a table-level
-- privilege implies every column. Column-level revokes cannot subtract from it.
--
-- The working form is to drop the table grant entirely and then grant UPDATE on
-- exactly the columns a user may write. role, role_confirmed, counselor_id,
-- firm_id, id, email and created_at are absent from that list by design; they
-- are written only by SECURITY DEFINER functions (confirm_user_role,
-- redeem_invite_code) or by service_role.

revoke update on public.profiles from authenticated, anon;

grant update (
  full_name, avatar_url, phone, timezone, title, headline, hometown,
  high_school, high_school_id, grad_year, onboarding_step, onboarding_complete,
  profile, archived_at, last_active_at, updated_at
) on public.profiles to authenticated;
