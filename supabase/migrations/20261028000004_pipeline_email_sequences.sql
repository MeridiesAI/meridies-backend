-- Contact Pipeline: email sequences (pre-scheduled drips).
--
-- A counselor writes a sequence once: an ordered list of emails, each a number
-- of days after the one before, sent at an hour of the day in their own time
-- zone. They enroll contacts in it, optionally from a start date in the future
-- (peak season is scheduled in advance), and a cron (`pipeline-sequences`)
-- sends each email when it falls due.
--
--   * `pipeline_sequences`            the sequence: a name and the hour it sends.
--   * `pipeline_sequence_steps`       its emails. Subject and body are copied in
--     when written (a later edit to a saved template does not change a sequence
--     already running).
--   * `pipeline_sequence_enrollments` one contact's place in one sequence: the
--     next step, when it is due, and whether it is active, paused, completed
--     or stopped (and why). The cron is the only writer of progress.
--   * `pipeline_contacts.email_opted_out_at` and `pipeline_unsubscribe_tokens`
--     the family's one-click unsubscribe. Service role only; a family that
--     unsubscribes is sent nothing more, by any sequence.
--
-- A contact that becomes won (converted) or lost, or opts out, has its running
-- enrollments stopped by trigger, so no route can forget to.
--
-- Workspace rules are the contact's own (`private.crm_can_access`), as for
-- history and follow-ups (20261028000003, which this depends on).
--
-- Deploy order: after 20261028000003, before the serving build that sends
-- sequences. Additive only. The new code must degrade (503
-- `pipeline_sequences_unavailable`) until this is applied; it is not in
-- REQUIRED_SCHEMA. The cron service (`pipeline-sequences`) is added after.

-- ---------------------------------------------------------------------------
-- Opt-out
-- ---------------------------------------------------------------------------

alter table public.pipeline_contacts
  add column if not exists email_opted_out_at timestamptz;

-- Never client-writable: the contacts UPDATE grant (20261028000003) lists its
-- columns and this one is not among them.

