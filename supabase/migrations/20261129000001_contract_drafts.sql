-- Draft a contract in Meridies (docs/superpowers/specs/2026-11-18-contract-drafting-design.md).
--
--   * `contract_drafts`  the practice's library of contracts written in Meridies: a title and an ordered
--     `sections` jsonb array (the API validates its shape and size). Practice-scoped exactly like
--     `contract_files`: members read, a firm owner/admin or the solo counselor writes, no delete (archive).
--     Attaching one to an invoice renders it to text and saves a regular `agreements` row, so each family
--     gets its own frozen copy; this table is the editable source and never changes what was sent.
--   * `counselor_signatures`  one row per consultant (`counselor_id`): the signature stamped on contracts at
--     send, typed or a drawn PNG (at most 60 KB) with its SHA-256. Owner-only, and replaceable: a contract
--     never reads it again once it is signed.
--   * `agreement_signatures`  the frozen copy of that signature taken when a contract is sent, one per
--     agreement. Insert-only: the caller's own client writes it right after saving the draft agreement
--     (insert policy: the agreement is theirs and still a draft), nothing updates it, and a trigger refuses
--     an update and a truncate always and a delete unless it is the cascade from its agreement (a trigger
--     nested inside the parent's own delete, `pg_trigger_depth() > 1`). A direct delete is refused for every
--     role, postgres included. A signed agreement still can't be deleted (its acceptance RESTRICTs), so its
--     signature stays; a sent-but-unaccepted contract goes with its contact as before, and AxIS Restore puts
--     the signature back with it (`agreement_signatures` is captured, rule `parent`). `contract_drafts` is
--     not: no covered delete reaches it, like `contract_files`. `agreements` and its guard are unchanged:
--     the rendered text carries the signature block, so its body hash covers it.
--
-- Deploy order: after 20261128000001. Either order with the code: without this file the draft routes
-- answer 503 `contract_drafts_unavailable` and invoices, agreements and uploaded contracts work as before.
-- Additive only. Not in REQUIRED_SCHEMA. Re-runnable.

-- ---------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------

create table if not exists public.contract_drafts (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid references public.firms(id) on delete cascade,
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  practice_id   uuid not null,
  title         text not null check (length(btrim(title)) between 1 and 160),
  sections      jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array'),
  archived_at   timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint contract_drafts_scope check (practice_id = coalesce(firm_id, counselor_id))
);

create index if not exists contract_drafts_practice_idx on public.contract_drafts (practice_id, created_at desc);

drop trigger if exists contract_drafts_set_updated_at on public.contract_drafts;
create trigger contract_drafts_set_updated_at before update on public.contract_drafts
  for each row execute function public.set_updated_at();

alter table public.contract_drafts enable row level security;

drop policy if exists contract_drafts_select on public.contract_drafts;
create policy contract_drafts_select on public.contract_drafts
  for select to authenticated
  using (private.crm_can_access(firm_id, counselor_id, (select auth.uid())));

drop policy if exists contract_drafts_insert on public.contract_drafts;
create policy contract_drafts_insert on public.contract_drafts
  for insert to authenticated
  with check (private.crm_is_own_workspace(firm_id, counselor_id, (select auth.uid()))
              and private.crm_can_admin(firm_id, counselor_id, (select auth.uid()))
              and created_by = (select auth.uid()));

drop policy if exists contract_drafts_update on public.contract_drafts;
create policy contract_drafts_update on public.contract_drafts
  for update to authenticated
  using (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())))
  with check (private.crm_can_admin(firm_id, counselor_id, (select auth.uid())));

-- No delete: a contract a family may have accepted was copied from it; archive it instead.
revoke all on public.contract_drafts from public, anon, authenticated;
grant select, insert on public.contract_drafts to authenticated;
grant update (title, sections, archived_at, updated_at) on public.contract_drafts to authenticated;

select private.attach_approval_gate('public.contract_drafts');

-- ---------------------------------------------------------------------------
-- The consultant's saved signature: theirs alone
-- ---------------------------------------------------------------------------

create table if not exists public.counselor_signatures (
  counselor_id  uuid primary key references public.profiles(id) on delete cascade,
  signer_name   text not null check (length(btrim(signer_name)) between 1 and 120),
  kind          text not null check (kind in ('typed', 'drawn')),
  image_png     bytea check (length(image_png) <= 61440),
  image_sha256  text,
  updated_at    timestamptz not null default now(),
  constraint counselor_signatures_image_kind check ((kind = 'drawn') = (image_png is not null)),
  constraint counselor_signatures_sha_shape check (
    (image_sha256 is null or image_sha256 ~ '^[0-9a-f]{64}$') and (kind <> 'drawn' or image_sha256 is not null))
);

