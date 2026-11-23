-- Email blast: send to students and their parents in one blast.
--
-- `email_blasts.recipient_type` was 'students' or 'parents'. A blast can now also
-- be 'both': the students and their parents' addresses, one email each, an
-- address shared by a student and a parent mailed once (lib/blasts.ts
-- resolveAudience). The only change is the CHECK; no column, no data moves.
--
-- Deploy order: THIS FILE FIRST. Until it is applied, saving a blast with
-- recipientType "both" fails on the old CHECK, before anything is sent (the row
-- is written ahead of delivery), and a blast to students or parents is
-- unchanged. The app must not offer "Both" before the API that accepts it.
-- Not in REQUIRED_SCHEMA.

alter table public.email_blasts drop constraint if exists email_blasts_recipient_type_check;
alter table public.email_blasts
  add constraint email_blasts_recipient_type_check check (recipient_type in ('students', 'parents', 'both'));