create table if not exists public.pipeline_unsubscribe_tokens (
  token_hash  text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  contact_id  uuid not null references public.pipeline_contacts(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists pipeline_unsubscribe_tokens_contact on public.pipeline_unsubscribe_tokens (contact_id);

alter table public.pipeline_unsubscribe_tokens enable row level security;
revoke all on public.pipeline_unsubscribe_tokens from public, anon, authenticated;
select private.attach_approval_gate('public.pipeline_unsubscribe_tokens');

-- ---------------------------------------------------------------------------
-- Sequences and steps
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_sequences (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 120),
  -- Local hour (0-23) in the sender's time zone that each email goes out.
  send_hour     smallint not null default 9 check (send_hour between 0 and 23),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists pipeline_sequences_workspace on public.pipeline_sequences (firm_id, counselor_id);

drop trigger if exists pipeline_sequences_set_updated_at on public.pipeline_sequences;
create trigger pipeline_sequences_set_updated_at before update on public.pipeline_sequences
  for each row execute function public.set_updated_at();

create table if not exists public.pipeline_sequence_steps (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references public.pipeline_sequences(id) on delete cascade,
  -- The sequence's workspace, copied from it by the guard so RLS needs no join.
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  position      integer not null check (position between 1 and 20),
  -- Days after the previous email (after the start date, for the first).
  offset_days   integer not null default 0 check (offset_days between 0 and 365),
  to_who        text not null default 'both' check (to_who in ('student', 'parent', 'both')),
  subject       text not null check (length(btrim(subject)) between 1 and 300),
  body          text not null check (length(btrim(body)) between 1 and 20000),
  unique (sequence_id, position),
  -- Two emails on the same day would go out in one run.
  check (position = 1 or offset_days >= 1)
);

-- Pin a step to its sequence's workspace; a sequence that isn't there fails
-- the way a foreign one does.
create or replace function private.pipeline_sequence_steps_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  s public.pipeline_sequences;
begin
  select * into s from public.pipeline_sequences where id = new.sequence_id;
  if not found then
    raise exception 'new row violates row-level security policy for table "pipeline_sequence_steps"'
      using errcode = '42501';
  end if;
  new.firm_id := s.firm_id;
  new.counselor_id := s.counselor_id;
  return new;
end;
$$;

revoke all on function private.pipeline_sequence_steps_guard() from public, anon, authenticated;

drop trigger if exists pipeline_sequence_steps_guard on public.pipeline_sequence_steps;
create trigger pipeline_sequence_steps_guard before insert or update on public.pipeline_sequence_steps
  for each row execute function private.pipeline_sequence_steps_guard();

-- ---------------------------------------------------------------------------
-- Enrollments
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_sequence_enrollments (
  id             uuid primary key default gen_random_uuid(),
  contact_id     uuid not null references public.pipeline_contacts(id) on delete cascade,
  sequence_id    uuid not null references public.pipeline_sequences(id) on delete cascade,
  firm_id        uuid references public.firms(id) on delete cascade,
  counselor_id   uuid not null references public.profiles(id) on delete cascade,
  enrolled_by    uuid references public.profiles(id) on delete set null,
  status         text not null default 'active' check (status in ('active', 'paused', 'completed', 'stopped')),
  -- Why it ended: won, lost, unsubscribed, removed, no-address, send-failed.
  stop_reason    text not null default '' check (length(stop_reason) <= 80),
  -- The step due next, and when.
  next_position  integer not null default 1 check (next_position >= 1),
  next_send_at   timestamptz not null,
  last_sent_at   timestamptz,
  -- Set while the cron is sending, so two runs cannot send the same step.
  claimed_at     timestamptz,
  failures       smallint not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists pipeline_sequence_enrollments_due
  on public.pipeline_sequence_enrollments (next_send_at) where status = 'active';
create index if not exists pipeline_sequence_enrollments_contact on public.pipeline_sequence_enrollments (contact_id);
-- A contact is in a sequence once at a time.
create unique index if not exists pipeline_sequence_enrollments_one_live
  on public.pipeline_sequence_enrollments (contact_id, sequence_id) where status in ('active', 'paused');

drop trigger if exists pipeline_sequence_enrollments_set_updated_at on public.pipeline_sequence_enrollments;
create trigger pipeline_sequence_enrollments_set_updated_at before update on public.pipeline_sequence_enrollments
  for each row execute function public.set_updated_at();

create or replace function private.pipeline_sequence_enrollments_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  c public.pipeline_contacts;
  s public.pipeline_sequences;
begin
  if tg_op = 'INSERT' then
    select * into c from public.pipeline_contacts where id = new.contact_id;
    select * into s from public.pipeline_sequences where id = new.sequence_id;
    if c.id is null or s.id is null
       or c.firm_id is distinct from s.firm_id
       or (c.firm_id is null and c.counselor_id <> s.counselor_id) then
      raise exception 'new row violates row-level security policy for table "pipeline_sequence_enrollments"'
        using errcode = '42501';
    end if;
    if c.status <> 'open' then
      raise exception 'Only an open contact can be enrolled' using errcode = '23514';
    end if;
    if c.email_opted_out_at is not null then
      raise exception 'This family unsubscribed from emails' using errcode = '23514';
    end if;
    if not exists (select 1 from public.pipeline_sequence_steps where sequence_id = new.sequence_id) then
      raise exception 'Add at least one email to the sequence first' using errcode = '23514';
    end if;
    new.firm_id := c.firm_id;
    new.counselor_id := c.counselor_id;
    new.enrolled_by := (select auth.uid());
    new.status := 'active';
    new.stop_reason := '';
    new.next_position := 1;
    new.failures := 0;
    new.claimed_at := null;
    new.last_sent_at := null;
  elsif old.status in ('completed', 'stopped') and new.status is distinct from old.status then
    raise exception 'That enrollment has ended' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_sequence_enrollments_guard() from public, anon, authenticated;

drop trigger if exists pipeline_sequence_enrollments_guard on public.pipeline_sequence_enrollments;
create trigger pipeline_sequence_enrollments_guard before insert or update on public.pipeline_sequence_enrollments
  for each row execute function private.pipeline_sequence_enrollments_guard();

-- A contact that is won or lost, converted, or opted out is sent nothing more.
create or replace function private.pipeline_contacts_stop_sequences()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_reason text;
begin
  v_reason := case
    when new.email_opted_out_at is not null and old.email_opted_out_at is null then 'unsubscribed'
    when new.status = 'won' and old.status is distinct from 'won' then 'won'
    when new.status = 'lost' and old.status is distinct from 'lost' then 'lost'
    when new.student_id is not null and old.student_id is null then 'won'
    else null
  end;
  if v_reason is not null then
    update public.pipeline_sequence_enrollments
       set status = 'stopped', stop_reason = v_reason, claimed_at = null
     where contact_id = new.id and status in ('active', 'paused');
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_contacts_stop_sequences() from public, anon, authenticated;

drop trigger if exists pipeline_contacts_stop_sequences on public.pipeline_contacts;
create trigger pipeline_contacts_stop_sequences after update on public.pipeline_contacts
  for each row execute function private.pipeline_contacts_stop_sequences();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.pipeline_sequences            enable row level security;
alter table public.pipeline_sequence_steps       enable row level security;
alter table public.pipeline_sequence_enrollments enable row level security;

drop policy if exists pipeline_sequences_select on public.pipeline_sequences;
create policy pipeline_sequences_select on public.pipeline_sequences
  for select to authenticated using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequences_insert on public.pipeline_sequences;
create policy pipeline_sequences_insert on public.pipeline_sequences
  for insert to authenticated with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequences_update on public.pipeline_sequences;
create policy pipeline_sequences_update on public.pipeline_sequences
  for update to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequences_delete on public.pipeline_sequences;
create policy pipeline_sequences_delete on public.pipeline_sequences
  for delete to authenticated using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_sequence_steps_select on public.pipeline_sequence_steps;
create policy pipeline_sequence_steps_select on public.pipeline_sequence_steps
  for select to authenticated using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequence_steps_insert on public.pipeline_sequence_steps;
create policy pipeline_sequence_steps_insert on public.pipeline_sequence_steps
  for insert to authenticated with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequence_steps_update on public.pipeline_sequence_steps;
create policy pipeline_sequence_steps_update on public.pipeline_sequence_steps
  for update to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequence_steps_delete on public.pipeline_sequence_steps;
create policy pipeline_sequence_steps_delete on public.pipeline_sequence_steps
  for delete to authenticated using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_sequence_enrollments_select on public.pipeline_sequence_enrollments;
create policy pipeline_sequence_enrollments_select on public.pipeline_sequence_enrollments
  for select to authenticated using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequence_enrollments_insert on public.pipeline_sequence_enrollments;
create policy pipeline_sequence_enrollments_insert on public.pipeline_sequence_enrollments
  for insert to authenticated with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));
drop policy if exists pipeline_sequence_enrollments_update on public.pipeline_sequence_enrollments;
create policy pipeline_sequence_enrollments_update on public.pipeline_sequence_enrollments
  for update to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

revoke all on public.pipeline_sequences, public.pipeline_sequence_steps, public.pipeline_sequence_enrollments
  from public, anon, authenticated;
grant select, delete on public.pipeline_sequences, public.pipeline_sequence_steps to authenticated;
grant insert (name, send_hour, firm_id, counselor_id) on public.pipeline_sequences to authenticated;
grant update (name, send_hour) on public.pipeline_sequences to authenticated;
grant insert (sequence_id, position, offset_days, to_who, subject, body) on public.pipeline_sequence_steps to authenticated;
grant update (position, offset_days, to_who, subject, body) on public.pipeline_sequence_steps to authenticated;
-- A counselor enrolls, pauses, resumes and stops. Progress is the cron's.
grant select on public.pipeline_sequence_enrollments to authenticated;
grant insert (contact_id, sequence_id, next_send_at) on public.pipeline_sequence_enrollments to authenticated;
grant update (status, stop_reason, next_send_at) on public.pipeline_sequence_enrollments to authenticated;

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.pipeline_sequences');
select private.attach_approval_gate('public.pipeline_sequence_steps');
select private.attach_approval_gate('public.pipeline_sequence_enrollments');

-- ---------------------------------------------------------------------------
-- The cron's heartbeat
-- ---------------------------------------------------------------------------

-- Read the current CHECK back and add the label, so another migration's label
-- is never dropped (as 20261027000001 does).
do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.job_heartbeats'::regclass and c.conname = 'job_heartbeats_job_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if not ('pipeline-sequences' = any(v_values)) then
    v_values := array_append(v_values, 'pipeline-sequences'::text);
    alter table public.job_heartbeats drop constraint if exists job_heartbeats_job_check;
    execute format('alter table public.job_heartbeats add constraint job_heartbeats_job_check check (job = any (%L::text[]))', v_values);
  end if;
end;
$$;

insert into public.job_heartbeats (job, expected_every)
values ('pipeline-sequences', interval '15 minutes')
on conflict (job) do nothing;
