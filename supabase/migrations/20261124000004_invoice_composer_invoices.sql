-- Invoice composer, part 2 of 3: what an invoice can carry, scheduled drafts, reminders.
--
--   * `pipeline_invoices` gains nullable composer columns: `line_items`, `accepted_methods`,
--     `pass_card_fee`, `note`, `cc`, `reminders` (day offsets from the due date), `reminders_sent`
--     (offset -> time it went), `style_snapshot` (the look at send time, so a sent invoice is never
--     re-skinned), `agreement_id` (the contract/agreement sent with it, for the pay page; the one column a
--     client UPDATE may set, after the insert). Every one is
--     null (or false) on an invoice made before this file, and the API reads null as "the invoice as it
--     always was". The amount stays `amount_cents`; the server enforces sum(line_items) = amount_cents.
--   * `pipeline_payments.method` accepts `paypal`.
--   * `pipeline_invoice_drafts`  a saved or scheduled invoice, its own table: a real invoice row is made
--     only when it is sent (the existing create path), so `deriveAccount` and the credit guards are
--     untouched. States: draft, scheduled, sent, cancelled, failed (a scheduled send that gave up).
--   * `claim_invoice_reminder` / `release_invoice_reminder`  atomic, service-role-only bookkeeping so
--     a reminder goes once even when two cron runs overlap.
--
-- Deploy order: either. The columns are nullable/defaulted and are not in a client UPDATE grant, except agreement_id (an
-- invoice is written at insert, by the API), so the serving build is unaffected. Without this file the
-- composer's new fields on invoice create answer 503 `invoice_composer_unavailable` and old payloads are
-- the invoice they always were. Additive only. Not in REQUIRED_SCHEMA. Re-runnable.

alter table public.pipeline_invoices add column if not exists line_items jsonb
  check (line_items is null or (jsonb_typeof(line_items) = 'array' and pg_column_size(line_items) <= 16384));
alter table public.pipeline_invoices add column if not exists accepted_methods text[]
  check (accepted_methods is null or cardinality(accepted_methods) <= 20);
alter table public.pipeline_invoices add column if not exists pass_card_fee boolean not null default false;
alter table public.pipeline_invoices add column if not exists note text
  check (note is null or length(note) <= 1000);
alter table public.pipeline_invoices add column if not exists cc text[]
  check (cc is null or cardinality(cc) <= 5);
alter table public.pipeline_invoices add column if not exists reminders integer[]
  check (reminders is null or cardinality(reminders) <= 5);
alter table public.pipeline_invoices add column if not exists reminders_sent jsonb
  check (reminders_sent is null or (jsonb_typeof(reminders_sent) = 'object' and pg_column_size(reminders_sent) <= 2048));
alter table public.pipeline_invoices add column if not exists style_snapshot jsonb
  check (style_snapshot is null or (jsonb_typeof(style_snapshot) = 'object' and pg_column_size(style_snapshot) <= 4096));
alter table public.pipeline_invoices add column if not exists agreement_id uuid
  references public.agreements(id) on delete set null;

-- The API links the agreement it minted to the invoice right after the insert (a client can't set any other composer
-- column after the fact). The pay page checks the agreement is the invoice's own contact's before it mints a link.
grant update (agreement_id) on public.pipeline_invoices to authenticated;

-- paypal joins the methods a payment can be recorded with (the constraint was inline: pipeline_payments_method_check).
alter table public.pipeline_payments drop constraint if exists pipeline_payments_method_check;
alter table public.pipeline_payments add constraint pipeline_payments_method_check
  check (method in ('card', 'ach', 'check', 'zelle', 'paypal', 'other'));

-- ---------------------------------------------------------------------------
-- Drafts and scheduled sends
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_invoice_drafts (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid references public.firms(id) on delete cascade,
  -- The contact's own counselor (the workspace's solo owner); created_by is who composed it.
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  contact_id       uuid not null references public.pipeline_contacts(id) on delete cascade,
  -- Label, lines, due date, recipients, methods, fee flag, note, channel, schedule, contract, reminders.
  -- Validated key by key in the API (lib/invoiceDrafts.ts), size-bounded here.
  payload          jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 32768),
  state            text not null default 'draft' check (state in ('draft', 'scheduled', 'sent', 'cancelled', 'failed')),
  send_at          timestamptz,
  repeat_yearly    boolean not null default false,
  sent_invoice_id  uuid references public.pipeline_invoices(id) on delete set null,
  sent_at          timestamptz,
  -- Dispatch bookkeeping (the cron's alone): the claim, tries, why it gave up.
  claimed_at       timestamptz,
  attempts         integer not null default 0 check (attempts between 0 and 10),
  last_error       text check (last_error is null or length(last_error) <= 300),
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pipeline_invoice_drafts_scheduled_has_time check (state <> 'scheduled' or send_at is not null)
);

create index if not exists pipeline_invoice_drafts_contact_idx on public.pipeline_invoice_drafts (contact_id, created_at desc);
create index if not exists pipeline_invoice_drafts_due_idx on public.pipeline_invoice_drafts (send_at) where state = 'scheduled';

