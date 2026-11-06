-- Write to a family in the language they speak (Communication › Translate).
--
-- 1. student_alert_prefs.family_language: what a student's family speaks at
--    home, a language code from lib/languages.ts ("es", "zh", "vi"...) or "en"
--    for English only; null means nobody has said. It lives on the table that
--    already holds the composer's per-student choices (who it writes to, email
--    or text), which is counselor-written and student-readable, so it needs no
--    new policy or grant.
--
-- 2. student_messages.translated_to: the language a message was translated
--    into, set by the composer when it sends a translated (bilingual) body. It
--    tells delivery not to put an English "Dear X," or "Hi X, it's Y about Z:"
--    above a body that already greets the family in their own language, and it
--    is read again when a scheduled message goes out later.
--
-- 3. inbound_messages: the English of a reply written in another language
--    (body_en), the language it was detected as, and where the translation
--    stands. The webhooks write these with the service role, in the same
--    insert as the reply; a translation that failed is retried by the existing
--    dispatch cron (translation_state = 'failed', at most 3 attempts), which
--    is what the partial index is for. The counselor reads them through the
--    table's existing select policy and writes nothing new (the one client
--    write on inbound_messages stays `read_at`).
--
-- The language columns are checked by shape, not against a list, so a language
-- added to lib/languages.ts needs no migration. Free text can't get in: the
-- code only ever stores a code from its own list.
--
-- Deploy order: either. Every read and write degrades without it (saving a
-- language answers 503 `family_language_unavailable`, sending a translated
-- message 503 `translation_unavailable`, the replies list reads `select *` and
-- shows no English). Additive only; no existing row changes. Not in
-- REQUIRED_SCHEMA.

alter table public.student_alert_prefs
  add column if not exists family_language text
    check (family_language is null or family_language ~ '^[a-z]{2,3}(-[A-Za-z]{4})?$');

comment on column public.student_alert_prefs.family_language is
  'What this student''s family speaks at home: a language code, or ''en'' for English only; null when not set. Counselor-written, like the rest of this table.';

alter table public.student_messages
  add column if not exists translated_to text
    check (translated_to is null or translated_to ~ '^[a-z]{2,3}(-[A-Za-z]{4})?$');

comment on column public.student_messages.translated_to is
  'The language this message was translated into (its body holds the translation, then the English). Delivery skips the English greeting for it.';

alter table public.inbound_messages
  add column if not exists body_en              text
    check (body_en is null or length(body_en) <= 20000),
  add column if not exists detected_language    text
    check (detected_language is null or detected_language ~ '^[a-z]{2,3}(-[A-Za-z]{4})?$'),
  add column if not exists translation_state    text
    check (translation_state is null or translation_state in ('done', 'skipped', 'failed')),
  add column if not exists translation_attempts smallint not null default 0
    check (translation_attempts between 0 and 10);

comment on column public.inbound_messages.body_en is
  'The English of a reply written in another language, machine-translated when the webhook stored it. Null for English and for anything not translated.';
comment on column public.inbound_messages.translation_state is
  'null = never tried (before this migration), done = body_en and detected_language written, skipped = left alone on purpose (English, a keyword, AI off), failed = tried and the dispatch cron will try again.';

-- The dispatch cron's retry sweep reads only what failed and has attempts left.
create index if not exists inbound_messages_translation_retry_idx
  on public.inbound_messages (received_at)
  where translation_state = 'failed' and translation_attempts < 3;
