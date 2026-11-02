-- Parent communication, step 1: a parent can be texted from the Communication
-- composer.
--
-- Until now the composer wrote to parents by email only, and the database said
-- so twice:
--   * student_messages_parent_is_email (audience <> 'parent' or channel = 'email')
--   * private.student_message_recipients_ok (20261024000024) accepted a
--     guardian only by a matching email.
-- A parent's phone is already on the student page (guardians.phone), so this
-- lets a message with audience 'parent' use channel 'sms' too, and teaches the
-- recipient check to verify a guardian by phone when the channel is sms.
--
-- The check keeps its shape: the caller must be the student's counselor, every
-- recipient must be a guardian of THIS student with alerts on, and the contact
-- detail the row names must be the one on file. For email that is unchanged
-- (byte for byte). For sms the phone is compared the way the API and dispatch
-- read it: formatting stripped, "n/a" is no phone at all.
--
-- Deploy order: either. The serving build refuses parent texts in its route
-- before it reaches the table, so relaxing the constraint changes nothing for
-- it; the new build needs this file for a parent text insert to pass the
-- client guard (without it the insert is refused by RLS and the route answers
-- with the usual error). Not in REQUIRED_SCHEMA. No new table, so no approval
-- gate to attach.

alter table public.student_messages
  drop constraint if exists student_messages_parent_is_email;

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
      if p_channel = 'sms' then
        if not exists (
          select 1 from public.guardians g
           where g.id::text = v_r->>'id'
             and g.student_id = p_student
             and g.alerts_enabled
             and nullif(regexp_replace(coalesce(g.phone, ''), '[^0-9+]', '', 'g'), '') is not null
             and regexp_replace(coalesce(g.phone, ''), '[^0-9+]', '', 'g')
                 = regexp_replace(coalesce(v_r->>'phone', ''), '[^0-9+]', '', 'g')
        ) then
          return false;
        end if;
      elsif not exists (
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

revoke all on function private.student_message_recipients_ok(uuid, text, text, jsonb) from public, anon;
grant execute on function private.student_message_recipients_ok(uuid, text, text, jsonb) to authenticated;
