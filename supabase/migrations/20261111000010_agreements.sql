-- Agreements with typed-name acceptance (routes/agreements.ts, lib/agreements.ts).
--
-- A counselor attaches a plain-text agreement to a Contact Pipeline contact and
-- emails the family a private link (`/agree/<token>`); the family accepts by
-- typing their name and ticking a consent box. THIS IS TYPED-NAME ACCEPTANCE,
-- NOT A CERTIFIED ELECTRONIC SIGNATURE. The API keeps the feature switched off
-- (AGREEMENTS_ENABLED) until the consent wording has been reviewed.
--
--   * `agreements`  the document: title and body text, the body's sha256 (always
--     computed here, never taken from a client), status draft -> sent ->
--     accepted, or draft|sent -> void. The title and body can't change once it
--     has been sent, and nothing about it changes once accepted or voided.
--     Whoever may bill the contact (`private.crm_can_bill`: a solo counselor, a
--     firm's owners/admins, the contact's owner) may create, read and void it.
--   * `agreement_tokens`  the capability in a link, stored as a sha256 only. No
--     client grant or policy: `issue_agreement_link` (SECURITY DEFINER, called
--     on the CALLER's client, checking `crm_can_bill` for auth.uid()) mints one
--     and marks the agreement sent, expiring any earlier unexpired link (a resend
--     supersedes the old email); the public page reads them with the service role.
--   * `agreement_acceptances`  one per agreement (unique), immutable: no update
--     or delete grant for anyone, the service role included, and a trigger that
--     refuses an update, a delete or a truncate even as postgres. Written only by
--     `accept_agreement` (EXECUTE to service_role only), which in one
--     transaction checks the token and the status under a row lock, inserts the
--     acceptance with its certificate, marks the agreement accepted, writes an
--     `audit_log` row and moves the contact to the workspace's "Contract signed"
--     stage when that stage is ahead of where the contact is.
--
-- Retention: an accepted agreement RESTRICTs deletion (the acceptance restricts
-- its agreement), so a contact, and through it an account, with an accepted
-- agreement can't be deleted, like a contact with billing history. Whether to
-- keep or erase on request is a decision still open.
--
-- No PDF: `storage_path` is reserved and stays null (no client grant, no bucket).
--
-- Deploy order: either. Without this file the API's agreement routes answer 503
-- `agreements_unavailable` (and 404 `agreements_off` while switched off). Not in
-- REQUIRED_SCHEMA. Additive only.

-- ---------------------------------------------------------------------------
-- Agreements
-- ---------------------------------------------------------------------------

create table if not exists public.agreements (
  id               uuid primary key default gen_random_uuid(),
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  firm_id          uuid references public.firms(id) on delete cascade,
  contact_id       uuid not null references public.pipeline_contacts(id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 160),
  body_text        text not null check (length(body_text) between 1 and 60000 and length(btrim(body_text)) > 0),
  body_sha256      text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path     text check (storage_path is null),
  consent_version  text not null check (length(consent_version) between 1 and 40),
  status           text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'void')),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  accepted_at      timestamptz,
  voided_at        timestamptz
);

create index if not exists agreements_contact_idx on public.agreements (contact_id, created_at desc);