drop trigger if exists pipeline_invoice_drafts_set_updated_at on public.pipeline_invoice_drafts;
create trigger pipeline_invoice_drafts_set_updated_at before update on public.pipeline_invoice_drafts
  for each row execute function public.set_updated_at();

-- Workspace and ownership are the contact's, never the client's.
create or replace function private.pipeline_invoice_drafts_scope()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
begin
  if tg_op = 'INSERT' then
    select c.firm_id, c.counselor_id into new.firm_id, new.counselor_id
      from public.pipeline_contacts c where c.id = new.contact_id;
    if not found then
      raise exception 'That family is not in a pipeline' using errcode = 'P0002';
    end if;
    new.state := case when new.state = 'scheduled' then 'scheduled' else 'draft' end;
    new.sent_invoice_id := null;
    new.sent_at := null;
    new.claimed_at := null;
    new.attempts := 0;
    new.last_error := null;
  elsif coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon') then
    -- A client moves a draft between draft, scheduled and cancelled (and edits it); only the cron sends.
    new.id := old.id;
    new.contact_id := old.contact_id;
    new.firm_id := old.firm_id;
    new.counselor_id := old.counselor_id;
    new.created_by := old.created_by;
    new.sent_invoice_id := old.sent_invoice_id;
    new.sent_at := old.sent_at;
    new.claimed_at := old.claimed_at;
    new.attempts := old.attempts;
    new.last_error := old.last_error;
    if old.state in ('sent', 'cancelled') then
      raise exception 'This draft can no longer be changed' using errcode = 'P0001';
    end if;
    if new.state not in ('draft', 'scheduled', 'cancelled') then
      raise exception 'That change of state isn''t allowed' using errcode = 'P0001';
    end if;
    if old.state = 'failed' and new.state = 'scheduled' then
      new.attempts := 0;
      new.last_error := null;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_invoice_drafts_scope() from public, anon, authenticated;

drop trigger if exists pipeline_invoice_drafts_scope on public.pipeline_invoice_drafts;
create trigger pipeline_invoice_drafts_scope before insert or update on public.pipeline_invoice_drafts
  for each row execute function private.pipeline_invoice_drafts_scope();

alter table public.pipeline_invoice_drafts enable row level security;

drop policy if exists pipeline_invoice_drafts_select on public.pipeline_invoice_drafts;
create policy pipeline_invoice_drafts_select on public.pipeline_invoice_drafts
  for select to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())));

drop policy if exists pipeline_invoice_drafts_insert on public.pipeline_invoice_drafts;
create policy pipeline_invoice_drafts_insert on public.pipeline_invoice_drafts
  for insert to authenticated
  with check (private.crm_can_bill(contact_id, (select auth.uid())) and created_by = (select auth.uid()));

drop policy if exists pipeline_invoice_drafts_update on public.pipeline_invoice_drafts;
create policy pipeline_invoice_drafts_update on public.pipeline_invoice_drafts
  for update to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())))
  with check (private.crm_can_bill(contact_id, (select auth.uid())));

-- No delete: a draft is cancelled (the history of what was scheduled stays).
revoke all on public.pipeline_invoice_drafts from public, anon, authenticated;
grant select on public.pipeline_invoice_drafts to authenticated;
grant insert (contact_id, payload, state, send_at, repeat_yearly, created_by) on public.pipeline_invoice_drafts to authenticated;
grant update (payload, state, send_at, repeat_yearly) on public.pipeline_invoice_drafts to authenticated;

select private.attach_approval_gate('public.pipeline_invoice_drafts');

-- ---------------------------------------------------------------------------
-- Reminders: claim once
-- ---------------------------------------------------------------------------

-- True for the one caller that records offset p_offset as sent; false when it already is.
create or replace function public.claim_invoice_reminder(p_invoice uuid, p_offset integer, p_at timestamptz default now())
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_n integer;
begin
  update public.pipeline_invoices
     set reminders_sent = coalesce(reminders_sent, '{}'::jsonb) || jsonb_build_object(p_offset::text, to_jsonb(p_at))
   where id = p_invoice
     and voided_at is null
     and not (coalesce(reminders_sent, '{}'::jsonb) ? p_offset::text);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- Take the mark back when the send itself failed, so the next run tries again.
create or replace function public.release_invoice_reminder(p_invoice uuid, p_offset integer)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.pipeline_invoices
     set reminders_sent = coalesce(reminders_sent, '{}'::jsonb) - p_offset::text
   where id = p_invoice;
$$;

revoke all on function public.claim_invoice_reminder(uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.release_invoice_reminder(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_invoice_reminder(uuid, integer, timestamptz) to service_role;
grant execute on function public.release_invoice_reminder(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- AxIS trash (20261108000003): a deleted contact's drafts are kept, like its card issues
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('private.axis_trash_rules') is not null
     and to_regprocedure('private.attach_axis_trash(regclass, text[], boolean)') is not null then
    insert into private.axis_trash_rules (table_name, rule, columns, student_col) values
      ('pipeline_invoice_drafts', 'parent', '{contact_id}', null)
    on conflict (table_name) do update set rule = excluded.rule, columns = excluded.columns, student_col = excluded.student_col;
    perform private.attach_axis_trash('public.pipeline_invoice_drafts');
  end if;
end;
$$;