drop trigger if exists counselor_signatures_set_updated_at on public.counselor_signatures;
create trigger counselor_signatures_set_updated_at before update on public.counselor_signatures
  for each row execute function public.set_updated_at();

alter table public.counselor_signatures enable row level security;

drop policy if exists counselor_signatures_select on public.counselor_signatures;
create policy counselor_signatures_select on public.counselor_signatures
  for select to authenticated
  using (counselor_id = (select auth.uid()));

drop policy if exists counselor_signatures_insert on public.counselor_signatures;
create policy counselor_signatures_insert on public.counselor_signatures
  for insert to authenticated
  with check (counselor_id = (select auth.uid()));

drop policy if exists counselor_signatures_update on public.counselor_signatures;
create policy counselor_signatures_update on public.counselor_signatures
  for update to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

-- No delete: a consultant replaces the signature, they don't go without one mid-send.
revoke all on public.counselor_signatures from public, anon, authenticated;
grant select, insert, update on public.counselor_signatures to authenticated;

select private.attach_approval_gate('public.counselor_signatures');

-- ---------------------------------------------------------------------------
-- The signature as it was when the contract was sent: immutable
-- ---------------------------------------------------------------------------

create table if not exists public.agreement_signatures (
  agreement_id  uuid primary key references public.agreements(id) on delete cascade,
  signer_name   text not null check (length(btrim(signer_name)) between 1 and 120),
  kind          text not null check (kind in ('typed', 'drawn')),
  image_png     bytea check (length(image_png) <= 61440),
  image_sha256  text,
  signed_at     timestamptz not null default now(),
  constraint agreement_signatures_image_kind check ((kind = 'drawn') = (image_png is not null)),
  constraint agreement_signatures_sha_shape check (
    (image_sha256 is null or image_sha256 ~ '^[0-9a-f]{64}$') and (kind <> 'drawn' or image_sha256 is not null))
);

-- Refuses every update and truncate, and every delete but the cascade from the agreement: that delete runs this
-- trigger nested inside the parent's own foreign-key trigger (depth 2 or more), a direct one at depth 1.
create or replace function private.agreement_signatures_immutable()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'An agreement signature is a permanent record and can''t be changed or removed' using errcode = '42501';
end;
$$;

revoke all on function private.agreement_signatures_immutable() from public, anon, authenticated;

drop trigger if exists agreement_signatures_immutable on public.agreement_signatures;
create trigger agreement_signatures_immutable before update or delete on public.agreement_signatures
  for each row execute function private.agreement_signatures_immutable();
drop trigger if exists agreement_signatures_no_truncate on public.agreement_signatures;
create trigger agreement_signatures_no_truncate before truncate on public.agreement_signatures
  for each statement execute function private.agreement_signatures_immutable();

alter table public.agreement_signatures enable row level security;

drop policy if exists agreement_signatures_select on public.agreement_signatures;
create policy agreement_signatures_select on public.agreement_signatures
  for select to authenticated
  using (exists (
    select 1 from public.agreements a
    where a.id = agreement_id and private.crm_can_bill(a.contact_id, (select auth.uid()))
  ));

-- The caller's own client writes it right after saving the draft agreement: theirs, and still a draft.
drop policy if exists agreement_signatures_insert on public.agreement_signatures;
create policy agreement_signatures_insert on public.agreement_signatures
  for insert to authenticated
  with check (exists (
    select 1 from public.agreements a
    where a.id = agreement_id and a.counselor_id = (select auth.uid()) and a.status = 'draft'
  ));

-- No update or delete grant for anyone (the service role reads the image for the family's page, and may write).
revoke all on public.agreement_signatures from public, anon, authenticated, service_role;
grant select, insert on public.agreement_signatures to authenticated, service_role;

select private.attach_approval_gate('public.agreement_signatures');

-- ---------------------------------------------------------------------------
-- AxIS trash (20261108000003): a deleted contact's contract signature is kept
-- ---------------------------------------------------------------------------
-- `agreement_signatures` cascades from `agreements` (captured, 20261111000010), so a covered delete of a contact
-- reaches it and Restore must put it back with its agreement: rule `parent`, as for `agreement_tokens`. An
-- accepted agreement never reaches the trash (its acceptance RESTRICTs the delete), so neither does its signature.
-- Skipped when the trash migration isn't in.
do $$
begin
  if to_regclass('private.axis_trash_rules') is not null
     and to_regprocedure('private.attach_axis_trash(regclass, text[], boolean)') is not null then
    insert into private.axis_trash_rules (table_name, rule, columns, student_col) values
      ('agreement_signatures', 'parent', '{agreement_id}', null)
    on conflict (table_name) do update set rule = excluded.rule, columns = excluded.columns, student_col = excluded.student_col;
    perform private.attach_axis_trash('public.agreement_signatures');
  end if;
end;
$$;
