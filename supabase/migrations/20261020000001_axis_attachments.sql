-- Files a counselor attaches to an AxIS chat (a PDF, a screenshot, a text
-- file). They are kept with the chat, so AxIS reads them again on every later
-- turn and a reopened chat shows them under the message they came with.
--
--  ai_attachments     one row per file; message_id is set when the message
--                     it was attached to is sent (null while it waits).
--  axis-attachments   the private bucket; objects live under "<owner_id>/".
--
-- Owner-only: a chat is its counselor's, and so are its files. The API mints
-- signed upload URLs on the counselor's own token, so these policies decide it.
-- Additive: the API answers 503 on its upload route until this is applied, and
-- sends messages without files as before.

create table if not exists public.ai_attachments (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.ai_conversations(id) on delete cascade,
  message_id       uuid references public.ai_messages(id) on delete set null,
  owner_id         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  storage_path     text not null unique,
  file_name        text not null check (char_length(file_name) between 1 and 255),
  mime_type        text not null check (mime_type in (
                     'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif',
                     'text/plain', 'text/markdown', 'text/csv')),
  size_bytes       integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at       timestamptz not null default now(),
  check (storage_path like owner_id::text || '/%')
);

create index if not exists ai_attachments_conversation_idx on public.ai_attachments (conversation_id, created_at);
create index if not exists ai_attachments_message_idx on public.ai_attachments (message_id);

alter table public.ai_attachments enable row level security;

drop policy if exists ai_attachments_owner on public.ai_attachments;
create policy ai_attachments_owner on public.ai_attachments
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.owner_id = (select auth.uid())
    )
  );

grant select, insert, update, delete on public.ai_attachments to authenticated;

-- A pending or revoked counselor reads and writes nothing here (20261017000001).
select private.attach_approval_gate('public.ai_attachments');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('axis-attachments', 'axis-attachments', false, 10485760,
        array['application/pdf','image/png','image/jpeg','image/webp','image/gif','text/plain','text/markdown','text/csv'])
on conflict (id) do nothing;

drop policy if exists axis_attachments_select_self on storage.objects;
create policy axis_attachments_select_self on storage.objects
  for select to authenticated
  using (bucket_id = 'axis-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists axis_attachments_insert_self on storage.objects;
create policy axis_attachments_insert_self on storage.objects
  for insert to authenticated
  with check (bucket_id = 'axis-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists axis_attachments_delete_self on storage.objects;
create policy axis_attachments_delete_self on storage.objects
  for delete to authenticated
  using (bucket_id = 'axis-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
