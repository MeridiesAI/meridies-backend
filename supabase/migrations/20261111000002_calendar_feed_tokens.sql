-- A counselor's subscribable calendar feed (GET /calendar/ical/:token.ics, routes/calendarIcal.ts).
--
-- One token per counselor. The URL is the credential, so only the token's sha256 is stored: the API shows the
-- URL once, when it is made or rotated (POST /calendar/ical), and never again; a lost URL is replaced, not
-- recovered. Rotating replaces the hash (the old URL stops working at once); revoking deletes the row.
-- `last_fetched_at` is set by the public route at most once a minute, so the counselor can see the calendar
-- app is still reading it.
--
-- Service role only: no client grant, no policy. The public route has no user, so it reads with the service role
-- by hash and asks approvedCounselorIds before building anything (an unapproved or revoked counselor's feed is a
-- 404); the authenticated routes write only the caller's own row, keyed by request.auth.userId.
--
-- Deploy order: either. Before it, the routes answer 503 `calendar_feed_unavailable` and the feed URL 404s;
-- the previous build never reads the table. Not in REQUIRED_SCHEMA.

create table if not exists public.calendar_feed_tokens (
  counselor_id    uuid primary key references public.profiles(id) on delete cascade,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  rotated_at      timestamptz,
  last_fetched_at timestamptz
);

comment on table public.calendar_feed_tokens is
  'A counselor''s subscribable calendar feed: the sha256 of the URL token only. Service role only.';

alter table public.calendar_feed_tokens enable row level security;
revoke all on public.calendar_feed_tokens from public, anon, authenticated;
select private.attach_approval_gate('public.calendar_feed_tokens');
