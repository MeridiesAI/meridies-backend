-- The AI switches of a student's practice, for the student's own requests
-- (security review, "AI guardrails").
--
-- A student's link digest and the AI that reads their hand-ins follow their
-- practice's Data & privacy switches (lib/practiceSettings.ts
-- studentPracticeSettings). A student can't read practice_settings under RLS,
-- so the API reads it on the service client; without a service-role key (a
-- local stack, say) that read had no answer and every such AI feature was
-- refused to students. This function gives the API a second way to ask, on
-- the student's own token, about the student's own practice only.
--
-- What it returns: the two AI switches of the caller's counselor's practice
-- (the firm's row, else the solo counselor's), defaults when there is no row,
-- or null when the caller is not a student, has no counselor, or the
-- counselor is not approved (private.is_counselor). It takes no argument, so
-- it can't be pointed at anyone else's practice, and it returns two booleans,
-- never a row.
--
-- Deploy order: either.
--   * Code first: the API reads the service client first and calls this only
--     without one; a missing function (PGRST202 / 42883) is "no answer", and
--     the student's gated AI is refused as before (fail closed).
--   * Migration first: nothing calls it yet; harmless.
-- Not in REQUIRED_SCHEMA: no request depends on it.

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
    select s.ai_summaries, s.auto_parse_documents into r
      from public.practice_settings s where s.firm_id = v_firm;
  else
    select s.ai_summaries, s.auto_parse_documents into r
      from public.practice_settings s where s.counselor_id = v_counselor;
  end if;
  return jsonb_build_object(
    'ai_summaries', coalesce(r.ai_summaries, true),
    'auto_parse_documents', coalesce(r.auto_parse_documents, true)
  );
end;
$function$;

revoke all on function public.my_practice_ai_settings() from public, anon;
grant execute on function public.my_practice_ai_settings() to authenticated;
