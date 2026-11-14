-- Invoice composer, part 1 of 3: the practice's own settings (routes/invoiceSettings.ts).
--
--   * `practice_payment_methods`  what a family may be told they can pay by: the built-ins (card, bank
--     transfer, Zelle, PayPal, check) seeded lazily by the API on first read, plus the practice's own
--     ("+ Add"). A label and the consultant's instructions ("Zelle to pay@practice.com"). Only "card"
--     goes through Stripe Checkout; the rest are paid outside and recorded with Record.
--   * `practice_invoice_style`    one row per practice: accent colour, an email-safe font, header
--     alignment, corner style, button label, footer text, logo on/off.
--   * `pipeline_package_templates`  the practice's package library ("Senior year", "Junior + Senior").
--     Assigning one to a family COPIES it into that family's `pipeline_packages` row (still editable),
--     so lib/payments.ts deriveAccount is unchanged.
--
-- Whose they are: the practice, the same scope as the pipeline's stages (`firm_id` for a firm member,
-- the counselor's own id when solo; `practice_id` is that scope, checked). Anyone who works in the
-- practice reads them; only a firm owner/admin (or the solo counselor) writes them
-- (`private.crm_can_admin`). A student never sees any of it.
--
-- Deploy order: either. Without this file the new routes answer 503 `invoice_settings_unavailable` and
-- the invoice flow works exactly as before. Additive only. Not in REQUIRED_SCHEMA. Re-runnable.

-- Whoever administers the practice that owns a row: a firm's owners and admins, or the solo counselor.
create or replace function private.crm_can_admin(p_firm uuid, p_counselor uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path to 'private', 'public'
as $$
  select private.is_counselor(p_viewer) and (
    case when p_firm is null then p_counselor = p_viewer
         else private.crm_firm_admin(p_firm, p_viewer) end
  );
$$;

revoke all on function private.crm_can_admin(uuid, uuid, uuid) from public, anon;
grant execute on function private.crm_can_admin(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Payment methods
-- ---------------------------------------------------------------------------

create table if not exists public.practice_payment_methods (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  practice_id   uuid not null,
  -- card | ach | zelle | paypal | check for a built-in; custom-<8 hex> for the practice's own.
  key           text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  label         text not null check (length(btrim(label)) between 1 and 60),
  instructions  text not null default '' check (length(instructions) <= 500),
  enabled       boolean not null default true,
  builtin       boolean not null default false,
  sort          integer not null default 0 check (sort between 0 and 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint practice_payment_methods_scope check (practice_id = coalesce(firm_id, counselor_id)),
  constraint practice_payment_methods_key_unique unique (practice_id, key)
);

drop trigger if exists practice_payment_methods_set_updated_at on public.practice_payment_methods;
create trigger practice_payment_methods_set_updated_at before update on public.practice_payment_methods
  for each row execute function public.set_updated_at();

alter table public.practice_payment_methods enable row level security;

drop policy if exists practice_payment_methods_select on public.practice_payment_methods;
create policy practice_payment_methods_select on public.practice_payment_methods
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists practice_payment_methods_insert on public.practice_payment_methods;
create policy practice_payment_methods_insert on public.practice_payment_methods
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid()))
              and private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

drop policy if exists practice_payment_methods_update on public.practice_payment_methods;
create policy practice_payment_methods_update on public.practice_payment_methods
  for update to authenticated
  using (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

drop policy if exists practice_payment_methods_delete on public.practice_payment_methods;
create policy practice_payment_methods_delete on public.practice_payment_methods
  for delete to authenticated
  using (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())) and not builtin);

revoke all on public.practice_payment_methods from public, anon, authenticated;
grant select, insert, delete on public.practice_payment_methods to authenticated;
grant update (label, instructions, enabled, sort) on public.practice_payment_methods to authenticated;

select private.attach_approval_gate('public.practice_payment_methods');

-- ---------------------------------------------------------------------------
-- Invoice style
-- ---------------------------------------------------------------------------

