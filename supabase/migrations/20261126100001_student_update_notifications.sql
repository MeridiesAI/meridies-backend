-- Tell a counselor when their student changes their own profile.
--
-- What counts (product spec, 11/15), only when the STUDENT themself made the change: auth.uid() is the student. A
-- counselor (and AxIS working for one: it runs as the counselor), a parent, the service role (imports, caseload
-- transfer, the server's own Reach/Target/Safety tag on a school just added) and writes made by another trigger
-- (pg_trigger_depth() > 1: a cascade, a counselor's staged files filed when the student accepts an invitation) do not.
--
--   group_key    the change
--   activities   adds or removes an activity or an award (awards count as activities)
--   colleges     adds or removes a college on their list (student_colleges)
--   college-fit  moves a college between Reach / Target / Safety. Today the database refuses a student's change of
--                `fit` (private.student_colleges_counselor_columns: fit is the counselor's call), so this one stays
--                silent until students may make that change; nothing else needs to change then.
--   files        uploads a file (a `documents` row the student uploaded or brought in from Drive, uploaded_by = them)
--
-- Who hears: the student's counselor (profiles.counselor_id), only while approved (private.is_counselor), as every
-- other notice a student's own action makes (college-result, essay, intake).
--
-- Grouping: one notification per (counselor, student, change type) while it is open, that is neither pushed nor
-- read. A further change of that type updates the open row instead of adding one: its title and body summarise every
-- change in the group ("Maya added 3 colleges: Duke, NYU, Cornell", "Maya added 2 activities and removed 1"), and its
-- created_at moves to the latest change so the bell shows it as new. The unique partial index makes two quick changes
-- land on one row. push_after is 20 minutes after the latest change: the push dispatcher (src/lib/push.ts) leaves the
-- row alone until then and counts staleness from then, so a phone buzzes once, 20 quiet minutes after the student's
-- last change of that type. Once the push has gone out (pushed_at) or the counselor has read the row (read_at), the
-- group is closed and the next change opens a new one. The bell row itself appears and updates at once.
--
-- Never in the way of the student's save: insert/delete use statement-level triggers (one notice write per statement,
-- however many rows it touched), and every error is swallowed with a warning. Names are listed in the order the
-- statement wrote its rows (a transition table is read back in that order), statement after statement.
--
-- Privacy: the names (colleges, activities, file titles) are only in the bell row's title, body and group_detail,
-- which only the recipient reads (notifications_select_own). A push never carries them: the dispatcher sends a
-- generic line by kind.
--
-- Deploy order: this file FIRST. The dispatcher reads notifications.push_after, which is in REQUIRED_SCHEMA, so a
-- build merged before this file is applied fails /health and never goes live. The previous build is safe with this
-- file applied: it does not read push_after, so it pushes a group as soon as it sees it (with the generic "You have a
-- new notification.") and the next change opens a new group; nothing breaks.

-- ---------------------------------------------------------------------------
-- 1. The new kind and the group columns
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in
  ('deadline','red-flag','report','invite','ai','policy',
   'scholarship','aid','opportunity','system','college-result','student-update'));

alter table public.notifications
  add column if not exists group_key text,
  add column if not exists group_detail jsonb,
  add column if not exists push_after timestamptz;

alter table public.notifications drop constraint if exists notifications_group_key_check;
alter table public.notifications add constraint notifications_group_key_check
  check (group_key is null or group_key in ('activities', 'colleges', 'college-fit', 'files'));

comment on column public.notifications.group_key is
  'student-update only: which change the row groups (activities, colleges, college-fit, files).';
comment on column public.notifications.group_detail is
  'student-update only: {added, removed, addedNames, removedNames} for the whole group (at most 10 names each).';
comment on column public.notifications.push_after is
  'No push before this time; staleness counts from it. Null: push when the dispatcher sees the row.';

-- At most one open group per (counselor, student, change type).
create unique index if not exists notifications_open_group_idx
  on public.notifications (recipient_id, student_id, group_key)
  where group_key is not null and pushed_at is null and read_at is null;

-- ---------------------------------------------------------------------------
-- 2. The words (pure helpers)
-- ---------------------------------------------------------------------------

-- A name as it goes into a notice: one line, at most 80 characters, or null.
create or replace function private.student_update_label(p_text text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select nullif(left(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), 80), '');
$function$;

-- The first name, as lib/inactivity.ts firstNameOf: the first word, at most 40 characters, else "Your student".
create or replace function private.student_update_first_name(p_full_name text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select coalesce(
    nullif(left(split_part(btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g')), ' ', 1), 40), ''),
    'Your student');
$function$;

-- The first 10 entries of a JSON array of names: the group keeps counts in full, names only up to here.
create or replace function private.student_update_names(p_names jsonb)
returns jsonb
language sql
immutable
set search_path to ''
as $function$
  select coalesce(jsonb_agg(t.e order by t.i), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_names) = 'array' then p_names else '[]'::jsonb end)
    with ordinality as t(e, i)
  where t.i <= 10;
$function$;

-- One group's detail plus another's.
create or replace function private.student_update_merge(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
set search_path to ''
as $function$
  select jsonb_build_object(
    'added', coalesce((p_old ->> 'added')::int, 0) + coalesce((p_new ->> 'added')::int, 0),
    'removed', coalesce((p_old ->> 'removed')::int, 0) + coalesce((p_new ->> 'removed')::int, 0),
    'addedNames', private.student_update_names(
      coalesce(p_old -> 'addedNames', '[]'::jsonb) || coalesce(p_new -> 'addedNames', '[]'::jsonb)),
    'removedNames', private.student_update_names(
      coalesce(p_old -> 'removedNames', '[]'::jsonb) || coalesce(p_new -> 'removedNames', '[]'::jsonb)));
$function$;

-- "Duke, NYU, Cornell", or "Duke, NYU, Cornell and 4 more" when the group counted more than it names here.
create or replace function private.student_update_list(p_names jsonb, p_total int, p_max int)
returns text
language sql
immutable
set search_path to ''
as $function$
  with shown as (
    select t.e, t.i
    from jsonb_array_elements_text(case when jsonb_typeof(p_names) = 'array' then p_names else '[]'::jsonb end)
      with ordinality as t(e, i)
    where t.i <= p_max
  )
  select string_agg(e, ', ' order by i)
         || case when p_total > (select count(*) from shown)
                 then ' and ' || (p_total - (select count(*) from shown)) || ' more'
                 else '' end
  from shown;
$function$;

-- "3 colleges", "1 activity".
create or replace function private.student_update_count(p_n int, p_group text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select p_n || ' ' || case
    when p_group = 'activities' then case when p_n = 1 then 'activity' else 'activities' end
    when p_group = 'files' then case when p_n = 1 then 'file' else 'files' end
    else case when p_n = 1 then 'college' else 'colleges' end
  end;
$function$;

-- The bell title: "Maya added 3 colleges: Duke, NYU, Cornell", "Maya added 2 activities and removed 1",
-- "Maya uploaded 2 files: Transcript.pdf, Resume", "Maya moved 1 college: Duke to Reach".
create or replace function private.student_update_title(p_first text, p_group text, p_detail jsonb)
returns text
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_added int := coalesce((p_detail ->> 'added')::int, 0);
  v_removed int := coalesce((p_detail ->> 'removed')::int, 0);
  v_verb text := case p_group when 'files' then 'uploaded' when 'college-fit' then 'moved' else 'added' end;
  v_names text;
begin
  if v_added > 0 and v_removed > 0 then
    return left(p_first || ' ' || v_verb || ' ' || private.student_update_count(v_added, p_group)
      || ' and removed ' || v_removed, 300);
  elsif v_removed > 0 then
    v_names := private.student_update_list(p_detail -> 'removedNames', v_removed, 3);
    return left(p_first || ' removed ' || private.student_update_count(v_removed, p_group)
      || coalesce(': ' || v_names, ''), 300);
  else
    v_names := private.student_update_list(p_detail -> 'addedNames', v_added, 3);
    return left(p_first || ' ' || v_verb || ' ' || private.student_update_count(v_added, p_group)
      || coalesce(': ' || v_names, ''), 300);
  end if;
end;
$function$;

-- The bell body: the names the title had no room for (up to 10 a side), else null.
create or replace function private.student_update_body(p_group text, p_detail jsonb)
returns text
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_added int := coalesce((p_detail ->> 'added')::int, 0);
  v_removed int := coalesce((p_detail ->> 'removed')::int, 0);
  v_verb text := case p_group when 'files' then 'Uploaded' when 'college-fit' then 'Moved' else 'Added' end;
  v_add_list text := private.student_update_list(p_detail -> 'addedNames', v_added, 10);
  v_rm_list text := private.student_update_list(p_detail -> 'removedNames', v_removed, 10);
begin
  if v_added > 0 and v_removed > 0 then
    return left(concat_ws(' ',
      v_verb || ': ' || v_add_list || '.',
      'Removed: ' || v_rm_list || '.'), 2000);
  elsif v_added > 3 then
    return left(v_verb || ': ' || v_add_list || '.', 2000);
  elsif v_removed > 3 then
    return left('Removed: ' || v_rm_list || '.', 2000);
  end if;
  return null;
end;
$function$;

-- Where the bell row opens: the section the change is in.
create or replace function private.student_update_href(p_student uuid, p_group text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select '/dashboard/counselor/students/' || p_student || case p_group
    when 'colleges' then '/college-list'
    when 'college-fit' then '/college-list'
    when 'activities' then '/application'
    else '' end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Record a change: open a group or add to the open one
-- ---------------------------------------------------------------------------

create or replace function private.note_student_update(
  p_student uuid,
  p_group text,
  p_added text[],
  p_removed text[]
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_added text[] := coalesce(p_added, '{}'::text[]);
  v_removed text[] := coalesce(p_removed, '{}'::text[]);
  v_counselor uuid;
  v_full_name text;
  v_first text;
  v_detail jsonb;
begin
  if cardinality(v_added) = 0 and cardinality(v_removed) = 0 then return; end if;

  select p.counselor_id, p.full_name into v_counselor, v_full_name
    from public.profiles p
   where p.id = p_student and p.role = 'student';
  if v_counselor is null or not private.is_counselor(v_counselor) then return; end if;

  v_first := private.student_update_first_name(v_full_name);
  v_detail := jsonb_build_object(
    'added', cardinality(v_added),
    'removed', cardinality(v_removed),
    'addedNames', private.student_update_names(to_jsonb(v_added)),
    'removedNames', private.student_update_names(to_jsonb(v_removed)));

  insert into public.notifications as n
    (recipient_id, student_id, kind, urgency, title, body, href, action_items, created_by,
     group_key, group_detail, push_after, created_at)
  values
    (v_counselor, p_student, 'student-update', 'low',
     private.student_update_title(v_first, p_group, v_detail),
     private.student_update_body(p_group, v_detail),
     private.student_update_href(p_student, p_group),
     '{}'::text[], p_student,
     p_group, v_detail, now() + interval '20 minutes', now())
  on conflict (recipient_id, student_id, group_key)
    where group_key is not null and pushed_at is null and read_at is null
  do update set
    group_detail = private.student_update_merge(n.group_detail, excluded.group_detail),
    title = private.student_update_title(v_first, n.group_key,
      private.student_update_merge(n.group_detail, excluded.group_detail)),
    body = private.student_update_body(n.group_key,
      private.student_update_merge(n.group_detail, excluded.group_detail)),
    push_after = excluded.push_after,
    created_at = excluded.created_at;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The triggers
-- ---------------------------------------------------------------------------

-- activities and awards, after insert / after delete, once per statement.
create or replace function private.student_update_activities()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_names text[];
begin
  if v_uid is null or pg_trigger_depth() > 1 then return null; end if;
  begin
    if tg_op = 'INSERT' then
      select array_agg(coalesce(
               private.student_update_label(to_jsonb(r) ->> 'name'),
               private.student_update_label(to_jsonb(r) ->> 'organization'),
               private.student_update_label(to_jsonb(r) ->> 'position'),
               case when tg_table_name = 'awards' then 'An award' else 'An activity' end))
        into v_names
        from new_rows r
       where r.student_id = v_uid;
      perform private.note_student_update(v_uid, 'activities', v_names, null);
    elsif tg_op = 'DELETE' then
      select array_agg(coalesce(
               private.student_update_label(to_jsonb(r) ->> 'name'),
               private.student_update_label(to_jsonb(r) ->> 'organization'),
               private.student_update_label(to_jsonb(r) ->> 'position'),
               case when tg_table_name = 'awards' then 'An award' else 'An activity' end))
        into v_names
        from old_rows r
       where r.student_id = v_uid;
      perform private.note_student_update(v_uid, 'activities', null, v_names);
    end if;
  exception when others then
    raise warning 'student update notice skipped (%)', sqlstate;
  end;
  return null;
end;
$function$;

-- student_colleges, after insert / after delete, once per statement.
create or replace function private.student_update_colleges()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_names text[];
begin
  if v_uid is null or pg_trigger_depth() > 1 then return null; end if;
  begin
    if tg_op = 'INSERT' then
      select array_agg(coalesce(private.student_update_label(r.name), 'A college'))
        into v_names
        from new_rows r
       where r.student_id = v_uid;
      perform private.note_student_update(v_uid, 'colleges', v_names, null);
    elsif tg_op = 'DELETE' then
      select array_agg(coalesce(private.student_update_label(r.name), 'A college'))
        into v_names
        from old_rows r
       where r.student_id = v_uid;
      perform private.note_student_update(v_uid, 'colleges', null, v_names);
    end if;
  exception when others then
    raise warning 'student update notice skipped (%)', sqlstate;
  end;
  return null;
end;
$function$;

-- student_colleges, a row whose fit the student moved (see the header: refused today, kept for when it is not).
create or replace function private.student_update_college_fit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or v_uid is distinct from new.student_id or pg_trigger_depth() > 1 then return null; end if;
  begin
    perform private.note_student_update(
      v_uid,
      'college-fit',
      array[coalesce(private.student_update_label(new.name), 'A college') || ' to '
        || case new.fit when 'reach' then 'Reach' when 'target' then 'Target' when 'likely' then 'Safety'
                        else 'no fit' end],
      null);
  exception when others then
    raise warning 'student update notice skipped (%)', sqlstate;
  end;
  return null;
end;
$function$;

-- documents, after insert, once per statement: only files the student themself added.
create or replace function private.student_update_files()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_names text[];
begin
  if v_uid is null or pg_trigger_depth() > 1 then return null; end if;
  begin
    select array_agg(coalesce(
             private.student_update_label(r.title),
             private.student_update_label(r.filename),
             'A file'))
      into v_names
      from new_rows r
     where r.student_id = v_uid and r.uploaded_by = v_uid;
    perform private.note_student_update(v_uid, 'files', v_names, null);
  exception when others then
    raise warning 'student update notice skipped (%)', sqlstate;
  end;
  return null;
end;
$function$;

revoke all on function private.student_update_label(text) from public, anon, authenticated;
revoke all on function private.student_update_first_name(text) from public, anon, authenticated;
revoke all on function private.student_update_names(jsonb) from public, anon, authenticated;
revoke all on function private.student_update_merge(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.student_update_list(jsonb, int, int) from public, anon, authenticated;
revoke all on function private.student_update_count(int, text) from public, anon, authenticated;
revoke all on function private.student_update_title(text, text, jsonb) from public, anon, authenticated;
revoke all on function private.student_update_body(text, jsonb) from public, anon, authenticated;
revoke all on function private.student_update_href(uuid, text) from public, anon, authenticated;
revoke all on function private.note_student_update(uuid, text, text[], text[]) from public, anon, authenticated;
revoke all on function private.student_update_activities() from public, anon, authenticated;
revoke all on function private.student_update_colleges() from public, anon, authenticated;
revoke all on function private.student_update_college_fit() from public, anon, authenticated;
revoke all on function private.student_update_files() from public, anon, authenticated;

-- A trigger with a transition table takes one event, so insert and delete are separate triggers.
drop trigger if exists activities_student_update_ins on public.activities;
create trigger activities_student_update_ins
  after insert on public.activities
  referencing new table as new_rows
  for each statement execute function private.student_update_activities();

drop trigger if exists activities_student_update_del on public.activities;
create trigger activities_student_update_del
  after delete on public.activities
  referencing old table as old_rows
  for each statement execute function private.student_update_activities();

drop trigger if exists awards_student_update_ins on public.awards;
create trigger awards_student_update_ins
  after insert on public.awards
  referencing new table as new_rows
  for each statement execute function private.student_update_activities();

drop trigger if exists awards_student_update_del on public.awards;
create trigger awards_student_update_del
  after delete on public.awards
  referencing old table as old_rows
  for each statement execute function private.student_update_activities();

drop trigger if exists student_colleges_student_update_ins on public.student_colleges;
create trigger student_colleges_student_update_ins
  after insert on public.student_colleges
  referencing new table as new_rows
  for each statement execute function private.student_update_colleges();

drop trigger if exists student_colleges_student_update_del on public.student_colleges;
create trigger student_colleges_student_update_del
  after delete on public.student_colleges
  referencing old table as old_rows
  for each statement execute function private.student_update_colleges();

drop trigger if exists student_colleges_student_update_fit on public.student_colleges;
create trigger student_colleges_student_update_fit
  after update of fit on public.student_colleges
  for each row
  when (old.fit is distinct from new.fit and new.fit is not null)
  execute function private.student_update_college_fit();

drop trigger if exists documents_student_update_ins on public.documents;
create trigger documents_student_update_ins
  after insert on public.documents
  referencing new table as new_rows
  for each statement execute function private.student_update_files();
