-- A composer message reaches only the student and guardians on file.
--
-- student_messages (20261005030003) let a counselor insert rows straight
-- through PostgREST: the insert policy checked only that the student was on
-- their roster, never `recipients`. A row written with status 'scheduled'
-- and any addresses or phone numbers was then delivered by the dispatch cron
-- on the service client, from Meridies' Resend and Twilio accounts, outside
-- the route's recipient resolution and rate limits. The client UPDATE grant
-- also covered status and scheduled_for, so a sent row could be moved back
-- to 'scheduled' and sent again.
--
-- After this file:
--   - a client insert must name only recipients the route itself would
--     have resolved: for audience 'student', the student (id = student_id)
--     at their sign-in email or their phone on file (the contact email is
--     accepted too, only so the build before the sign-in-email rule keeps
--     working while this file applies; dispatch sends a student's email to
--     the sign-in email alone, lib/studentMessages.ts); for
--     'parent', guardians of this student with alerts on, at the email on
--     file. It starts 'queued' or 'scheduled', with nothing sent yet. The
--     check answers only for the caller's own student (is_counselor_of
--     first): for anyone else the insert falls through to RLS, so a foreign
--     insert always fails the same way and the check can't be used to test
--     guesses at another student's or a guardian's address.
--   - a counselor's client inserts are capped at 200 a day
--     (consume_rate_limit, key student-messages-insert:<counselor>). The
--     route already holds a counselor to 30 an hour and 100 family messages
--     a day before it inserts, so the cap never touches the composer; it
--     bounds what a counselor can queue straight through PostgREST, at
--     addresses they control (they manage their students' guardians). The
--     dispatch cron caps what it sends per counselor too (code, below).
--   - a client update moves status only scheduled -> cancelled or queued ->
--     sent | failed | cancelled (the route recording a send it just made),
--     and scheduled_for is no longer client-writable (only the dispatch
--     cron, on the service role, moves it).
-- The dispatch cron also re-checks every recipient against what is on file
-- when it sends (lib/studentMessages.ts), which holds with or without this
-- file.
--
-- Deploy order: either. The route inserts exactly the recipients
-- resolveRecipients built from the same tables, inside its own tighter
-- limits, and only moves status the ways allowed here; it never writes
-- scheduled_for after the insert. So the previous build works unchanged
-- once this is applied. Not in REQUIRED_SCHEMA. Follow-up for a later PR,
-- once a build that inserts on the service client has shipped: revoke
-- INSERT on student_messages from authenticated (revoking it here would
-- break the previous build's composer the moment this applies).

create or replace function private.student_message_recipients_ok(
  p_student uuid, p_audience text, p_channel text, p_recipients jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = private, public
as $$
declare
  v_r       jsonb;
  v_email   text;
  v_contact text;
  v_phone   text;
begin
  -- Only the student's own counselor learns anything here. Answering for any
  -- student would make the check an oracle on other people's addresses.
  if not private.is_counselor_of(p_student, (select auth.uid())) then
    return false;
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0 then
    return false;
  end if;

  if p_audience = 'student' then
    select nullif(btrim(p.email), ''), nullif(btrim(d.contact_email), ''),
           nullif(regexp_replace(coalesce(p.phone, ''), '[^0-9+]', '', 'g'), '')
      into v_email, v_contact, v_phone
      from public.profiles p
      left join public.student_personal_details d on d.student_id = p.id
     where p.id = p_student;
  end if;

  for v_r in select * from jsonb_array_elements(p_recipients) loop
    if jsonb_typeof(v_r) <> 'object' then
      return false;
    end if;
    if p_audience = 'student' then
      if v_r->>'kind' is distinct from 'student' or v_r->>'id' is distinct from p_student::text then
        return false;
      end if;
      if p_channel = 'email'
         and lower(btrim(coalesce(v_r->>'email', ''))) is distinct from lower(v_email)
         and lower(btrim(coalesce(v_r->>'email', ''))) is distinct from lower(v_contact) then
        return false;
      end if;
      if p_channel = 'sms'
         and (v_phone is null or regexp_replace(coalesce(v_r->>'phone', ''), '[^0-9+]', '', 'g') <> v_phone) then
        return false;
      end if;
    elsif p_audience = 'parent' then
      if v_r->>'kind' is distinct from 'guardian' then
        return false;
      end if;
      if not exists (
        select 1 from public.guardians g
         where g.id::text = v_r->>'id'
           and g.student_id = p_student
           and g.alerts_enabled
           and g.email is not null
           and lower(btrim(g.email)) = lower(btrim(coalesce(v_r->>'email', '')))
      ) then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- The guard below runs as the caller, so the caller needs EXECUTE; the
-- private schema is not exposed through PostgREST.
revoke all on function private.student_message_recipients_ok(uuid, text, text, jsonb) from public, anon;
grant execute on function private.student_message_recipients_ok(uuid, text, text, jsonb) to authenticated;

-- Charges one client insert to the caller's daily cap. SECURITY DEFINER
-- because consume_rate_limit is EXECUTE to service_role only; it charges
-- only the caller (auth.uid()), never an id it is handed.
create or replace function private.student_message_insert_allowed()
returns boolean
language plpgsql
volatile
security definer
set search_path = private, public
as $$
begin
  return public.consume_rate_limit('student-messages-insert:' || (select auth.uid())::text, 200, 86400);
end;
$$;

revoke all on function private.student_message_insert_allowed() from public, anon;
grant execute on function private.student_message_insert_allowed() to authenticated;

-- Deliberately NOT security definer: the guard keys off current_user, so the
-- service-role dispatch and SECURITY DEFINER functions (caseload transfer)
-- are not affected.
create or replace function private.student_messages_guard_client()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- Not this caller's student: leave the refusal to RLS, before anything
    -- about the student is read, so every foreign insert fails the same way.
    if not private.is_counselor_of(new.student_id, (select auth.uid())) then
      return new;
    end if;
    if new.status not in ('queued', 'scheduled') or new.sent_at is not null
       or new.attempts is distinct from '[]'::jsonb then
      raise exception 'A message starts unsent' using errcode = '42501';
    end if;
    if not private.student_message_recipients_ok(new.student_id, new.audience, new.channel, new.recipients) then
      raise exception 'A message goes only to the student or guardians on file' using errcode = '42501';
    end if;
    if not private.student_message_insert_allowed() then
      raise exception 'Too many messages today' using errcode = '54000';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status
     and not ((old.status = 'scheduled' and new.status = 'cancelled')
              or (old.status = 'queued' and new.status in ('sent', 'failed', 'cancelled'))) then
    raise exception 'That message can''t move to %', new.status using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.student_messages_guard_client() from public, anon, authenticated;

drop trigger if exists student_messages_guard_client on public.student_messages;
create trigger student_messages_guard_client
  before insert or update on public.student_messages
  for each row execute function private.student_messages_guard_client();

-- scheduled_for leaves the client grant (granted per column in
-- 20261005030003, so a column revoke takes it away).
revoke update (scheduled_for) on table public.student_messages from authenticated;
