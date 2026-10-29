-- Payment Tracker: overpayments held as credit, credit applied to invoices, and
-- credit marked refunded (bug hunt 2026-10-28, S2-M1).
--
-- A payment above what is left on the package used to be recorded silently and
-- the next invoice asked the family for money they had already paid. Now:
--
--   * `pipeline_payments.credit_cents`  the part of a payment above what the
--     package had left, recorded only when the counselor says so. It doesn't
--     count as paid toward the package; it's held.
--   * `pipeline_invoices.credit_applied_cents`  held credit taken off an
--     invoice ("Credit applied"), so it asks for amount minus this. A voided
--     invoice gives its credit back (lib/payments.ts counts live invoices only).
--   * `pipeline_credit_refunds`  "Mark refunded": the counselor records that the
--     held credit went back to the family. Nothing refunds on its own.
--
-- Balances stay derived (lib/payments.ts); these are recorded amounts in cents.
-- The two guard triggers stop a client (PostgREST included) applying or
-- refunding more credit than the family holds, under a lock on the package so
-- two at once can't spend the same credit.
--
-- Deploy order: either. Additive only; the serving build selects `*` and
-- ignores the new columns. The new code probes for this migration
-- (paymentCreditsReady in routes/pipeline.ts) and, until it is applied, refuses
-- to record an overpayment and to mark a credit refunded (409
-- payment_credits_unavailable), and invoices without applying credit.
-- Not in REQUIRED_SCHEMA.

alter table public.pipeline_payments
  add column if not exists credit_cents bigint not null default 0;
alter table public.pipeline_payments drop constraint if exists pipeline_payments_credit_range;
alter table public.pipeline_payments add constraint pipeline_payments_credit_range
  check (credit_cents >= 0 and credit_cents <= amount_cents);

alter table public.pipeline_invoices
  add column if not exists credit_applied_cents bigint not null default 0;
alter table public.pipeline_invoices drop constraint if exists pipeline_invoices_credit_range;
alter table public.pipeline_invoices add constraint pipeline_invoices_credit_range
  check (credit_applied_cents >= 0 and credit_applied_cents <= amount_cents);

create table if not exists public.pipeline_credit_refunds (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.pipeline_packages(contact_id) on delete restrict,
  amount_cents  bigint not null check (amount_cents between 1 and 100000000),
  refunded_on   date not null,
  note          text check (length(note) <= 300),
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists pipeline_credit_refunds_contact_idx on public.pipeline_credit_refunds (contact_id, refunded_on);

alter table public.pipeline_credit_refunds enable row level security;

drop policy if exists pipeline_credit_refunds_select on public.pipeline_credit_refunds;
create policy pipeline_credit_refunds_select on public.pipeline_credit_refunds
  for select to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())));

drop policy if exists pipeline_credit_refunds_insert on public.pipeline_credit_refunds;
create policy pipeline_credit_refunds_insert on public.pipeline_credit_refunds
  for insert to authenticated
  with check (private.crm_can_bill(contact_id, (select auth.uid())) and created_by = (select auth.uid()));

-- No update or delete: a refund is a record of money that left.
revoke all on public.pipeline_credit_refunds from public, anon, authenticated;
grant select, insert on public.pipeline_credit_refunds to authenticated;

select private.attach_approval_gate('public.pipeline_credit_refunds');

-- Held credit not yet applied or refunded, the way lib/payments.ts counts it:
-- credit marked on payments, plus any overpayment from before this migration,
-- minus credit applied to live invoices and credit refunded.
create or replace function private.pipeline_credit_available(p_contact uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  with pay as (
    select coalesce(sum(amount_cents), 0) as received, coalesce(sum(credit_cents), 0) as held
    from public.pipeline_payments where contact_id = p_contact
  ), inv as (
    select coalesce(sum(credit_applied_cents), 0) as applied
    from public.pipeline_invoices where contact_id = p_contact and voided_at is null
  ), ref as (
    select coalesce(sum(amount_cents), 0) as refunded
    from public.pipeline_credit_refunds where contact_id = p_contact
  ), pkg as (
    select total_cents from public.pipeline_packages where contact_id = p_contact
  )
  select greatest(0,
           pay.held - inv.applied - ref.refunded
           + greatest(0, pay.received - pay.held + inv.applied - coalesce(pkg.total_cents, 0)))
  from pay, inv, ref left join pkg on true;
$$;

revoke all on function private.pipeline_credit_available(uuid) from public, anon, authenticated;

create or replace function private.pipeline_credit_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spend bigint;
begin
  -- Separate branches: each table has only its own column.
  if tg_table_name = 'pipeline_invoices' then
    v_spend := new.credit_applied_cents;
  else
    v_spend := new.amount_cents;
  end if;
  if v_spend <= 0 then
    return new;
  end if;
  -- One at a time per family, so two writes can't spend the same credit.
  perform 1 from public.pipeline_packages where contact_id = new.contact_id for update;
  if v_spend > private.pipeline_credit_available(new.contact_id) then
    raise exception 'That is more credit than this family holds'
      using errcode = '23514', constraint = 'pipeline_credit_available';
  end if;
  return new;
end;
$$;

revoke all on function private.pipeline_credit_guard() from public, anon, authenticated;

drop trigger if exists pipeline_invoices_credit_guard on public.pipeline_invoices;
create trigger pipeline_invoices_credit_guard before insert on public.pipeline_invoices
  for each row execute function private.pipeline_credit_guard();

-- An invoice's credit can't be changed after it is issued (the column isn't in
-- the client UPDATE grant), so only inserts are checked.
drop trigger if exists pipeline_credit_refunds_guard on public.pipeline_credit_refunds;
create trigger pipeline_credit_refunds_guard before insert on public.pipeline_credit_refunds
  for each row execute function private.pipeline_credit_guard();
