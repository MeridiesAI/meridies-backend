-- AxIS chats are the counselor's (security review, "AI guardrails").
--
-- /chat let a signed-in student open a conversation with no student in scope,
-- attach a draft and stream a DEEP_MODEL answer guarded only by its prompt: a
-- free-form essay ghostwriter on the student's own quota. The app gives
-- students no AxIS (their AI is Profile Update, /profile-updates), so the API
-- now refuses every /chat route to a non-counselor except deleting their own
-- chat, and this file says the same in the database: only an approved
-- counselor creates a conversation, a message or a chat attachment, and only
-- a counselor uploads into the axis-attachments bucket.
--
-- Restrictive INSERT policies only. Reads, renames and deletes keep their
-- owner policies, so a student who created a chat before this keeps reading
-- and deleting their own rows (and their export and account deletion are
-- unchanged); they just can't add to them.
--
-- Deploy order: either.
--   * Code first: routes/chat.ts already answers 403 to a student, so nothing
--     reaches these tables from the API; PostgREST inserts stay possible
--     until this is applied, which runs no model and so writes no essay.
--   * Migration first: the previous build's /chat insert for a student fails
--     (42501 -> a 4xx from fromPostgrest), which is the intended refusal; a
--     counselor's chat is untouched.
-- Not in REQUIRED_SCHEMA: no request depends on it.

drop policy if exists ai_conversations_insert_counselor on public.ai_conversations;
create policy ai_conversations_insert_counselor on public.ai_conversations
  as restrictive
  for insert to authenticated
  with check (private.is_counselor((select auth.uid())));

drop policy if exists ai_messages_insert_counselor on public.ai_messages;
create policy ai_messages_insert_counselor on public.ai_messages
  as restrictive
  for insert to authenticated
  with check (private.is_counselor((select auth.uid())));

do $$
begin
  if to_regclass('public.ai_attachments') is not null then
    execute 'drop policy if exists ai_attachments_insert_counselor on public.ai_attachments';
    execute $p$
      create policy ai_attachments_insert_counselor on public.ai_attachments
        as restrictive
        for insert to authenticated
        with check (private.is_counselor((select auth.uid())))
    $p$;
  end if;
end
$$;

-- The bucket's own insert policy scopes uploads to <owner id>/<chat id>/; this
-- adds who may upload at all. Other buckets are untouched.
drop policy if exists axis_attachments_insert_counselor on storage.objects;
create policy axis_attachments_insert_counselor on storage.objects
  as restrictive
  for insert to authenticated
  with check (bucket_id <> 'axis-attachments' or private.is_counselor((select auth.uid())));
