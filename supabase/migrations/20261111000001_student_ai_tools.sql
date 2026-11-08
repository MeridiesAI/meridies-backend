-- "Let students use AI tools": a practice switch for the AI tools a practice's own students may run
-- (Build College Lists, Narrative Coherence, Activities Build, the scholarship Ask box).
--
-- Unlike the other Data & privacy switches this one is OFF until the practice turns it on. Student AI is billed
-- to the same company ceiling as the counselors' (a student has a lower daily limit of their own, lib/aiBudget.ts),
-- so a practice has to choose it. A practice with no row, and every existing row, reads off.
--
-- The column joins the per-column UPDATE grant (the table grants update by column, so a new column is not
-- writable until it is listed), and my_practice_ai_settings() returns it, so a student's API request can learn
-- the answer on the student's own token when the service client isn't there (a local stack).
--
-- No table is created, so there is no approval gate to attach.
--
-- Deploy order: either.
--   * Code first: lib/practiceSettings.ts retries its read without the column when it is missing
--     (readPracticeSettingsFor), every older switch answers as before, and the student tools read OFF.
--     The settings route only reads/writes the column when the request names it.
--   * Migration first: nothing reads the column yet; harmless. The previous build's select("*") ignores it.
-- Not in REQUIRED_SCHEMA: no request depends on it.

alter table public.practice_settings
  add column if not exists student_ai_tools boolean not null default false;

grant update (student_ai_tools) on public.practice_settings to authenticated;

create or replace function public.my_practice_ai_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'private', 'public', 'pg_temp'
as $function$
declare
  me uuid := auth.uid();
  v_counselor uuid;
  v_firm uuid;
  r record;
begin
  if me is null then
    return null;
  end if;
  select p.counselor_id into v_counselor
    from public.profiles p
   where p.id = me and p.role = 'student';
  if v_counselor is null or not private.is_counselor(v_counselor) then
    return null;
  end if;
  select c.firm_id into v_firm from public.profiles c where c.id = v_counselor;
  if v_firm is not null then
    select s.ai_summaries, s.auto_parse_documents, s.student_ai_tools into r
      from public.practice_settings s where s.firm_id = v_firm;
  else
    select s.ai_summaries, s.auto_parse_documents, s.student_ai_tools into r
      from public.practice_settings s where s.counselor_id = v_counselor;
  end if;
  return jsonb_build_object(
    'ai_summaries', coalesce(r.ai_summaries, true),
    'auto_parse_documents', coalesce(r.auto_parse_documents, true),
    'student_ai_tools', coalesce(r.student_ai_tools, false)
  );
end;
$function$;

revoke all on function public.my_practice_ai_settings() from public, anon;
grant execute on function public.my_practice_ai_settings() to authenticated;
