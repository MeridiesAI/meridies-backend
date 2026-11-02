-- Parent communication, step 2: families can answer, and it lands in the app.
--
-- Until now every message was one-way. This adds what a reply needs:
--
--   * messaging_routes     an unguessable address per (counselor, family member)
--                          so a reply to "reply to this email" finds its way
--                          back to the right contact or student. Resend's
--                          inbound webhook decodes it (r-<24 hex>@<reply domain>).
--   * inbound_messages     what a family sent back, by email or text, kept
--                          whether or not it could be placed on a timeline.
--   * consultant_phone_numbers   the Twilio number a consultant texts from,
--                          so a family's reply to a text finds that consultant.
--   * sms_opt_outs         a number that answered STOP to a consultant's
--                          number; nothing is texted to it from that number
--                          again until it answers START.
--   * pipeline_activities  gains the `sms` kind, so a text (sent or received)
--                          is on the contact timeline beside emails.
--
-- Every table here is service-role-written: a family's reply arrives on a
-- webhook that no signed-in user is behind. Counselors READ their own (and
-- their practice's) rows through RLS and write nothing.
--
-- Deploy order: after 20261103000001 is not required; independent of it.
-- Additive only. The code degrades until this is applied (reply routing is
-- skipped and Reply-To falls back to the counselor's own address; the webhooks
-- answer 503 `messaging_unavailable`; the number card reads "not set up"). Not in
-- REQUIRED_SCHEMA. No existing row changes.

-- ---------------------------------------------------------------------------
-- Reply routes
-- ---------------------------------------------------------------------------

create table if not exists public.messaging_routes (
  token         text primary key check (token ~ '^[0-9a-f]{24}$'),
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  -- Which side of the family this address stands for.
  party         text not null check (party in ('parent', 'student')),
  contact_id    uuid references public.pipeline_contacts(id) on delete cascade,
  student_id    uuid references public.profiles(id) on delete cascade,
  guardian_id   uuid references public.guardians(id) on delete cascade,
  created_at    timestamptz not null default now(),
  constraint messaging_routes_has_target check (contact_id is not null or student_id is not null)
);

-- One address per counselor and family member, so a thread keeps one reply
-- address however many times they are written to (null ids compare equal).
create unique index if not exists messaging_routes_one_per_target
  on public.messaging_routes (
    counselor_id,
    party,
    coalesce(contact_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(student_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(guardian_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

alter table public.messaging_routes enable row level security;
revoke all on public.messaging_routes from public, anon, authenticated;
select private.attach_approval_gate('public.messaging_routes');

-- ---------------------------------------------------------------------------
-- What came back
-- ---------------------------------------------------------------------------

create table if not exists public.inbound_messages (
  id                   uuid primary key default gen_random_uuid(),
  channel              text not null check (channel in ('email', 'sms')),
  counselor_id         uuid not null references public.profiles(id) on delete cascade,
  -- The contact's workspace, copied at insert so RLS needs no join.
  firm_id              uuid references public.firms(id) on delete cascade,
  contact_id           uuid references public.pipeline_contacts(id) on delete cascade,
  student_id           uuid references public.profiles(id) on delete cascade,
  guardian_id          uuid references public.guardians(id) on delete set null,
  party                text check (party in ('parent', 'student')),
  -- The sender as the provider reported it: an email address or an E.164 number.
  from_addr            text not null check (length(from_addr) <= 320),
  subject              text check (subject is null or length(subject) <= 500),
  body                 text not null check (length(body) <= 20000),
  -- The provider's id (Resend email id, Twilio MessageSid): a retried webhook
  -- is recognised and writes nothing twice.
  provider_message_id  text not null unique,
  -- Whether the sender is an address/number we hold for this family member,
  -- and (email) whether the provider authenticated the sender (SPF or DKIM).
  sender_known         boolean not null default false,
  authenticated        boolean,
  received_at          timestamptz not null default now(),
  read_at              timestamptz
);

create index if not exists inbound_messages_contact_idx on public.inbound_messages (contact_id, received_at desc)
  where contact_id is not null;
create index if not exists inbound_messages_student_idx on public.inbound_messages (student_id, received_at desc)
  where student_id is not null;
create index if not exists inbound_messages_counselor_idx on public.inbound_messages (counselor_id, received_at desc);

alter table public.inbound_messages enable row level security;

drop policy if exists inbound_messages_select on public.inbound_messages;
create policy inbound_messages_select on public.inbound_messages
  for select to authenticated
  using (
    counselor_id = (select auth.uid())
    or (student_id is not null and private.is_counselor_of(student_id, (select auth.uid())))
    or (contact_id is not null and private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  );

revoke all on public.inbound_messages from public, anon, authenticated;
grant select on public.inbound_messages to authenticated;
-- The counselor marking a reply read is the one client write.
grant update (read_at) on public.inbound_messages to authenticated;

drop policy if exists inbound_messages_mark_read on public.inbound_messages;
create policy inbound_messages_mark_read on public.inbound_messages
  for update to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

select private.attach_approval_gate('public.inbound_messages');

-- ---------------------------------------------------------------------------
-- A consultant's own texting number
-- ---------------------------------------------------------------------------

create table if not exists public.consultant_phone_numbers (
  counselor_id  uuid primary key references public.profiles(id) on delete cascade,
  phone_e164    text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Twilio's id for the purchased number (PN...), kept to release it later.
  twilio_sid    text not null check (twilio_sid ~ '^PN[0-9a-fA-F]{32}$'),
  status        text not null default 'active' check (status in ('active', 'released')),
  created_at    timestamptz not null default now()
);

alter table public.consultant_phone_numbers enable row level security;

drop policy if exists consultant_phone_numbers_select on public.consultant_phone_numbers;
create policy consultant_phone_numbers_select on public.consultant_phone_numbers
  for select to authenticated
  using (counselor_id = (select auth.uid()));

revoke all on public.consultant_phone_numbers from public, anon, authenticated;
grant select (counselor_id, phone_e164, status, created_at) on public.consultant_phone_numbers to authenticated;
select private.attach_approval_gate('public.consultant_phone_numbers');

-- ---------------------------------------------------------------------------
-- STOP
-- ---------------------------------------------------------------------------

create table if not exists public.sms_opt_outs (
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  phone_e164    text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  opted_out_at  timestamptz not null default now(),
  primary key (counselor_id, phone_e164)
);

alter table public.sms_opt_outs enable row level security;
revoke all on public.sms_opt_outs from public, anon, authenticated;
select private.attach_approval_gate('public.sms_opt_outs');

-- ---------------------------------------------------------------------------
-- Texts on the contact timeline
-- ---------------------------------------------------------------------------

alter table public.pipeline_activities drop constraint if exists pipeline_activities_kind_check;
alter table public.pipeline_activities add constraint pipeline_activities_kind_check check (kind in (
  'note', 'call', 'meeting', 'email', 'sms',
  'created', 'stage_change', 'status', 'invite', 'converted',
  'task', 'invoice', 'payment'));

-- A text is a person's entry like an email: a counselor client may add one
-- (the API logs a text it sent), the system kinds still come from triggers.
drop policy if exists pipeline_activities_insert on public.pipeline_activities;
create policy pipeline_activities_insert on public.pipeline_activities
  for insert to authenticated
  with check (
    kind in ('note', 'call', 'meeting', 'email', 'sms')
    and private.crm_can_access(firm_id, counselor_id, (select auth.uid()))
  );

create or replace function private.pipeline_activities_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  c public.pipeline_contacts;
begin
  select * into c from public.pipeline_contacts where id = new.contact_id;
  if not found then
    raise exception 'new row violates row-level security policy for table "pipeline_activities"'
      using errcode = '42501';
  end if;
  new.firm_id := c.firm_id;
  new.counselor_id := c.counselor_id;
  new.actor_id := (select auth.uid());
  if new.kind in ('note', 'call', 'meeting', 'email', 'sms') and btrim(new.body) = '' then
    raise exception 'Write something first' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_activities_guard() from public, anon, authenticated;

-- A call, meeting, email or text counts as contact; a private note does not.
create or replace function private.pipeline_activities_touch_contact()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.kind in ('call', 'meeting', 'email', 'sms') then
    update public.pipeline_contacts
       set last_contacted_at = greatest(coalesce(last_contacted_at, new.created_at), new.created_at)
     where id = new.contact_id;
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_activities_touch_contact() from public, anon, authenticated;