-- The hash is the database's; a client never chooses it, the workspace or the
-- timestamps. Status moves only forward, and a sent agreement's text is fixed.
-- A client session is told apart by the `role` setting (PostgREST's SET ROLE),
-- not current_user: this function is SECURITY DEFINER, so current_user is always
-- its owner here. SET ROLE survives a definer call, so a client calling
-- issue_agreement_link is still a client (it only needs draft -> sent), while
-- accept_agreement runs for the service role and may move sent -> accepted.
create or replace function private.agreements_guard()
returns trigger
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_client boolean := coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' and current_setting('meridies.axis_restore', true) = 'on' then
    -- AxIS Restore (20261108000003) puts back a row its trash kept when the contact was deleted, as it was: a sent
    -- agreement stays sent with its times, so its link works again. Never an accepted one: a signed agreement can't
    -- be deleted (its acceptance RESTRICTs), so no trash row can honestly hold one, and a restore must not be able
    -- to forge that state. The hash is recomputed and the workspace re-read, as on any insert.
    if new.status not in ('draft', 'sent', 'void') or new.accepted_at is not null then
      raise exception 'An accepted agreement can''t be restored' using errcode = '42501';
    end if;
    select c.firm_id into new.firm_id from public.pipeline_contacts c where c.id = new.contact_id;
    new.body_sha256 := encode(sha256(convert_to(new.body_text, 'UTF8')), 'hex');
    new.storage_path := null;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.sent_at := null;
    new.accepted_at := null;
    new.voided_at := null;
    new.created_at := now();
    new.storage_path := null;
    select c.firm_id into new.firm_id from public.pipeline_contacts c where c.id = new.contact_id;
    new.body_sha256 := encode(sha256(convert_to(new.body_text, 'UTF8')), 'hex');
    return new;
  end if;

  if old.status in ('accepted', 'void') then
    raise exception 'This agreement can no longer be changed' using errcode = 'P0001';
  end if;

  new.id := old.id;
  new.counselor_id := old.counselor_id;
  new.contact_id := old.contact_id;
  new.firm_id := old.firm_id;
  new.created_at := old.created_at;
  new.storage_path := old.storage_path;

  if (new.title, new.body_text) is distinct from (old.title, old.body_text) and old.status <> 'draft' then
    raise exception 'An agreement can''t be edited once it has been sent' using errcode = 'P0001';
  end if;
  new.body_sha256 := encode(sha256(convert_to(new.body_text, 'UTF8')), 'hex');

  if v_client then
    new.sent_at := old.sent_at;
    new.accepted_at := old.accepted_at;
    new.voided_at := old.voided_at;
    new.consent_version := old.consent_version;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'sent' then
      new.sent_at := coalesce(case when v_client then null else new.sent_at end, now());
    elsif old.status = 'sent' and new.status = 'accepted' and not v_client then
      new.accepted_at := coalesce(new.accepted_at, now());
    elsif old.status in ('draft', 'sent') and new.status = 'void' then
      new.voided_at := now();
    else
      raise exception 'That change of status isn''t allowed' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.agreements_guard() from public, anon, authenticated;

drop trigger if exists agreements_guard on public.agreements;
create trigger agreements_guard before insert or update on public.agreements
  for each row execute function private.agreements_guard();

alter table public.agreements enable row level security;

drop policy if exists agreements_select on public.agreements;
create policy agreements_select on public.agreements
  for select to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())));

drop policy if exists agreements_insert on public.agreements;
create policy agreements_insert on public.agreements
  for insert to authenticated
  with check (counselor_id = (select auth.uid()) and private.crm_can_bill(contact_id, (select auth.uid())));

drop policy if exists agreements_update on public.agreements;
create policy agreements_update on public.agreements
  for update to authenticated
  using (private.crm_can_bill(contact_id, (select auth.uid())))
  with check (private.crm_can_bill(contact_id, (select auth.uid())));

-- No delete: a sent agreement stays on the record (void it instead).
revoke all on public.agreements from public, anon, authenticated;
grant select on public.agreements to authenticated;
grant insert (counselor_id, contact_id, title, body_text, consent_version) on public.agreements to authenticated;
grant update (title, body_text, status) on public.agreements to authenticated;

select private.attach_approval_gate('public.agreements');

-- ---------------------------------------------------------------------------
-- Link tokens: hash only, service role only
-- ---------------------------------------------------------------------------

