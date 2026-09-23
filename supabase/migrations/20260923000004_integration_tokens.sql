-- ---------------------------------------------------------------------------
-- OAuth for the Google and Microsoft suites.
--
-- `integrations` records the grant a counselor can see: provider, status and
-- the scopes the provider actually returned. The secrets that grant produces —
-- access and refresh tokens — live here instead, in a table no signed-in user
-- can read or write. RLS is enabled with NO policies for `authenticated` or
-- `anon`, and the table grants are revoked as well, so only the service role
-- (the backend's own client) ever touches a token. Both token columns hold
-- AES-256-GCM ciphertext produced by the API with INTEGRATION_TOKEN_KEY; the
-- database never sees a usable token, so a leaked backup is not a leaked
-- mailbox.
--
-- `integration_oauth_states` is the other half of the handshake: the random
-- `state` a consent redirect carries, bound to the user who asked for it, with
-- the PKCE verifier and a ten-minute expiry. It is stored hashed and consumed
-- with a DELETE ... RETURNING, so a state works exactly once.
-- ---------------------------------------------------------------------------

create table if not exists public.integration_tokens (
  owner_id           uuid not null references public.profiles(id) on delete cascade,
  provider           text not null check (provider in ('google','microsoft')),
  -- The provider's own id for the account (Google `sub`, Microsoft object id).
  -- Used to tell "the counselor edited this file" from "someone else did".
  account_id         text,
  account_email      text check (length(account_email) <= 320),
  access_token_enc   text not null,
  refresh_token_enc  text,
  scopes             text[] not null default '{}',
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (owner_id, provider)
);

drop trigger if exists integration_tokens_set_updated_at on public.integration_tokens;
create trigger integration_tokens_set_updated_at before update on public.integration_tokens
  for each row execute function public.set_updated_at();

alter table public.integration_tokens enable row level security;
-- Deliberately no policies. service_role bypasses RLS; nobody else gets a row.
revoke all on table public.integration_tokens from public, anon, authenticated;

comment on table public.integration_tokens is
  'OAuth tokens for the google/microsoft suite grants. Service role only: RLS on with no policies, grants revoked. Token columns are AES-256-GCM ciphertext (INTEGRATION_TOKEN_KEY); never copy them into integrations.config.';

create table if not exists public.integration_oauth_states (
  -- sha256(state), hex. The raw state only ever exists in the redirect URL.
  state_hash         text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner_id           uuid not null references public.profiles(id) on delete cascade,
  provider           text not null check (provider in ('google','microsoft')),
  code_verifier_enc  text not null,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now()
);

create index if not exists integration_oauth_states_expiry_idx
  on public.integration_oauth_states (expires_at);

alter table public.integration_oauth_states enable row level security;
revoke all on table public.integration_oauth_states from public, anon, authenticated;

comment on table public.integration_oauth_states is
  'Pending OAuth consents: hashed state bound to one user, PKCE verifier (encrypted), 10-minute expiry, consumed once. Service role only.';

-- ---------------------------------------------------------------------------
-- Documents that came out of Drive / OneDrive keep a pointer to the live file.
--
-- The Storage object is a snapshot taken at import. The pointer is what lets
-- the task tracker ask the provider whether the student has been editing the
-- real file since, so someone typing in a Google Doc does not read as stalled.
-- The pointer is resolved with the importer's (owner_id's) grant.
-- ---------------------------------------------------------------------------

alter table public.documents
  add column if not exists external_provider    text check (external_provider in ('google','microsoft')),
  add column if not exists external_file_id     text check (length(external_file_id) <= 300),
  add column if not exists external_drive_id    text check (length(external_drive_id) <= 300),
  add column if not exists external_web_url     text check (external_web_url ~ '^https://'),
  add column if not exists external_modified_at timestamptz;

alter table public.documents drop constraint if exists documents_external_pointer_complete;
alter table public.documents add constraint documents_external_pointer_complete
  check ((external_provider is null) = (external_file_id is null));

create index if not exists documents_external_idx
  on public.documents (external_provider, external_file_id)
  where external_provider is not null;

-- ---------------------------------------------------------------------------
-- Meetings: Teams joins Google Meet as a conference mode, and a meeting the API
-- booked on a real calendar remembers which event it is, so cancelling or
-- moving it here moves it there. Zoom stays out, per the v5 brief.
-- ---------------------------------------------------------------------------

alter table public.meetings drop constraint if exists meetings_mode_check;
alter table public.meetings add constraint meetings_mode_check
  check (mode in ('google-meet','teams','in-person','phone'));

alter table public.meetings
  add column if not exists calendar_provider text check (calendar_provider in ('google','microsoft')),
  add column if not exists calendar_event_id text check (length(calendar_event_id) <= 1024);

alter table public.meetings drop constraint if exists meetings_calendar_pointer_complete;
alter table public.meetings add constraint meetings_calendar_pointer_complete
  check ((calendar_provider is null) = (calendar_event_id is null));

comment on column public.meetings.mode is
  'Google Meet, Microsoft Teams, in person or phone. Zoom was removed in the v5 brief — do not add it back as a "missing" value.';
comment on column public.meetings.calendar_event_id is
  'The event the API created on the counselor''s Google or Outlook calendar, when the meeting was booked with a conference link. Null for meetings recorded only in Meridies.';
