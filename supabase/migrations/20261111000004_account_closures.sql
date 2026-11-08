-- Leave Meridies: a counselor's account closure with a 30-day grace period (Task 11b).
--
-- `account_closures` holds one row per counselor who asked to close their account. Nothing is deleted when they
-- ask: the account keeps working (read and write) until `purge_after` (requested + 30 days), and they can cancel
-- any time before then. The purge (POST /internal/account-closures/purge) deletes the account through the same
-- code path as DELETE /account, and only when ACCOUNT_PURGE_ENABLED=true (off by default).
--
-- Status: pending -> cancelled (the counselor changed their mind), pending -> purging -> done | failed. A failed
-- row keeps `last_error` (the reason in words, e.g. a student still on the caseload); confirming again puts it
-- back to pending. Deleting the profile cascades this row, so the purge records its outcome in `audit_log`
-- (account.closure.purging, account.deleted, account.closure.purged) before and after the deletion.
--
-- Access: a counselor reads only their own row; every write is the API's (service role). No client write grant.
--
-- Deploy order: either. Additive only. Until it is applied the /account/closure routes answer 503
-- `account_closure_unavailable` and the purge answers `ran: false`. Not in REQUIRED_SCHEMA.
-- No job_heartbeats row here on purpose: the purge has no cron yet, and a row would read overdue on
-- /internal/status. Add it when the Railway cron is created (AGENTS.md, "Leave Meridies").

create table if not exists public.account_closures (
  counselor_id  uuid primary key references public.profiles(id) on delete cascade,
  requested_at  timestamptz not null default now(),
  purge_after   timestamptz not null,
  status        text not null default 'pending'
                check (status in ('pending', 'cancelled', 'purging', 'done', 'failed')),
  cancelled_at  timestamptz,
  last_error    text check (last_error is null or length(last_error) <= 1000),
  updated_at    timestamptz not null default now()
);

create index if not exists account_closures_due on public.account_closures (purge_after) where status = 'pending';

drop trigger if exists account_closures_set_updated_at on public.account_closures;
create trigger account_closures_set_updated_at before update on public.account_closures
  for each row execute function public.set_updated_at();

alter table public.account_closures enable row level security;
revoke all on public.account_closures from public, anon, authenticated;
grant select on public.account_closures to authenticated;
grant all on public.account_closures to service_role;

drop policy if exists account_closures_select_own on public.account_closures;
create policy account_closures_select_own on public.account_closures
  for select to authenticated
  using (counselor_id = (select auth.uid()));

-- A pending or revoked counselor reads nothing here through PostgREST (20261017000001); the API reads their own row
-- with the service role, keyed by their verified id, so a pending account can still close itself.
select private.attach_approval_gate('public.account_closures');
