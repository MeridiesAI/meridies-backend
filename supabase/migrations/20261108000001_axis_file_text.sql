-- AxIS reads a chat file once (AxIS security PR A1; spec
-- docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md, 1.6 and the Plan review of 11/2).
-- After the turn a file arrives in, the server stores its text on the ai_attachments row, and later turns
-- send that text instead of the file.
--
--   extracted_text  the file's text: a PDF's text, a text file as it is, or a word-for-word transcription
--                   of an image or a scanned PDF. At most 200,000 characters.
--   extract_kind    text | transcript | failed. Null: not read yet.
--   extract_cut     true when the stored text stops short of the file.
--   extracted_at    when the server claimed the file for reading (a claim older than 10 minutes is free again).
--
-- Server-only. The stored text is what the model later reads as the file, so the counselor's own token must
-- not write it: the table-level INSERT and UPDATE grants are revoked and given back per column on exactly
-- what the API writes with that token (lib/axis/attachments.ts: the upload's insert, and message_id when
-- the message is sent). Only the API's service client writes the new columns, and only to rows the
-- counselor's own read returned. The previous build writes only those columns, so the revoke is safe for it.
--
-- Deploy order: either. Without this file nothing is stored and every turn sends the files as today (a
-- missing column reads as "not read yet"). Not in REQUIRED_SCHEMA.

alter table public.ai_attachments
  add column if not exists extracted_text text,
  add column if not exists extract_kind   text,
  add column if not exists extract_cut    boolean not null default false,
  add column if not exists extracted_at   timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ai_attachments'::regclass and conname = 'ai_attachments_extracted_text_len') then
    alter table public.ai_attachments add constraint ai_attachments_extracted_text_len
      check (extracted_text is null or char_length(extracted_text) <= 200000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.ai_attachments'::regclass and conname = 'ai_attachments_extract_kind') then
    alter table public.ai_attachments add constraint ai_attachments_extract_kind
      check (extract_kind is null or extract_kind in ('text', 'transcript', 'failed'));
  end if;
end;
$$;

-- A column revoke doesn't override a table-level grant, so the table-level grants go and come back per column.
revoke insert, update on public.ai_attachments from authenticated, anon;
grant insert (conversation_id, owner_id, storage_path, file_name, mime_type, size_bytes) on public.ai_attachments to authenticated;
grant update (message_id) on public.ai_attachments to authenticated;

-- ai_runs module label for the transcription call, added the additive way (see 20261018000001).
do $$
declare
  v_def    text;
  v_values text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.ai_runs'::regclass and c.conname = 'ai_runs_module_check';

  select coalesce(array_agg(distinct btrim(v)), '{}') into v_values
  from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m,
       lateral unnest(
         case when left(m[1], 1) = '{' then string_to_array(btrim(m[1], '{}'), ',') else array[m[1]] end
       ) as v;

  if array['axis-attachment'] <@ v_values then
    return;
  end if;
  v_values := array(select distinct unnest(v_values || array['axis-attachment']));

  alter table public.ai_runs drop constraint if exists ai_runs_module_check;
  execute format(
    'alter table public.ai_runs add constraint ai_runs_module_check check (module = any (%L::text[]))',
    v_values
  );
end;
$$;
