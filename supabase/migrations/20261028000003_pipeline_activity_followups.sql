-- Contact Pipeline: activity history, follow-ups, lost/won, and conversion.
--
-- Until now a contact card kept only where it is (`stage_id`, with the clock
-- reset on every move) and one free-text `next_step`. Nothing recorded what
-- happened to it, who was supposed to follow up and by when, or why a lead
-- went cold. This adds:
--
--   * `pipeline_activities`  the contact's timeline. Notes, calls, meetings and
--     emails are written by the counselor; everything the system can see for
--     itself (created, stage moves, status changes, invitations, follow-ups,
--     invoices, payments, conversion) is written by a trigger, so no route can
--     forget to and nobody can tidy the past: the table has no UPDATE or DELETE.
--   * `pipeline_followups`   dated to-dos on a contact, assigned to a consultant
--     in the workspace. A separate table from `consultant_tasks` on purpose:
--     those rows are visible to the assignee, the assigner and firm admins only,
--     and a follow-up is the practice's, readable like the contact it hangs off.
--   * `pipeline_contacts.source / status / lost_reason / last_contacted_at`.
--     A lost lead leaves the board but keeps its history.
--   * Conversion: when the contact's invitation is accepted the contact is won
--     and moves to the first stage of the Current group (it used to only learn
--     `student_id`).
--
-- Workspace rules are the contact's own (`private.crm_can_access`). Billing
-- entries (`invoice`, `payment`) are shown only to whoever may bill the contact
-- (`private.crm_can_bill`), so the timeline never tells a consultant what the
-- Payment Tracker would not.
--
-- Deploy order: either. Additive only. The serving build selects named columns
-- and ignores the new ones. The new code reads these tables and columns, so it
-- must degrade (an `available: false` board section) until this is applied; it
-- is not in REQUIRED_SCHEMA.

-- ---------------------------------------------------------------------------
-- Contact columns
-- ---------------------------------------------------------------------------

alter table public.pipeline_contacts
  add column if not exists source text not null default '' check (length(source) <= 80),
  add column if not exists status text not null default 'open' check (status in ('open', 'won', 'lost')),
  add column if not exists lost_reason text not null default '' check (length(lost_reason) <= 300),
  -- Last call, meeting or email logged. Written by trigger only.
  add column if not exists last_contacted_at timestamptz;

create index if not exists pipeline_contacts_status_idx on public.pipeline_contacts (stage_id) where status = 'open';

grant update (source, status, lost_reason) on public.pipeline_contacts to authenticated;

-- A lost reason belongs to a lost contact only.
create or replace function private.pipeline_contacts_status_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.status <> 'lost' then
    new.lost_reason := '';
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_contacts_status_guard() from public, anon, authenticated;

drop trigger if exists pipeline_contacts_status_guard on public.pipeline_contacts;
create trigger pipeline_contacts_status_guard before insert or update on public.pipeline_contacts
  for each row execute function private.pipeline_contacts_status_guard();

-- ---------------------------------------------------------------------------
-- Activities
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_activities (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.pipeline_contacts(id) on delete cascade,
  -- The contact's workspace, copied from it by the guard so RLS needs no join.
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  kind          text not null check (kind in (
                  'note', 'call', 'meeting', 'email',
                  'created', 'stage_change', 'status', 'invite', 'converted',
                  'task', 'invoice', 'payment')),
  body          text not null default '' check (length(body) <= 4000),
  -- Structured detail for system entries (stage names, an invoice number...).
  -- Never free text from a family.
  meta          jsonb not null default '{}'::jsonb
                check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 4096),
  actor_id      uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists pipeline_activities_contact_idx
  on public.pipeline_activities (contact_id, created_at desc);

-- Pin the row to the contact's workspace and to the caller; refuse a note with
-- no words. A contact that isn't there fails the same way a foreign one does.
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
  if new.kind in ('note', 'call', 'meeting', 'email') and btrim(new.body) = '' then
    raise exception 'Write something first' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_activities_guard() from public, anon, authenticated;

drop trigger if exists pipeline_activities_guard on public.pipeline_activities;
create trigger pipeline_activities_guard before insert on public.pipeline_activities
  for each row execute function private.pipeline_activities_guard();

-- A call, meeting or email counts as contact; a private note does not.
create or replace function private.pipeline_activities_touch_contact()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if new.kind in ('call', 'meeting', 'email') then
    update public.pipeline_contacts
       set last_contacted_at = greatest(coalesce(last_contacted_at, new.created_at), new.created_at)
     where id = new.contact_id;
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_activities_touch_contact() from public, anon, authenticated;

drop trigger if exists pipeline_activities_touch_contact on public.pipeline_activities;
create trigger pipeline_activities_touch_contact after insert on public.pipeline_activities
  for each row execute function private.pipeline_activities_touch_contact();

alter table public.pipeline_activities enable row level security;

