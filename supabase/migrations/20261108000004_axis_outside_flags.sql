-- Outside text stays out of an AxIS chat's memory (AxIS security PR B; spec
-- docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md section 3).
--
--   ai_messages.outside_quotes  on an AxIS answer: the runs of 8+ words it repeated from free text the turn could
--                               see ([{ start, end, source }], offsets into content), or null. While such an answer
--                               is among the messages a turn replays, the chat stays flagged (changes wait for
--                               Confirm), and the memory fold replaces each run with "[quote from <source>]" before
--                               it summarises.
--
-- The free-text rule (lib/context/freeText.ts: short structured fields don't flag a turn), the question turn's
-- short record and this flag turn on together, when the API sees this column (flagsReady in lib/axis/failsafe.ts).
-- Deploy order: either. Before it, today's wider rule holds unchanged. Not in REQUIRED_SCHEMA. The column takes
-- the table's grants: the counselor's own client writes their own chat's answers, as today.

alter table public.ai_messages add column if not exists outside_quotes jsonb;
alter table public.ai_messages drop constraint if exists ai_messages_outside_quotes_check;
alter table public.ai_messages add constraint ai_messages_outside_quotes_check
  check (outside_quotes is null or (jsonb_typeof(outside_quotes) = 'array' and octet_length(outside_quotes::text) <= 8000));
