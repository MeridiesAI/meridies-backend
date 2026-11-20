-- Contract Hub: a counselor uploads a PDF, adds the people who sign it, places their fields on the pages and
-- sends it; each signer opens an emailed link, types or draws a signature and fills their fields. A bare-minimum
-- port of SignuDoc's envelope model (github.com/NYLLON-SOFTWARE/signudoc, MIT). Typed or drawn acceptance, not a
-- certified e-signature: no sealed PDF, no certificate.
--
--   * `contract_hub_envelopes`  one contract: title, the PDF's path in the private `contract-hub` bucket, status
--     (draft, sent, completed, declined, voided) and its dates. Owned by one counselor (`counselor_id`).
--   * `contract_hub_signers`    up to 4 per envelope: name, email, status, the sha256 of their current link token,
--     and once signed their signature and initials (typed text or a drawn PNG, at most 60 KB each), the consent
--     time, IP and browser.
--   * `contract_hub_fields`     the boxes placed on the pages, in fractions of the page (0..1), each for one signer;
--     a name, text or date field keeps what the signer filled in. Signature and initials fields draw the signer's.
--   * `contract_hub_events`     the timeline.
--
-- Clients read their own rows (RLS: counselor_id = auth.uid(); fields, signers and events through their envelope)
-- and write NOTHING: every write is the API's, with the service role, after the caller's own RLS read showed the
-- envelope is theirs. So a counselor can't mark their own contract signed through PostgREST. Signing and declining
-- go through `contract_hub_sign` / `contract_hub_decline` (EXECUTE to service_role only), which lock the envelope
-- so two last signers can't both miss completing it.
--
-- Deploy order: either. Without this file every /contract-hub route answers 503 `contract_hub_unavailable` and
-- the app shows "Contract Hub isn't switched on yet". Additive only. Not in REQUIRED_SCHEMA. Re-runnable.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contract-hub', 'contract-hub', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
-- No storage.objects policy: only the API (service role) reads or writes the bucket.