drop policy if exists pipeline_activities_select on public.pipeline_activities;
create policy pipeline_activities_select on public.pipeline_activities
  for select to authenticated
  using (
    private.crm_can_access(firm_id, counselor_id, (select auth.uid()))
    and (kind not in ('invoice', 'payment') or private.crm_can_bill(contact_id, (select auth.uid())))
  );

-- A client writes only the entries a person makes; the system kinds come from
-- the triggers below.
drop policy if exists pipeline_activities_insert on public.pipeline_activities;
create policy pipeline_activities_insert on public.pipeline_activities
  for insert to authenticated
  with check (
    kind in ('note', 'call', 'meeting', 'email')
    and private.crm_can_access(firm_id, counselor_id, (select auth.uid()))
  );

revoke all on public.pipeline_activities from public, anon, authenticated;
grant select on public.pipeline_activities to authenticated;
grant insert (contact_id, kind, body) on public.pipeline_activities to authenticated;

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.pipeline_activities');

-- ---------------------------------------------------------------------------
-- Follow-ups
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_followups (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.pipeline_contacts(id) on delete cascade,
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  -- A consultant in the workspace (checked by trigger). Defaults to the
  -- contact's owner, else whoever added it.
  assignee_id   uuid references public.profiles(id) on delete set null,
  title         text not null check (length(btrim(title)) between 1 and 300),
  due_on        date,
  done          boolean not null default false,
  done_at       timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists pipeline_followups_contact_idx on public.pipeline_followups (contact_id, done, due_on);
create index if not exists pipeline_followups_assignee_idx on public.pipeline_followups (assignee_id, due_on)
  where not done;

drop trigger if exists pipeline_followups_set_updated_at on public.pipeline_followups;
create trigger pipeline_followups_set_updated_at before update on public.pipeline_followups
  for each row execute function public.set_updated_at();

create or replace function private.pipeline_followups_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  c public.pipeline_contacts;
  caller uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    select * into c from public.pipeline_contacts where id = new.contact_id;
    if not found then
      raise exception 'new row violates row-level security policy for table "pipeline_followups"'
        using errcode = '42501';
    end if;
    new.firm_id := c.firm_id;
    new.counselor_id := c.counselor_id;
    new.created_by := caller;
    if new.assignee_id is null then
      new.assignee_id := coalesce(c.owner_id, caller);
    end if;
    new.done := false;
  end if;

  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    if not (
      (new.firm_id is null and new.assignee_id = new.counselor_id)
      or (new.firm_id is not null and private.crm_firm_member(new.firm_id, new.assignee_id))
    ) then
      raise exception 'The assignee must be a consultant in this practice' using errcode = '23514';
    end if;
  end if;

  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at := now();
  elsif not new.done then
    new.done_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_followups_guard() from public, anon, authenticated;

drop trigger if exists pipeline_followups_guard on public.pipeline_followups;
create trigger pipeline_followups_guard before insert or update on public.pipeline_followups
  for each row execute function private.pipeline_followups_guard();

alter table public.pipeline_followups enable row level security;

drop policy if exists pipeline_followups_select on public.pipeline_followups;
create policy pipeline_followups_select on public.pipeline_followups
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_followups_insert on public.pipeline_followups;
create policy pipeline_followups_insert on public.pipeline_followups
  for insert to authenticated
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_followups_update on public.pipeline_followups;
create policy pipeline_followups_update on public.pipeline_followups
  for update to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_followups_delete on public.pipeline_followups;
create policy pipeline_followups_delete on public.pipeline_followups
  for delete to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

revoke all on public.pipeline_followups from public, anon, authenticated;
grant select, delete on public.pipeline_followups to authenticated;
grant insert (contact_id, assignee_id, title, due_on) on public.pipeline_followups to authenticated;
grant update (assignee_id, title, due_on, done) on public.pipeline_followups to authenticated;

select private.attach_approval_gate('public.pipeline_followups');

-- ---------------------------------------------------------------------------
-- The system writes the timeline
-- ---------------------------------------------------------------------------

create or replace function private.pipeline_log(
  p_contact uuid, p_kind text, p_body text, p_meta jsonb
) returns void
language sql
security definer
set search_path to 'private', 'public'
as $$
  insert into public.pipeline_activities (contact_id, firm_id, counselor_id, kind, body, meta, actor_id)
  select c.id, c.firm_id, c.counselor_id, p_kind, coalesce(p_body, ''), coalesce(p_meta, '{}'::jsonb), (select auth.uid())
  from public.pipeline_contacts c
  where c.id = p_contact;
$$;

revoke all on function private.pipeline_log(uuid, text, text, jsonb) from public, anon, authenticated;

-- Contact: created, moved, won/lost, invited, converted.
create or replace function private.pipeline_contacts_log()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_from text;
  v_to   text;
begin
  if tg_op = 'INSERT' then
    perform private.pipeline_log(new.id, 'created', '', jsonb_build_object('source', new.source));
    return new;
  end if;

  if new.stage_id is distinct from old.stage_id then
    select name into v_from from public.pipeline_stages where id = old.stage_id;
    select name into v_to from public.pipeline_stages where id = new.stage_id;
    perform private.pipeline_log(new.id, 'stage_change', '',
      jsonb_build_object('from', v_from, 'to', v_to));
  end if;

  if new.status is distinct from old.status then
    perform private.pipeline_log(new.id, 'status', new.lost_reason,
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;

  if new.invitation_id is not null and new.invitation_id is distinct from old.invitation_id then
    perform private.pipeline_log(new.id, 'invite', '', jsonb_build_object('email', new.student_email));
  end if;

  if new.student_id is not null and old.student_id is null then
    perform private.pipeline_log(new.id, 'converted', '', '{}'::jsonb);
  end if;

  return new;
end;
$$;

revoke all on function private.pipeline_contacts_log() from public, anon, authenticated;

drop trigger if exists pipeline_contacts_log on public.pipeline_contacts;
create trigger pipeline_contacts_log after insert or update on public.pipeline_contacts
  for each row execute function private.pipeline_contacts_log();

-- Follow-ups: added, completed.
create or replace function private.pipeline_followups_log()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if tg_op = 'INSERT' then
    perform private.pipeline_log(new.contact_id, 'task', new.title,
      jsonb_build_object('event', 'added', 'dueOn', new.due_on));
  elsif new.done and not old.done then
    perform private.pipeline_log(new.contact_id, 'task', new.title,
      jsonb_build_object('event', 'done'));
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_followups_log() from public, anon, authenticated;

drop trigger if exists pipeline_followups_log on public.pipeline_followups;
create trigger pipeline_followups_log after insert or update on public.pipeline_followups
  for each row execute function private.pipeline_followups_log();

-- Invoices and payments (shown only to whoever may bill, by the select policy).
create or replace function private.pipeline_invoices_log()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if tg_op = 'INSERT' then
    perform private.pipeline_log(new.contact_id, 'invoice', new.label,
      jsonb_build_object('event', 'issued', 'number', new.number, 'amountCents', new.amount_cents));
  elsif new.voided_at is not null and old.voided_at is null then
    perform private.pipeline_log(new.contact_id, 'invoice', new.label,
      jsonb_build_object('event', 'voided', 'number', new.number, 'amountCents', new.amount_cents));
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_invoices_log() from public, anon, authenticated;

drop trigger if exists pipeline_invoices_log on public.pipeline_invoices;
create trigger pipeline_invoices_log after insert or update of voided_at on public.pipeline_invoices
  for each row execute function private.pipeline_invoices_log();

create or replace function private.pipeline_payments_log()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  perform private.pipeline_log(new.contact_id, 'payment', '',
    jsonb_build_object('amountCents', new.amount_cents, 'method', new.method, 'receivedOn', new.received_on));
  return new;
end;
$$;

revoke all on function private.pipeline_payments_log() from public, anon, authenticated;

drop trigger if exists pipeline_payments_log on public.pipeline_payments;
create trigger pipeline_payments_log after insert on public.pipeline_payments
  for each row execute function private.pipeline_payments_log();

-- ---------------------------------------------------------------------------
-- Conversion
-- ---------------------------------------------------------------------------

-- Replaces 20261005050001's version, which only set `student_id`. Accepting the
-- invitation now also wins the contact and moves it to the first stage of the
-- Current group in its own workspace, to the bottom of that column, when it is
-- not in that group already. accept_invitation() is SECURITY DEFINER, so this
-- runs with the same rights; a workspace with no Current stage keeps the
-- contact where it is.
create or replace function private.pipeline_contacts_on_invitation_accepted()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  c        public.pipeline_contacts;
  v_target uuid;
  v_pos    integer;
begin
  if new.status = 'accepted' and new.accepted_by is not null
     and (old.status is distinct from 'accepted' or old.accepted_by is distinct from new.accepted_by) then
    for c in select * from public.pipeline_contacts where invitation_id = new.id loop
      v_target := null;
      select t.id into v_target
      from public.pipeline_stages cur
      join public.pipeline_stages t
        on t.lifecycle_group = 'current'
       and t.firm_id is not distinct from cur.firm_id
       and (cur.firm_id is not null or t.counselor_id = cur.counselor_id)
      where cur.id = c.stage_id and cur.lifecycle_group <> 'current'
      order by t.position, t.created_at
      limit 1;

      if v_target is not null then
        select coalesce(max(position) + 1, 0) into v_pos from public.pipeline_contacts where stage_id = v_target;
      end if;

      update public.pipeline_contacts
         set student_id = new.accepted_by,
             status = 'won',
             stage_id = coalesce(v_target, stage_id),
             position = case when v_target is not null then v_pos else position end
       where id = c.id;
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_contacts_on_invitation_accepted() from public, anon, authenticated;
