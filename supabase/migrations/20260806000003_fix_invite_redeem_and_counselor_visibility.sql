-- Backfilled from the live project (version 20260806133237). Verbatim.
-- invite_codes and the unredeemed-select policy were later dropped by
-- 20260829000002_drop_invite_codes.

-- Allow anyone to see an *unredeemed* invite code row (needed so a student can even
-- locate/redeem one — RLS otherwise hides it from them before they own it).
create policy "invites_select_unredeemed" on public.invite_codes
  for select using (redeemed_by is null);

-- Allow a student to read their own counselor's profile row (name lookup), mirroring
-- the existing reverse policy that lets a counselor read their students' rows.
create policy "profiles_select_own_counselor" on public.profiles
  for select using (id = (select counselor_id from public.profiles self where self.id = auth.uid()));