create table if not exists public.contract_hub_envelopes (
  id            uuid primary key default gen_random_uuid(),
  counselor_id  uuid not null references public.profiles(id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 160),
  file_name     text not null check (length(file_name) between 1 and 200),
  storage_path  text not null unique check (length(storage_path) <= 200),
  page_count    int not null check (page_count between 1 and 500),
  status        text not null default 'draft' check (status in ('draft', 'sent', 'completed', 'declined', 'voided')),
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  completed_at  timestamptz,
  voided_at     timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists contract_hub_envelopes_counselor_idx on public.contract_hub_envelopes (counselor_id, created_at desc);

drop trigger if exists contract_hub_envelopes_set_updated_at on public.contract_hub_envelopes;
create trigger contract_hub_envelopes_set_updated_at before update on public.contract_hub_envelopes
  for each row execute function public.set_updated_at();

create table if not exists public.contract_hub_signers (
  id              uuid primary key default gen_random_uuid(),
  envelope_id     uuid not null references public.contract_hub_envelopes(id) on delete cascade,
  sort_order      int not null default 0,
  name            text not null check (length(btrim(name)) between 1 and 120),
  email           text not null check (length(email) between 3 and 254),
  status          text not null default 'waiting' check (status in ('waiting', 'signed', 'declined')),
  token_hash      text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  signature_kind  text check (signature_kind in ('typed', 'drawn')),
  signature_text  text check (length(signature_text) <= 120),
  signature_png   bytea check (length(signature_png) <= 61440),
  initials_kind   text check (initials_kind in ('typed', 'drawn')),
  initials_text   text check (length(initials_text) <= 12),
  initials_png    bytea check (length(initials_png) <= 61440),
  consent_at      timestamptz,
  signed_at       timestamptz,
  signed_ip       text check (length(signed_ip) <= 64),
  signed_user_agent text check (length(signed_user_agent) <= 300),
  decline_reason  text check (length(decline_reason) <= 500),
  declined_at     timestamptz
);

create index if not exists contract_hub_signers_envelope_idx on public.contract_hub_signers (envelope_id, sort_order);

create table if not exists public.contract_hub_fields (
  id          uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references public.contract_hub_envelopes(id) on delete cascade,
  signer_id   uuid not null references public.contract_hub_signers(id) on delete cascade,
  type        text not null check (type in ('signature', 'initials', 'date', 'name', 'text')),
  page        int not null check (page between 1 and 500),
  x           double precision not null check (x >= 0 and x <= 1),
  y           double precision not null check (y >= 0 and y <= 1),
  w           double precision not null check (w > 0 and w <= 1),
  h           double precision not null check (h > 0 and h <= 1),
  value       text check (length(value) <= 200),
  constraint contract_hub_fields_on_page check (x + w <= 1.0001 and y + h <= 1.0001)
);

create index if not exists contract_hub_fields_envelope_idx on public.contract_hub_fields (envelope_id);
create index if not exists contract_hub_fields_signer_idx on public.contract_hub_fields (signer_id);

create table if not exists public.contract_hub_events (
  id          bigint generated always as identity primary key,
  envelope_id uuid not null references public.contract_hub_envelopes(id) on delete cascade,
  at          timestamptz not null default now(),
  text        text not null check (length(text) between 1 and 300)
);

create index if not exists contract_hub_events_envelope_idx on public.contract_hub_events (envelope_id, at);

-- ---------------------------------------------------------------------------
-- RLS: the owner reads; nobody writes from a client
-- ---------------------------------------------------------------------------

alter table public.contract_hub_envelopes enable row level security;
alter table public.contract_hub_signers enable row level security;
alter table public.contract_hub_fields enable row level security;
alter table public.contract_hub_events enable row level security;

create or replace function private.contract_hub_owns(p_envelope uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.contract_hub_envelopes e where e.id = p_envelope and e.counselor_id = p_user);
$$;
revoke all on function private.contract_hub_owns(uuid, uuid) from public, anon;
grant execute on function private.contract_hub_owns(uuid, uuid) to authenticated, service_role;

drop policy if exists contract_hub_envelopes_select on public.contract_hub_envelopes;
create policy contract_hub_envelopes_select on public.contract_hub_envelopes
  for select to authenticated using (counselor_id = (select auth.uid()));

drop policy if exists contract_hub_signers_select on public.contract_hub_signers;
create policy contract_hub_signers_select on public.contract_hub_signers
  for select to authenticated using (private.contract_hub_owns(envelope_id, (select auth.uid())));

drop policy if exists contract_hub_fields_select on public.contract_hub_fields;
create policy contract_hub_fields_select on public.contract_hub_fields
  for select to authenticated using (private.contract_hub_owns(envelope_id, (select auth.uid())));

drop policy if exists contract_hub_events_select on public.contract_hub_events;
create policy contract_hub_events_select on public.contract_hub_events
  for select to authenticated using (private.contract_hub_owns(envelope_id, (select auth.uid())));

revoke all on public.contract_hub_envelopes, public.contract_hub_signers, public.contract_hub_fields, public.contract_hub_events
  from public, anon, authenticated;
grant select on public.contract_hub_envelopes, public.contract_hub_fields, public.contract_hub_events to authenticated;
-- A signer's link hash and signature image stay server-side: the client reads the rest of the row.
grant select (id, envelope_id, sort_order, name, email, status, signature_kind, signature_text, initials_kind, initials_text,
              consent_at, signed_at, decline_reason, declined_at)
  on public.contract_hub_signers to authenticated;

select private.attach_approval_gate('public.contract_hub_envelopes');
select private.attach_approval_gate('public.contract_hub_signers');
select private.attach_approval_gate('public.contract_hub_fields');
select private.attach_approval_gate('public.contract_hub_events');

-- ---------------------------------------------------------------------------
-- Signing and declining, atomically (service role only)
-- ---------------------------------------------------------------------------

-- One signer finishes. p_values maps the signer's own name/text field ids to what they typed (anything else is
-- ignored); date fields take p_date. Returns the envelope's status after: 'sent' (others still to sign) or
-- 'completed'. Raises 'not_open' when the envelope isn't out for signature or this signer already answered.
create or replace function public.contract_hub_sign(
  p_signer uuid,
  p_values jsonb,
  p_date text,
  p_signature_kind text,
  p_signature_text text,
  p_signature_png_b64 text,
  p_initials_kind text,
  p_initials_text text,
  p_initials_png_b64 text,
  p_ip text,
  p_user_agent text
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_env uuid;
  v_status text;
  v_name text;
  v_left int;
begin
  select s.envelope_id, s.name into v_env, v_name from public.contract_hub_signers s where s.id = p_signer;
  if v_env is null then raise exception 'not_open'; end if;
  select e.status into v_status from public.contract_hub_envelopes e where e.id = v_env for update;
  if v_status <> 'sent' then raise exception 'not_open'; end if;

  update public.contract_hub_signers
     set status = 'signed', signed_at = now(), consent_at = now(),
         signature_kind = p_signature_kind, signature_text = p_signature_text,
         signature_png = case when p_signature_png_b64 is null then null else decode(p_signature_png_b64, 'base64') end,
         initials_kind = p_initials_kind, initials_text = p_initials_text,
         initials_png = case when p_initials_png_b64 is null then null else decode(p_initials_png_b64, 'base64') end,
         signed_ip = left(p_ip, 64), signed_user_agent = left(p_user_agent, 300),
         token_hash = null, token_expires_at = null
   where id = p_signer and status = 'waiting';
  if not found then raise exception 'not_open'; end if;

  update public.contract_hub_fields f
     set value = case when f.type = 'date' then left(p_date, 200) else left(p_values ->> f.id::text, 200) end
   where f.signer_id = p_signer and f.type in ('date', 'name', 'text');

  insert into public.contract_hub_events (envelope_id, text) values (v_env, left(v_name || ' signed', 300));

  select count(*) into v_left from public.contract_hub_signers where envelope_id = v_env and status <> 'signed';
  if v_left = 0 then
    update public.contract_hub_envelopes set status = 'completed', completed_at = now() where id = v_env;
    insert into public.contract_hub_events (envelope_id, text) values (v_env, 'Completed: everyone has signed');
    return 'completed';
  end if;
  return 'sent';
end;
$$;
revoke all on function public.contract_hub_sign(uuid, jsonb, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.contract_hub_sign(uuid, jsonb, text, text, text, text, text, text, text, text, text) to service_role;

create or replace function public.contract_hub_decline(p_signer uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_env uuid;
  v_status text;
  v_name text;
begin
  select s.envelope_id, s.name into v_env, v_name from public.contract_hub_signers s where s.id = p_signer;
  if v_env is null then raise exception 'not_open'; end if;
  select e.status into v_status from public.contract_hub_envelopes e where e.id = v_env for update;
  if v_status <> 'sent' then raise exception 'not_open'; end if;
  update public.contract_hub_signers
     set status = 'declined', declined_at = now(), decline_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), ''),
         token_hash = null, token_expires_at = null
   where id = p_signer and status = 'waiting';
  if not found then raise exception 'not_open'; end if;
  update public.contract_hub_envelopes set status = 'declined' where id = v_env;
  -- Every other open link stops working too: a declined contract can't be signed.
  update public.contract_hub_signers set token_hash = null, token_expires_at = null where envelope_id = v_env;
  insert into public.contract_hub_events (envelope_id, text)
  values (v_env, left(v_name || ' declined' || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), ''), 300));
end;
$$;
revoke all on function public.contract_hub_decline(uuid, text) from public, anon, authenticated;
grant execute on function public.contract_hub_decline(uuid, text) to service_role;