create table if not exists public.practice_invoice_style (
  practice_id   uuid primary key,
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  -- Null: the practice's own branding accent (or the app green).
  accent_color  text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Six email-safe font stacks; email clients drop web fonts, so these are the whole menu.
  font_key      text not null default 'serif' check (font_key in ('serif', 'sans', 'modern', 'classic', 'humanist', 'mono')),
  header_align  text not null default 'left' check (header_align in ('left', 'center')),
  corner        text not null default 'rounded' check (corner in ('square', 'rounded', 'pill')),
  button_label  text not null default 'Pay by card' check (length(btrim(button_label)) between 1 and 40),
  footer_text   text not null default '' check (length(footer_text) <= 300),
  show_logo     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint practice_invoice_style_scope check (practice_id = coalesce(firm_id, counselor_id))
);

drop trigger if exists practice_invoice_style_set_updated_at on public.practice_invoice_style;
create trigger practice_invoice_style_set_updated_at before update on public.practice_invoice_style
  for each row execute function public.set_updated_at();

alter table public.practice_invoice_style enable row level security;

drop policy if exists practice_invoice_style_select on public.practice_invoice_style;
create policy practice_invoice_style_select on public.practice_invoice_style
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists practice_invoice_style_insert on public.practice_invoice_style;
create policy practice_invoice_style_insert on public.practice_invoice_style
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid()))
              and private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

drop policy if exists practice_invoice_style_update on public.practice_invoice_style;
create policy practice_invoice_style_update on public.practice_invoice_style
  for update to authenticated
  using (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

revoke all on public.practice_invoice_style from public, anon, authenticated;
grant select, insert on public.practice_invoice_style to authenticated;
grant update (accent_color, font_key, header_align, corner, button_label, footer_text, show_logo)
  on public.practice_invoice_style to authenticated;

select private.attach_approval_gate('public.practice_invoice_style');

-- ---------------------------------------------------------------------------
-- Package templates
-- ---------------------------------------------------------------------------

create table if not exists public.pipeline_package_templates (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid references public.firms(id) on delete cascade,
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  practice_id      uuid not null,
  name             text not null check (length(btrim(name)) between 1 and 200),
  -- "Senior year", "Junior + Senior": which years it covers, free text.
  years_tag        text check (years_tag is null or length(years_tag) <= 40),
  total_cents      bigint not null check (total_cents between 0 and 100000000),
  deposit_cents    bigint not null default 0 check (deposit_cents >= 0 and deposit_cents <= total_cents),
  -- Payments in all, the deposit counted as the first.
  installments     integer not null default 1 check (installments between 1 and 60),
  duration_months  integer check (duration_months is null or duration_months between 1 and 120),
  inclusions       text[] not null default '{}' check (cardinality(inclusions) <= 20),
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pipeline_package_templates_scope check (practice_id = coalesce(firm_id, counselor_id))
);

create index if not exists pipeline_package_templates_practice_idx on public.pipeline_package_templates (practice_id, created_at);

drop trigger if exists pipeline_package_templates_set_updated_at on public.pipeline_package_templates;
create trigger pipeline_package_templates_set_updated_at before update on public.pipeline_package_templates
  for each row execute function public.set_updated_at();

alter table public.pipeline_package_templates enable row level security;

drop policy if exists pipeline_package_templates_select on public.pipeline_package_templates;
create policy pipeline_package_templates_select on public.pipeline_package_templates
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_package_templates_insert on public.pipeline_package_templates;
create policy pipeline_package_templates_insert on public.pipeline_package_templates
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid()))
              and private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

drop policy if exists pipeline_package_templates_update on public.pipeline_package_templates;
create policy pipeline_package_templates_update on public.pipeline_package_templates
  for update to authenticated
  using (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

-- No delete: a template that families were set up from is archived, not erased.
revoke all on public.pipeline_package_templates from public, anon, authenticated;
grant select, insert on public.pipeline_package_templates to authenticated;
grant update (name, years_tag, total_cents, deposit_cents, installments, duration_months, inclusions, archived_at)
  on public.pipeline_package_templates to authenticated;

select private.attach_approval_gate('public.pipeline_package_templates');
