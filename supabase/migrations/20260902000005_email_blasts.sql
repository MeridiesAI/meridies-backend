-- Email blast.
--
-- The Communication tab is gone from the product; blasting is a popup. That
-- changes where it lives, not what it needs: a record of what was sent, to
-- whom, and whether it arrived.
--
-- Audiences are DERIVED, never stored as a list a counselor has to maintain —
-- entire roster, by class year, by school applied to, by application status.
-- The blast stores the rule it was sent with (`audience_kind` + value) and the
-- resolved recipients at send time, because a roster changes and "who actually
-- got this" must stay answerable a year later.
--
-- Delivery reuses `message_deliveries` rather than a second outbound log.

create table if not exists public.email_blasts (
  id               uuid primary key default gen_random_uuid(),
  counselor_id     uuid not null references public.profiles(id) on delete cascade,
  firm_id          uuid references public.firms(id) on delete set null,
  subject          text not null check (length(btrim(subject)) between 1 and 300),
  body             text not null check (length(btrim(body)) between 1 and 20000),
  audience_kind    text not null check (audience_kind in
                     ('roster','class-year','school','status','selection')),
  -- The grad year, school name, or status the audience was filtered by. Null
  -- for 'roster' and 'selection'.
  audience_value   text check (length(audience_value) <= 200),
  -- Human-readable, frozen at send time: "Class of 2027 (14 students)".
  audience_label   text check (length(audience_label) <= 200),
  channel          text not null default 'email' check (channel in ('email','sms','both')),
  status           text not null default 'draft'
                   check (status in ('draft','sending','sent','partial','failed','cancelled')),
  recipient_count  integer not null default 0 check (recipient_count >= 0),
  delivered_count  integer not null default 0 check (delivered_count >= 0),
  failed_count     integer not null default 0 check (failed_count >= 0),
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint email_blasts_targeted_kinds_need_a_value check (
    audience_kind in ('roster','selection') or audience_value is not null
  )
);

create index if not exists email_blasts_counselor_idx
  on public.email_blasts (counselor_id, created_at desc);

drop trigger if exists email_blasts_set_updated_at on public.email_blasts;
create trigger email_blasts_set_updated_at before update on public.email_blasts
  for each row execute function public.set_updated_at();

alter table public.email_blasts enable row level security;

drop policy if exists email_blasts_owner on public.email_blasts;
create policy email_blasts_owner on public.email_blasts
  for all to authenticated
  using (counselor_id = (select auth.uid()))
  with check (counselor_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Who it went to, resolved at send time.
-- ---------------------------------------------------------------------------

create table if not exists public.email_blast_recipients (
  id                   uuid primary key default gen_random_uuid(),
  blast_id             uuid not null references public.email_blasts(id) on delete cascade,
  student_id           uuid references public.profiles(id) on delete set null,
  -- Frozen copies: the roster row can change or be archived later.
  full_name            text,
  to_email             text,
  to_phone             text,
  channel              text not null default 'email' check (channel in ('email','sms')),
  status               text not null default 'queued'
                       check (status in ('queued','sent','skipped','failed')),
  skip_reason          text check (length(skip_reason) <= 200),
  message_delivery_id  uuid references public.message_deliveries(id) on delete set null,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists email_blast_recipients_blast_idx
  on public.email_blast_recipients (blast_id, status);
create index if not exists email_blast_recipients_student_idx
  on public.email_blast_recipients (student_id);

alter table public.email_blast_recipients enable row level security;

-- Readable through the blast that owns them; a student never reads this table.
drop policy if exists email_blast_recipients_owner on public.email_blast_recipients;
create policy email_blast_recipients_owner on public.email_blast_recipients
  for all to authenticated
  using (exists (
    select 1 from public.email_blasts b
    where b.id = email_blast_recipients.blast_id
      and b.counselor_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.email_blasts b
    where b.id = email_blast_recipients.blast_id
      and b.counselor_id = (select auth.uid())
  ));

-- Tie the outbound log back to the blast. Written by the backend as
-- service_role, so there is no new client write path.
alter table public.message_deliveries
  add column if not exists blast_id uuid references public.email_blasts(id) on delete set null;

create index if not exists message_deliveries_blast_idx
  on public.message_deliveries (blast_id);
