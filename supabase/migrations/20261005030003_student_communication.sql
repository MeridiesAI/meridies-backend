-- v10 sync, student-aid-comms (3 of 3): the Communication page's composer.
--
-- 1. Who the composer writes to, remembered per student (v6, kept through
--    v10): "Parent | <student>" and, in the student view, "Email | Text". It
--    lives on student_alert_prefs because it is the same kind of decision —
--    who a student's messages go to — and that table is already
--    counselor-written and student-readable, which is right for this too.
--
-- 2. student_messages: what the composer sent or scheduled. Counselor-only
--    in both directions, like parent_alerts: a student does not read the
--    messages their counselor sent their parents, and nobody edits what went
--    out. The recipients are frozen on the row when it is written, so a
--    scheduled message goes to the people the counselor saw in the To line
--    even if the family list changes before it leaves. Delivery is the API's
--    (lib/email.ts, every attempt in message_deliveries); this row records the
--    decision and the outcome.

-- ---------------------------------------------------------------------------
-- 1. Composer recipient preference
-- ---------------------------------------------------------------------------

alter table public.student_alert_prefs
  add column if not exists composer_audience text not null default 'parent'
    check (composer_audience in ('parent','student')),
  add column if not exists composer_channel  text not null default 'email'
    check (composer_channel in ('email','sms'));

comment on column public.student_alert_prefs.composer_audience is
  'Who the Communication composer writes to for this student. Counselor-written, like the rest of this table.';
comment on column public.student_alert_prefs.composer_channel is
  'Email or text when the composer writes to the student. The parent view is email only.';

-- ---------------------------------------------------------------------------
-- 2. Messages
-- ---------------------------------------------------------------------------

create table if not exists public.student_messages (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.profiles(id) on delete cascade,
  counselor_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  audience        text not null check (audience in ('parent','student')),
  channel         text not null check (channel in ('email','sms')),
  -- 'referral' and 'alert' are tracked elsewhere too (referrals, the
  -- accountability throttle); everything else is a message.
  kind            text not null default 'message' check (kind in ('message','referral','alert')),
  -- [{ kind: 'guardian'|'student', id, name, email, phone }], frozen at write.
  recipients      jsonb not null check (jsonb_typeof(recipients) = 'array'
                                        and jsonb_array_length(recipients) between 1 and 20),
  subject         text check (subject is null or length(subject) <= 300),
  body            text not null check (length(btrim(body)) between 1 and 20000),
  status          text not null default 'queued' check (status in
                    ('scheduled','queued','sent','failed','cancelled')),
  -- Why a message is waiting: the counselor's schedule, or quiet hours.
  hold_reason     text check (hold_reason is null or length(hold_reason) <= 300),
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  -- [{ recipient, channel, status, deliveryId, error }] — what delivery did.
  attempts        jsonb not null default '[]'::jsonb check (jsonb_typeof(attempts) = 'array'),
  ai_drafted      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint student_messages_email_has_subject check (channel <> 'email' or subject is not null),
  constraint student_messages_sms_is_short check (channel <> 'sms' or length(body) <= 1600),
  constraint student_messages_parent_is_email check (audience <> 'parent' or channel = 'email'),
  constraint student_messages_scheduled_has_time check (status <> 'scheduled' or scheduled_for is not null)
);

create index if not exists student_messages_student_idx
  on public.student_messages (student_id, created_at desc);
create index if not exists student_messages_due_idx
  on public.student_messages (scheduled_for) where status = 'scheduled';
create index if not exists student_messages_alert_idx
  on public.student_messages (student_id, sent_at desc) where kind = 'alert' and status = 'sent';

drop trigger if exists student_messages_set_updated_at on public.student_messages;
create trigger student_messages_set_updated_at before update on public.student_messages
  for each row execute function public.set_updated_at();

comment on table public.student_messages is
  'The Communication composer''s sent and scheduled messages. Counselor-only both ways; delivery attempts are in message_deliveries.';

alter table public.student_messages enable row level security;
revoke all on table public.student_messages from anon;
grant select, insert, update on table public.student_messages to authenticated;

drop policy if exists student_messages_select on public.student_messages;
create policy student_messages_select on public.student_messages
  for select to authenticated
  using (private.is_counselor_of(student_id, (select auth.uid())));

drop policy if exists student_messages_insert on public.student_messages;
create policy student_messages_insert on public.student_messages
  for insert to authenticated
  with check (
    counselor_id = (select auth.uid())
    and private.is_counselor_of(student_id, (select auth.uid()))
  );

-- A counselor may cancel or record the outcome of their own messages; what
-- was written to whom does not change after the fact (column grants below).
drop policy if exists student_messages_update on public.student_messages;
create policy student_messages_update on public.student_messages
  for update to authenticated
  using (counselor_id = (select auth.uid()) and private.is_counselor_of(student_id, (select auth.uid())))
  with check (counselor_id = (select auth.uid()) and private.is_counselor_of(student_id, (select auth.uid())));

revoke update on table public.student_messages from authenticated;
grant update (status, hold_reason, scheduled_for, sent_at, attempts, updated_at)
  on table public.student_messages to authenticated;
