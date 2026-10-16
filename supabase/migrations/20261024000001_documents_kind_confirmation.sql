-- documents_kind_confirmation: a document's type can be unconfirmed (Drive picks) with the server's guess, and a confirmation can ask for its text. Additive; no rows change.
--
-- kind_confirmed: false only for a Google import that named no kind (lib/documentGuess.ts guessed one).
--   Every existing row counts as confirmed (default true), so nothing that works today changes.
-- kind_guess: { kind, basis, matched, textFound, keepOut }; never document text.
-- extraction_requested_at: set by a confirmation; the in-process queue (lib/documentExtraction.ts)
--   reads text from the stored copy and clears it. Old rows stay null: there is no backfill.
-- extraction_attempts / extraction_lease_until: a claim holds a 2-minute lease; recovery returns an
--   expired lease to the queue and gives up after 3 attempts (parse_status 'failed').

alter table public.documents
  add column if not exists kind_confirmed boolean not null default true,
  add column if not exists kind_guess jsonb,
  add column if not exists extraction_requested_at timestamptz,
  add column if not exists extraction_attempts smallint not null default 0,
  add column if not exists extraction_lease_until timestamptz;

alter table public.documents drop constraint if exists documents_extraction_attempts_range;
alter table public.documents add constraint documents_extraction_attempts_range
  check (extraction_attempts between 0 and 10);

alter table public.documents drop constraint if exists documents_kind_guess_object;
alter table public.documents add constraint documents_kind_guess_object
  check (kind_guess is null or jsonb_typeof(kind_guess) = 'object');

create index if not exists documents_unconfirmed_idx
  on public.documents (student_id) where kind_confirmed = false;
create index if not exists documents_extraction_requested_idx
  on public.documents (extraction_requested_at) where extraction_requested_at is not null;

-- The student guard (20261016000001) gains the five columns: they are the counselor side's.
create or replace function private.documents_guard_student_restricted()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return new;
  end if;
  if coalesce(private.user_role(v_uid), '') <> 'student' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.ai_access is distinct from 'default' or new.ferpa_waived is distinct from false then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
    if new.kind_confirmed is distinct from true or new.kind_guess is not null or new.extraction_requested_at is not null
       or new.extraction_attempts is distinct from 0 or new.extraction_lease_until is not null then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
  else
    if new.ai_access is distinct from old.ai_access or new.ferpa_waived is distinct from old.ferpa_waived then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
    if new.kind_confirmed is distinct from old.kind_confirmed
       or new.kind_guess is distinct from old.kind_guess
       or new.extraction_requested_at is distinct from old.extraction_requested_at
       or new.extraction_attempts is distinct from old.extraction_attempts
       or new.extraction_lease_until is distinct from old.extraction_lease_until then
      raise exception 'Only your counselor can change those settings' using errcode = '42501';
    end if;
  end if;

  if new.kind in ('recommendation-letter', 'iep-504', 'counselor-only')
     and new.owner_id is distinct from v_uid
     and (tg_op = 'INSERT' or new.kind is distinct from old.kind) then
    raise exception 'Only your counselor can file a document under that kind' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.documents_guard_student_restricted() from public, anon, authenticated;
