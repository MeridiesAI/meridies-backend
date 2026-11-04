-- Hand-in values stay unverified until a counselor confirms them (AxIS security PR B; spec
-- docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md section 4 and the Plan review of 11/2).
--
--   deliverable_tracker_checks.extracted_values  the values AxIS copied off a handed-in file (GPA, class rank, a test
--                             score), each { key, label, printed, confirmedAt, confirmedBy, confirmedByName }.
--                             Only the server writes it (the review and the Confirm, on the service client): the
--                             column has no client grant, so the table's insert and update grants become per column.
--   deliverable_tracker_latest  gains the column (last, so the view is replaced in place)
--   public.apply_hand_in_values(student, fields)  Confirm's profile write: each field only where the profile still
--                             holds what the card showed; RLS applies (SECURITY INVOKER)
--
-- Deploy order: either. Before it the values stay in the findings text, labelled "(unverified, from the student's
-- file)", and there is no Confirm (the route answers 503 naming this file). Not in REQUIRED_SCHEMA.
-- A column added to deliverable_tracker_checks after this needs its own insert/update grant to authenticated.

alter table public.deliverable_tracker_checks add column if not exists extracted_values jsonb;
alter table public.deliverable_tracker_checks drop constraint if exists deliverable_tracker_checks_extracted_values_check;
alter table public.deliverable_tracker_checks add constraint deliverable_tracker_checks_extracted_values_check
  check (extracted_values is null or (jsonb_typeof(extracted_values) = 'array' and octet_length(extracted_values::text) <= 4000));

-- Clients keep writing every other column (a counselor's own check, through the routes); not this one.
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
  from pg_attribute a
  where a.attrelid = 'public.deliverable_tracker_checks'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname <> 'extracted_values';
  execute 'revoke insert, update on public.deliverable_tracker_checks from authenticated, anon';
  execute format('grant insert (%s), update (%s) on public.deliverable_tracker_checks to authenticated', v_cols, v_cols);
end;
$$;

create or replace view public.deliverable_tracker_latest
with (security_invoker = true) as
select distinct on (c.deliverable_id)
  c.deliverable_id,
  c.student_id,
  c.id as check_id,
  c.verdict,
  c.note,
  c.alignment_score,
  c.days_since_activity,
  c.source,
  c.checked_at,
  c.findings,
  c.document_id,
  c.extracted_values
from public.deliverable_tracker_checks c
order by c.deliverable_id, c.checked_at desc;
grant select on public.deliverable_tracker_latest to authenticated;

-- p_fields: [{ column, value, expected }], at most five, each column once. A field is written only when the
-- profile's value equals `expected` (compared as jsonb: 4 and 4.00 match, null matches null); otherwise it is kept
-- and reported. The student's academics row is created if missing and locked, so an edit that lands between the
-- card and the click is never overwritten.
create or replace function public.apply_hand_in_values(p_student uuid, p_fields jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  f      jsonb;
  v_col  text;
  v_row  jsonb;
  v_seen text[] := '{}';
  v_saved text[] := '{}';
  v_kept jsonb := '[]'::jsonb;
begin
  if p_student is null or p_fields is null or jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 5 then
    raise exception 'apply_hand_in_values: fields must be a list of at most five' using errcode = '22023';
  end if;
  insert into public.student_academics (student_id) values (p_student) on conflict (student_id) do nothing;
  select to_jsonb(a) into v_row from public.student_academics a where a.student_id = p_student for update;
  if v_row is null then
    raise exception 'apply_hand_in_values: no access to that student' using errcode = '42501';
  end if;
  for f in select * from jsonb_array_elements(p_fields) loop
    v_col := f ->> 'column';
    if v_col is null or v_col not in ('gpa_weighted', 'gpa_unweighted', 'class_rank', 'sat_superscore', 'act_composite') or v_col = any (v_seen) then
      raise exception 'apply_hand_in_values: % is not a hand-in value, or is named twice', coalesce(v_col, 'null') using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_col);
    if coalesce(v_row -> v_col, 'null'::jsonb) = coalesce(f -> 'expected', 'null'::jsonb) then
      execute format(
        'update public.student_academics a set %1$I = (jsonb_populate_record(null::public.student_academics, $1)).%1$I where a.student_id = $2',
        v_col
      ) using jsonb_build_object(v_col, f -> 'value'), p_student;
      v_saved := array_append(v_saved, v_col);
    else
      v_kept := v_kept || jsonb_build_array(jsonb_build_object('column', v_col, 'current', coalesce(v_row -> v_col, 'null'::jsonb)));
    end if;
  end loop;
  return jsonb_build_object('saved', to_jsonb(v_saved), 'kept', v_kept);
end;
$$;
revoke all on function public.apply_hand_in_values(uuid, jsonb) from public, anon;
grant execute on function public.apply_hand_in_values(uuid, jsonb) to authenticated;
