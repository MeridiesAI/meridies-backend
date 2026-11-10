-- AxIS activity drafts (docs/superpowers/specs/2026-10-30-axis-activity-drafts-design.md;
-- docs/superpowers/plans/2026-11-06-axis-activity-drafts.md).
--
--   ai_conversations.draft_rows  the rows of the chat's open activity draft (up to 10): each activity's values,
--                                where each value came from, and its card. The draft's small header stays in
--                                `state` (lib/axis/drafts/state.ts).
--
-- Only the server writes draft_rows, through the service client keyed on the conversation's id and owner. A row's
-- sources decide whether its card is flagged as outside content (so Confirm all skips it), so the counselor's own
-- client may read the column but never write it. A column revoke doesn't override a table-level grant, so the
-- table-level INSERT and UPDATE grants go and come back per column on every other column, exactly the ones that
-- exist today. A later migration that adds a column a client writes must grant it here too.
--
-- Deploy order: this first; nothing reads the column until the code that uses it. Not in REQUIRED_SCHEMA: before
-- it, a draft lasts one turn and the reply says so.

alter table public.ai_conversations add column if not exists draft_rows jsonb;

alter table public.ai_conversations drop constraint if exists ai_conversations_draft_rows_check;
alter table public.ai_conversations add constraint ai_conversations_draft_rows_check check (
  draft_rows is null
  or case
       when jsonb_typeof(draft_rows) = 'array' then jsonb_array_length(draft_rows) <= 10 and octet_length(draft_rows::text) <= 32000
       else false
     end
);

revoke insert, update on public.ai_conversations from authenticated, anon;
grant insert (id, owner_id, student_id, module, title, created_at, updated_at, summary, summary_through, state)
  on public.ai_conversations to authenticated;
grant update (id, owner_id, student_id, module, title, created_at, updated_at, summary, summary_through, state)
  on public.ai_conversations to authenticated;
