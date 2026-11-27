-- An AxIS conversation summary folded from outside content is flagged (P1-7, Elvin 2026-11-26).
--
--   ai_messages.read_outside         on an AxIS answer: whether its turn read outside content (a file, an email, a
--                                    connected document, student-written free text; the dialogue state's `outside`).
--                                    Null on rows written before this file and on the counselor's own messages.
--   ai_conversations.summary_outside the running memory summary was folded from at least one such answer (or one that
--                                    quoted free text, or one never checked for quotes). The fold strips 8+ word
--                                    quotes but a paraphrase still gets in, so while this summary is in use every
--                                    instant change AxIS would make waits for the counselor's Confirm
--                                    (reason outside-content). Sticky: each fold merges the old summary in.
--
-- Deploy order: either. Before this file the API names neither column (taintReady in lib/axis/failsafe.ts) and the
-- summary is trusted as before; the gap is logged. Not in REQUIRED_SCHEMA. Both columns take their table's grants:
-- the counselor's own client writes their own chat, as with outside_quotes (20261108000004).

alter table public.ai_messages add column if not exists read_outside boolean;
alter table public.ai_conversations add column if not exists summary_outside boolean not null default false;