create table if not exists public.agreement_tokens (
  token_hash    text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  agreement_id  uuid not null references public.agreements(id) on delete cascade,
  expires_at    timestamptz not null,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists agreement_tokens_agreement_idx on public.agreement_tokens (agreement_id);

alter table public.agreement_tokens enable row level security;
revoke all on public.agreement_tokens from public, anon, authenticated;

select private.attach_approval_gate('public.agreement_tokens');

-- ---------------------------------------------------------------------------
-- Acceptances: immutable
-- ---------------------------------------------------------------------------

create table if not exists public.agreement_acceptances (
  id                uuid primary key default gen_random_uuid(),
  agreement_id      uuid not null unique references public.agreements(id) on delete restrict,
  signer_name       text not null check (length(btrim(signer_name)) between 2 and 120),
  signer_email      text check (signer_email is null or length(signer_email) <= 320),
  accepted_at       timestamptz not null default now(),
  ip                inet,
  user_agent        text check (user_agent is null or length(user_agent) <= 512),
  body_sha256       text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  consent_version   text not null check (length(consent_version) between 1 and 40),
  certificate_text  text not null check (length(certificate_text) between 1 and 20000)
);

create or replace function private.agreement_acceptances_immutable()
returns trigger
language plpgsql
set search_path to 'private', 'public'
as $$
begin
  raise exception 'An agreement acceptance is a permanent record and can''t be changed or removed' using errcode = '42501';
end;
$$;

revoke all on function private.agreement_acceptances_immutable() from public, anon, authenticated;

drop trigger if exists agreement_acceptances_immutable on public.agreement_acceptances;
create trigger agreement_acceptances_immutable before update or delete on public.agreement_acceptances
  for each row execute function private.agreement_acceptances_immutable();
drop trigger if exists agreement_acceptances_no_truncate on public.agreement_acceptances;
create trigger agreement_acceptances_no_truncate before truncate on public.agreement_acceptances
  for each statement execute function private.agreement_acceptances_immutable();

alter table public.agreement_acceptances enable row level security;

drop policy if exists agreement_acceptances_select on public.agreement_acceptances;
create policy agreement_acceptances_select on public.agreement_acceptances
  for select to authenticated
  using (exists (
    select 1 from public.agreements a
    where a.id = agreement_id and private.crm_can_bill(a.contact_id, (select auth.uid()))
  ));

revoke all on public.agreement_acceptances from public, anon, authenticated, service_role;
grant select on public.agreement_acceptances to authenticated, service_role;

select private.attach_approval_gate('public.agreement_acceptances');

-- ---------------------------------------------------------------------------
-- Sending: mint a link on the caller's own client
-- ---------------------------------------------------------------------------

-- An earlier draft of this file took the consent version from the caller.
drop function if exists public.issue_agreement_link(uuid, text, timestamptz, text);

-- Mint a link and mark the agreement sent. Every earlier link to the agreement
-- that hasn't expired expires now, so a superseded email can't be used.
create or replace function public.issue_agreement_link(
  p_agreement uuid, p_token_hash text, p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_uid uuid := (select auth.uid());
  a     public.agreements;
begin
  if v_uid is null or not private.account_open(v_uid) then
    raise exception 'Only an approved counselor can send an agreement' using errcode = '42501';
  end if;
  select * into a from public.agreements where id = p_agreement for update;
  if not found or not private.crm_can_bill(a.contact_id, v_uid) then
    raise exception 'No agreement of yours matches that' using errcode = 'P0002';
  end if;
  if a.status not in ('draft', 'sent') then
    raise exception 'This agreement was already accepted or withdrawn' using errcode = 'P0001';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    raise exception 'A link lasts between now and 90 days' using errcode = '22023';
  end if;
  update public.agreement_tokens set expires_at = now()
   where agreement_id = p_agreement and expires_at > now();
  insert into public.agreement_tokens (token_hash, agreement_id, expires_at, created_by)
  values (p_token_hash, p_agreement, p_expires_at, v_uid);
  update public.agreements set status = 'sent' where id = p_agreement;
end;
$$;

revoke all on function public.issue_agreement_link(uuid, text, timestamptz) from public, anon;
grant execute on function public.issue_agreement_link(uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Accepting: one transaction, service role only (the public page)
-- ---------------------------------------------------------------------------

create or replace function public.accept_agreement(
  p_token_hash text, p_signer_name text, p_signer_email text, p_ip inet, p_user_agent text,
  p_consent_version text, p_body_sha256 text, p_accepted_at timestamptz, p_certificate text
) returns jsonb
language plpgsql
security definer
set search_path to 'private', 'public'
as $$
declare
  v_tok      public.agreement_tokens;
  a          public.agreements;
  c          public.pipeline_contacts;
  v_acc      uuid;
  v_cur_pos  integer;
  v_target   public.pipeline_stages;
  v_moved    text;
begin
  select * into v_tok from public.agreement_tokens where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;
  select * into a from public.agreements where id = v_tok.agreement_id for update;
  if a.status = 'accepted' then
    return jsonb_build_object('result', 'already', 'agreement_id', a.id);
  elsif a.status = 'void' then
    return jsonb_build_object('result', 'void');
  elsif a.status <> 'sent' then
    return jsonb_build_object('result', 'invalid');
  end if;
  if v_tok.expires_at <= now() then
    return jsonb_build_object('result', 'expired');
  end if;
  if a.body_sha256 <> p_body_sha256 then
    return jsonb_build_object('result', 'invalid');
  end if;

  insert into public.agreement_acceptances
    (agreement_id, signer_name, signer_email, accepted_at, ip, user_agent, body_sha256, consent_version, certificate_text)
  values
    (a.id, p_signer_name, p_signer_email, p_accepted_at, p_ip, p_user_agent, a.body_sha256, p_consent_version, p_certificate)
  on conflict (agreement_id) do nothing
  returning id into v_acc;
  if v_acc is null then
    return jsonb_build_object('result', 'already', 'agreement_id', a.id);
  end if;

  -- The consent version is the one the family was shown (the server's), recorded on the agreement too.
  update public.agreements set status = 'accepted', accepted_at = p_accepted_at, consent_version = p_consent_version where id = a.id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata, ip, user_agent)
  values (null, 'agreement.accepted', 'agreement', a.id,
          jsonb_build_object('contact_id', a.contact_id, 'acceptance_id', v_acc, 'body_sha256', a.body_sha256,
                             'consent_version', p_consent_version),
          p_ip, p_user_agent);

  -- "Contract signed" (a default stage), only forward and only for an open contact.
  select * into c from public.pipeline_contacts where id = a.contact_id for update;
  if found and c.status = 'open' then
    select position into v_cur_pos from public.pipeline_stages where id = c.stage_id;
    select s.* into v_target from public.pipeline_stages s
     where s.firm_id is not distinct from c.firm_id
       and (c.firm_id is not null or s.counselor_id = c.counselor_id)
       and lower(btrim(s.name)) = 'contract signed'
     order by s.position, s.created_at
     limit 1;
    if v_target.id is not null and v_target.id <> c.stage_id and coalesce(v_cur_pos, 0) < v_target.position then
      update public.pipeline_contacts
         set stage_id = v_target.id,
             position = (select coalesce(max(p.position) + 1, 0) from public.pipeline_contacts p where p.stage_id = v_target.id)
       where id = c.id;
      v_moved := v_target.name;
    end if;
  end if;

  return jsonb_build_object('result', 'accepted', 'agreement_id', a.id, 'acceptance_id', v_acc, 'moved_to', v_moved);
end;
$$;

revoke all on function public.accept_agreement(text, text, text, inet, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.accept_agreement(text, text, text, inet, text, text, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- AxIS trash (20261108000003): a deleted contact's agreements are kept
-- ---------------------------------------------------------------------------
-- An AxIS delete of a contact keeps every row it reaches by cascade, so Restore can put them back. `agreements`
-- cascades from `pipeline_contacts` (captured) and `agreement_tokens` from `agreements`, so both are captured, with
-- the "parent" rule: they come back only with a contact the restorer may have back. `agreement_acceptances` is not:
-- its key RESTRICTs, so a contact with a signed agreement can't be deleted at all (DELETE /pipeline/contacts answers
-- 409 agreement_on_file) and an acceptance never reaches the trash. During a restore `agreements_guard` keeps the
-- row as it was but refuses an accepted one (above). Skipped when the trash migration isn't in.
do $$
begin
  if to_regclass('private.axis_trash_rules') is not null
     and to_regprocedure('private.attach_axis_trash(regclass, text[], boolean)') is not null then
    insert into private.axis_trash_rules (table_name, rule, columns, student_col) values
      ('agreements', 'parent', '{contact_id}', null),
      ('agreement_tokens', 'parent', '{agreement_id}', null)
    on conflict (table_name) do update set rule = excluded.rule, columns = excluded.columns, student_col = excluded.student_col;
    perform private.attach_axis_trash('public.agreements');
    perform private.attach_axis_trash('public.agreement_tokens');
  end if;
end;
$$;
