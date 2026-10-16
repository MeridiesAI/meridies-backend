-- A link kept out of AI holds no AI digest (security review, "AI guardrails").
--
-- document_links.available_to_llm is a data-handling switch: a link marked
-- "keep out of AI" is never read into a model. Two ways left a digest on such a
-- link anyway: a read already running when the owner flipped the switch wrote
-- its summary when it finished, and flipping the switch on a link already read
-- kept the old summary. The API now writes a digest only onto a link still open
-- to AI and clears it when the switch goes off; this trigger says the same for
-- every write: whenever a row is (or becomes) kept out of AI, the summary, key
-- points, page size and extraction notes are cleared and a 'read' status
-- becomes 'skipped'. Relevance is left alone (the owner may set it by hand).
-- Links already kept out that still carry a digest are cleared once, below.
--
-- Deploy order: either.
--   * Code first: the API already clears the digest and never writes one onto
--     a kept-out link.
--   * Migration first: the previous build's late digest write on a kept-out
--     link is emptied by the trigger instead of stored; nothing it reads
--     changes shape (summary null and key_points '{}' are values it already
--     handles for an unread link).
-- Not in REQUIRED_SCHEMA: no request depends on it.

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
    if new.status in ('read', 'reading', 'queued') then
      new.status := 'skipped';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.document_links_keep_out_clears_digest() from public;

drop trigger if exists document_links_keep_out_clears_digest on public.document_links;
create trigger document_links_keep_out_clears_digest
  before insert or update on public.document_links
  for each row execute function private.document_links_keep_out_clears_digest();

-- Links already kept out of AI that still carry a digest: the trigger clears them.
update public.document_links
   set available_to_llm = available_to_llm
 where available_to_llm = false
   and (summary is not null or cardinality(key_points) > 0 or status in ('read', 'reading', 'queued'));
