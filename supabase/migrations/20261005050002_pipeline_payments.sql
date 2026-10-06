-- Payment Tracker (demo v8, Contact Pipeline): what each family signed up for,
-- what has been invoiced and what has come in.
--
-- A family's record is a package, its invoices and its payments. Money is
-- integer cents. Balances and statuses are DERIVED, never stored: payments
-- settle the oldest invoice first, and an invoice past its due date with
-- money still owed is overdue (src/lib/payments.ts does the arithmetic, the
-- same rules as the demo). There is deliberately no status or balance column
-- here to drift.
--
-- Named pipeline_* because `public.invoices` already exists: it is the
-- practice's own Meridies subscription billing, a different thing.
--
-- Who sees the money. In a firm, the pipeline is shared but the billing is
-- not: the firm's owners and admins, and the consultant who owns the contact,
-- see and record payments. A solo counselor sees their own. A student never
-- does. `private.crm_can_bill` is that rule.
--
-- Deleting a contact with invoices or payments is refused (they restrict the
-- package, which cascades from the contact), so
-- a financial record can't vanish as a side effect of tidying the board.

create or replace function private.crm_can_bill(p_contact uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$
  select exists (
    select 1 from public.pipeline_contacts c
    where c.id = p_contact
      and private.is_counselor(p_viewer)
      and case when c.firm_id is null then c.counselor_id = p_viewer
               else private.crm_firm_admin(c.firm_id, p_viewer)
                    or (c.owner_id = p_viewer and private.crm_firm_member(c.firm_id, p_viewer)) end
  );
$$;

revoke all on function private.crm_can_bill(uuid, uuid) from public, anon;
grant execute on function private.crm_can_bill(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Package: one per family
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_packages (
  contact_id    uuid primary key references public.pipeline_contacts(id) on delete cascade,
  package_name  text not null check (length(btrim(package_name)) between 1 and 200),
  total_cents   bigint not null check (total_cents between 0 and 100000000),
  installments  integer not null default 1 check (installments between 1 and 60),
  currency      text not null default 'usd' check (currency = 'usd'),
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists pipeline_packages_set_updated_at on public.pipeline_packages;
create trigger pipeline_packages_set_updated_at before update on public.pipeline_packages
  for each row execute function public.set_updated_at();

alter table public.pipeline_packages enable row level security;

drop policy if exists pipeline_packages_rw on public.pipeline_packages;
create policy pipeline_packages_rw on public.pipeline_packages
  for all to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())))
  with check (private.crm_can_bill(contact_id, (select auth.uid())));

revoke all on public.pipeline_packages from public, anon, authenticated;
grant select, insert, delete on public.pipeline_packages to authenticated;
grant update (package_name, total_cents, installments) on public.pipeline_packages to authenticated;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_invoices (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.pipeline_packages(contact_id) on delete restrict,
  -- INV-1001, numbered per workspace by trigger.
  number        text not null,
  -- Scope the number is unique in: the firm, or the solo counselor.
  number_scope  uuid not null,
  label         text not null check (length(btrim(label)) between 1 and 120),
  amount_cents  bigint not null check (amount_cents between 1 and 100000000),
  issued_on     date not null default current_date,
  due_on        date not null,
  -- A voided invoice stays on the record and stops counting.
  voided_at     timestamptz,
  -- The email to the family, if one was sent.
  sent_to       text check (length(sent_to) <= 320),
  sent_at       timestamptz,
  message_delivery_id uuid references public.message_deliveries(id) on delete set null,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint pipeline_invoices_due_after_issue check (due_on >= issued_on),
  constraint pipeline_invoices_number_unique unique (number_scope, number)
);

create index if not exists pipeline_invoices_contact_idx on public.pipeline_invoices (contact_id, issued_on);

create or replace function private.pipeline_invoices_number()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_scope uuid;
  v_next  integer;
begin
  select coalesce(c.firm_id, c.counselor_id) into v_scope
  from public.pipeline_contacts c where c.id = new.contact_id;
  if v_scope is null then
    raise exception 'That family is not in a pipeline' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtext('pipeline-invoice-number:' || v_scope::text));
  select coalesce(max(substring(number from 5)::integer), 1000) + 1 into v_next
  from public.pipeline_invoices where number_scope = v_scope and number ~ '^INV-[0-9]+$';
  new.number_scope := v_scope;
  new.number := 'INV-' || v_next;
  return new;
end;
$$;

revoke all on function private.pipeline_invoices_number() from public, anon, authenticated;

drop trigger if exists pipeline_invoices_number on public.pipeline_invoices;
create trigger pipeline_invoices_number before insert on public.pipeline_invoices
  for each row execute function private.pipeline_invoices_number();

alter table public.pipeline_invoices enable row level security;

drop policy if exists pipeline_invoices_select on public.pipeline_invoices;
create policy pipeline_invoices_select on public.pipeline_invoices
  for select to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())));

drop policy if exists pipeline_invoices_insert on public.pipeline_invoices;
create policy pipeline_invoices_insert on public.pipeline_invoices
  for insert to authenticated
  with check (private.crm_can_bill(contact_id, (select auth.uid())) and created_by = (select auth.uid()));

drop policy if exists pipeline_invoices_update on public.pipeline_invoices;
create policy pipeline_invoices_update on public.pipeline_invoices
  for update to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())))
  with check (private.crm_can_bill(contact_id, (select auth.uid())));

-- No delete policy: an invoice is voided, never erased.
revoke all on public.pipeline_invoices from public, anon, authenticated;
grant select, insert on public.pipeline_invoices to authenticated;
grant update (voided_at, sent_to, sent_at, message_delivery_id) on public.pipeline_invoices to authenticated;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_payments (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.pipeline_packages(contact_id) on delete restrict,
  amount_cents  bigint not null check (amount_cents between 1 and 100000000),
  received_on   date not null,
  method        text not null check (method in ('card', 'ach', 'check', 'zelle', 'other')),
  note          text check (length(note) <= 300),
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists pipeline_payments_contact_idx on public.pipeline_payments (contact_id, received_on);

alter table public.pipeline_payments enable row level security;

drop policy if exists pipeline_payments_select on public.pipeline_payments;
create policy pipeline_payments_select on public.pipeline_payments
  for select to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())));

drop policy if exists pipeline_payments_insert on public.pipeline_payments;
create policy pipeline_payments_insert on public.pipeline_payments
  for insert to authenticated
  with check (private.crm_can_bill(contact_id, (select auth.uid())) and created_by = (select auth.uid()));

-- A payment recorded by mistake can be removed by whoever may bill.
drop policy if exists pipeline_payments_delete on public.pipeline_payments;
create policy pipeline_payments_delete on public.pipeline_payments
  for delete to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())));

revoke all on public.pipeline_payments from public, anon, authenticated;
grant select, insert, delete on public.pipeline_payments to authenticated;
