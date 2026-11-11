-- A saved link keeps the text of its page, so AxIS can answer from it (lib/linkText.ts).
--
-- Reading a link (POST /files/links) already fetches the page and extracts its readable text to write
-- the digest, then dropped the text: AxIS saw a saved link's title and address and nothing the page said.
--
--   page_text  the page's readable text as the reader extracted it (lib/links.ts fetchReadablePage),
--              at most 40,000 characters. Null: never read, read before this column, or kept out of AI.
--
-- Written only by the read, with the digest, and only onto a link still open to AI (the API's write is
-- conditional on available_to_llm). The keep-out trigger below clears it whenever a link is (or becomes)
-- kept out of AI, the same as the summary. AxIS reads it through GET /files/links/:id/text, which also
-- checks the practice's AI summaries and document reading switches, and wraps it as untrusted content.
-- GET /files/links never selects it.
--
-- Deploy order: either.
--   * Code first: the read retries its write without page_text, and GET /files/links/:id/text answers
--     "read it again" for every link, as for one read before the column existed.
--   * Migration first: the previous build never writes or reads the column (its GET /files/links selects
--     "*", which now carries the column, and serializes only the fields it knows).
-- Not in REQUIRED_SCHEMA.

alter table public.document_links
  add column if not exists page_text text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.document_links'::regclass and conname = 'document_links_page_text_len') then
    alter table public.document_links add constraint document_links_page_text_len
      check (page_text is null or char_length(page_text) <= 40000);
  end if;
end;
$$;

-- 20261024000054's trigger, now clearing the page text too.
create or replace function private.document_links_keep_out_clears_digest()
returns trigger
language plpgsql
security invoker
set search_path to 'private', 'public', 'pg_temp'
as $function$
begin
  if new.available_to_llm = false then
    new.summary := null;
    new.key_points := '{}';
    new.content_chars := null;
    new.extracted := '{}'::jsonb;
    new.page_text := null;
    if new.status in ('read', 'reading', 'queued') then
      new.status := 'skipped';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.document_links_keep_out_clears_digest() from public;
