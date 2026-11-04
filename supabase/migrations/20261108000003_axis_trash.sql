-- AxIS deletes are kept 30 days and restorable (AxIS security PR B; spec
-- docs/superpowers/specs/2026-10-30-axis-security-hardening-design.md section 2 and the Plan review of 11/2).
--
--   private.axis_trash        every row an AxIS delete removed, and every key it set null, keyed by the action
--   private.axis_trash_rules  who may restore a table's rows (deny by default: a table with no rule restores nothing)
--   private.axis_trash_capture()  the trigger that fills the trash, only for a request carrying the
--                             x-meridies-axis-action header (the API forwards it for a delete the counselor confirmed
--                             on an AxIS card); without the header it does nothing
--   public.axis_trash_restore(action)  the card's Restore: the counselor who confirmed the delete, within 30 days,
--                             all or nothing, same ids, parents before children
--   public.axis_trash_purge(), public.axis_trash_forget(user)  service role: the hourly purge and account deletion
--
-- The header is a client-settable PostgREST header, so the database trusts nothing about it beyond "keep a copy":
-- a forged mark keeps the forger's own deletes (deleted_by is auth.uid()), and only that account can restore them,
-- under the access rules, while still an approved counselor.
--
-- Restoring sends nothing and changes nothing on the way back in: the triggers listed at the end of this file skip
-- while a restore runs (meridies.axis_restore = 'on'): the one that notifies (student_colleges_notify_counselor),
-- the ones that would add what the trash brings back itself (meetings_add_primary_attendee, the pipeline timeline
-- logs), and every BEFORE INSERT trigger on a covered table that rewrites the row (a sequence enrollment put back at
-- step 1, the restorer stamped as author, a digest reset). Other triggers (validators, KPI completions) run as usual.
--
-- Not covered: roster imports (the import pipeline owns those tables and their retention; AxIS no longer deletes
-- imports) and message_deliveries' keys (a delivery record isn't relinked to a restored meeting or task).
--
-- Deploy order: either. Before it, the API refuses AxIS deletes with a message naming this file. Not in
-- REQUIRED_SCHEMA. Private tables: no client grants; the approval gate isn't needed (no public table is created).

create table if not exists private.axis_trash (
  id          bigint generated always as identity primary key,
  action_id   uuid not null,
  table_name  text not null,
  row_pk      jsonb not null,
  row_data    jsonb not null,
  kind        text not null check (kind in ('delete', 'set-null')),
  student_id  uuid references public.profiles(id) on delete cascade,
  deleted_by  uuid not null references public.profiles(id) on delete cascade,
  deleted_at  timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists axis_trash_action_idx on private.axis_trash (action_id, id);
create index if not exists axis_trash_deleted_at_idx on private.axis_trash (deleted_at);
alter table private.axis_trash enable row level security;
revoke all on private.axis_trash from public, anon, authenticated;

create table if not exists private.axis_trash_rules (
  table_name text primary key,
  rule       text not null check (rule in ('student', 'practice', 'owner', 'contact')),
  columns    text[] not null check (cardinality(columns) between 1 and 2)
);
alter table private.axis_trash_rules enable row level security;
revoke all on private.axis_trash_rules from public, anon, authenticated;

-- ---- Capture ----

create or replace function private.axis_trash_capture()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_hdr    text;
  v_uid    uuid;
  v_old    jsonb := to_jsonb(old);
  v_pk     jsonb;
  v_nulled jsonb := '{}'::jsonb;
  v_col    text;
begin
  begin
    v_hdr := nullif(current_setting('request.headers', true), '')::json ->> 'x-meridies-axis-action';
  exception when others then
    v_hdr := null;
  end;
  v_uid := auth.uid();
  if v_hdr is null or v_uid is null or v_hdr !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select coalesce(jsonb_object_agg(a.attname, v_old -> a.attname::text), '{}'::jsonb) into v_pk
  from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = tg_relid and i.indisprimary;

  if tg_op = 'DELETE' then
    insert into private.axis_trash (action_id, table_name, row_pk, row_data, kind, student_id, deleted_by)
    values (v_hdr::uuid, tg_table_name, v_pk, v_old, 'delete', nullif(v_old ->> 'student_id', '')::uuid, v_uid);
    return old;
  end if;

  -- An update from ON DELETE SET NULL: keep each listed key that went from a value to null.
  for i in 0 .. tg_nargs - 1 loop
    v_col := tg_argv[i];
    if v_old ->> v_col is not null and to_jsonb(new) ->> v_col is null then
      v_nulled := v_nulled || jsonb_build_object(v_col, v_old -> v_col);
    end if;
  end loop;
  if v_nulled <> '{}'::jsonb then
    insert into private.axis_trash (action_id, table_name, row_pk, row_data, kind, student_id, deleted_by)
    values (v_hdr::uuid, tg_table_name, v_pk, v_nulled, 'set-null', nullif(v_old ->> 'student_id', '')::uuid, v_uid);
  end if;
  return new;
end;
$$;
revoke all on function private.axis_trash_capture() from public, anon, authenticated;

-- Fires last among a table's BEFORE triggers (zz_), so a guard that refuses or skips the change runs first.
create or replace function private.attach_axis_trash(p_table regclass, p_set_null_cols text[] default null, p_delete boolean default true)
returns void
language plpgsql set search_path = '' as $$
begin
  execute format('drop trigger if exists zz_axis_trash_delete on %s', p_table);
  if p_delete then
    execute format('create trigger zz_axis_trash_delete before delete on %s for each row execute function private.axis_trash_capture()', p_table);
  end if;
  execute format('drop trigger if exists zz_axis_trash_set_null on %s', p_table);
  if p_set_null_cols is not null and cardinality(p_set_null_cols) > 0 then
    execute format(
      'create trigger zz_axis_trash_set_null before update of %s on %s for each row execute function private.axis_trash_capture(%s)',
      (select string_agg(quote_ident(c), ', ') from unnest(p_set_null_cols) c),
      p_table,
      (select string_agg(quote_literal(c), ', ') from unnest(p_set_null_cols) c)
    );
  end if;
end;
$$;
revoke all on function private.attach_axis_trash(regclass, text[], boolean) from public, anon, authenticated;

-- ---- The covered tables ----
-- Every table a covered AxIS delete's route deletes from (lib/axis/ops/trash.ts, TRASH_COVERED), plus every table
-- reached from them by ON DELETE CASCADE (deleted too) or SET NULL (its key kept), found with a recursive
-- pg_constraint walk on 2026-11-04. Each line is followed by its access rule:
--   student  [student col, fallback owner col]: counselor_can_edit_student; with no student, the owner col is the caller
--   practice [firm col, counselor col]:         crm_can_access
--   owner    [col]:                              the col is the caller
--   contact  [contact col]:                      crm_can_access on the contact's workspace

insert into private.axis_trash_rules (table_name, rule, columns) values
  ('activities', 'student', '{student_id}'),
  ('admission_outcomes', 'student', '{student_id,counselor_id}'),
  ('alumni_records', 'student', '{student_id}'),
  ('award_appeals', 'student', '{student_id}'),
  ('award_letter_items', 'student', '{student_id}'),
  ('award_letters', 'student', '{student_id}'),
  ('awards', 'student', '{student_id}'),
  ('calendar_event_type_assignments', 'owner', '{owner_id}'),
  ('calendar_event_types', 'owner', '{owner_id}'),
  ('calendar_events', 'owner', '{owner_id}'),
  ('college_webinar_tips', 'practice', '{firm_id,created_by}'),
  ('consultant_tasks', 'practice', '{firm_id,assignee_id}'),
  ('counselor_work_items', 'owner', '{counselor_id}'),
  ('courses', 'student', '{student_id}'),
  ('deadlines', 'student', '{student_id}'),
  ('deliverable_documents', 'student', '{student_id}'),
  ('deliverable_stages', 'student', '{student_id}'),
  ('deliverable_tracker_checks', 'student', '{student_id}'),
  ('deliverables', 'student', '{student_id}'),
  ('document_links', 'student', '{student_id,owner_id}'),
  ('documents', 'student', '{student_id,owner_id}'),
  ('draft_quality_checks', 'student', '{student_id}'),
  ('email_templates', 'owner', '{counselor_id}'),
  ('essay_marks', 'student', '{student_id}'),
  ('essay_versions', 'student', '{student_id}'),
  ('essays', 'student', '{student_id}'),
  ('family_reports', 'student', '{student_id}'),
  ('folders', 'student', '{student_id,owner_id}'),
  ('guardians', 'student', '{student_id}'),
  ('hub_event_saves', 'owner', '{profile_id}'),
  ('hub_events', 'practice', '{firm_id,created_by}'),
  ('inbound_messages', 'practice', '{firm_id,counselor_id}'),
  ('library_resource_pins', 'practice', '{firm_id,counselor_id}'),
  ('library_resources', 'practice', '{firm_id,counselor_id}'),
  ('meeting_attendees', 'student', '{student_id}'),
  ('meeting_notes', 'student', '{student_id}'),
  ('meetings', 'student', '{student_id,counselor_id}'),
  ('messaging_routes', 'owner', '{counselor_id}'),
  ('narrative_flags', 'student', '{student_id}'),
  ('net_price_estimates', 'student', '{student_id}'),
  ('opportunity_matches', 'student', '{student_id}'),
  ('parent_alerts', 'student', '{student_id}'),
  ('pipeline_activities', 'practice', '{firm_id,counselor_id}'),
  ('pipeline_contacts', 'practice', '{firm_id,counselor_id}'),
  ('pipeline_followups', 'practice', '{firm_id,counselor_id}'),
  ('pipeline_packages', 'contact', '{contact_id}'),
  ('pipeline_payments', 'contact', '{contact_id}'),
  ('pipeline_sequence_enrollments', 'practice', '{firm_id,counselor_id}'),
  ('pipeline_stages', 'practice', '{firm_id,counselor_id}'),
  ('pipeline_unsubscribe_tokens', 'contact', '{contact_id}'),
  ('progress_events', 'student', '{student_id}'),
  ('red_flags', 'student', '{student_id}'),
  ('referrals', 'owner', '{counselor_id}'),
  ('scholarship_matches', 'student', '{student_id}'),
  ('student_aid_checklist', 'student', '{student_id}'),
  ('student_college_fit', 'student', '{student_id}'),
  ('student_colleges', 'student', '{student_id}'),
  ('student_status_overrides', 'student', '{student_id}'),
  ('supplement_docs', 'student', '{student_id,owner_id}'),
  ('test_scores', 'student', '{student_id}')
on conflict (table_name) do update set rule = excluded.rule, columns = excluded.columns;

-- Deleted (directly or by cascade), with the keys a delete elsewhere can set null on them.
select private.attach_axis_trash('public.activities');
select private.attach_axis_trash('public.admission_outcomes', '{student_college_id}');
select private.attach_axis_trash('public.award_appeals', '{award_letter_id,student_college_id}');
select private.attach_axis_trash('public.award_letter_items');
select private.attach_axis_trash('public.award_letters', '{document_id,student_college_id}');
select private.attach_axis_trash('public.awards');
select private.attach_axis_trash('public.calendar_event_type_assignments');
select private.attach_axis_trash('public.calendar_event_types');
select private.attach_axis_trash('public.calendar_events', '{type_id}');
select private.attach_axis_trash('public.college_webinar_tips');
select private.attach_axis_trash('public.consultant_tasks');
select private.attach_axis_trash('public.counselor_work_items');
select private.attach_axis_trash('public.courses');
select private.attach_axis_trash('public.deadlines', '{student_college_id}');
select private.attach_axis_trash('public.deliverable_documents');
select private.attach_axis_trash('public.deliverable_stages', '{deadline_id}');
select private.attach_axis_trash('public.deliverable_tracker_checks', '{document_id}');
select private.attach_axis_trash('public.deliverables', '{deadline_id}');
select private.attach_axis_trash('public.document_links', '{folder_id}');
select private.attach_axis_trash('public.documents', '{folder_id}');
select private.attach_axis_trash('public.draft_quality_checks');
select private.attach_axis_trash('public.email_templates');
select private.attach_axis_trash('public.essay_marks', '{quality_check_id}');
select private.attach_axis_trash('public.essay_versions');
select private.attach_axis_trash('public.essays', '{document_id,student_college_id}');
select private.attach_axis_trash('public.family_reports');
select private.attach_axis_trash('public.folders');
select private.attach_axis_trash('public.guardians');
select private.attach_axis_trash('public.hub_event_saves');
select private.attach_axis_trash('public.hub_events');
select private.attach_axis_trash('public.inbound_messages', '{guardian_id}');
select private.attach_axis_trash('public.library_resource_pins');
select private.attach_axis_trash('public.library_resources');
select private.attach_axis_trash('public.meeting_attendees');
select private.attach_axis_trash('public.meeting_notes');
select private.attach_axis_trash('public.meetings', '{deadline_id,meeting_note_id}');
select private.attach_axis_trash('public.messaging_routes');
select private.attach_axis_trash('public.narrative_flags', '{assigned_task_id}');
select private.attach_axis_trash('public.net_price_estimates');
select private.attach_axis_trash('public.pipeline_activities');
select private.attach_axis_trash('public.pipeline_contacts');
select private.attach_axis_trash('public.pipeline_followups');
select private.attach_axis_trash('public.pipeline_packages');
select private.attach_axis_trash('public.pipeline_payments');
select private.attach_axis_trash('public.pipeline_sequence_enrollments');
select private.attach_axis_trash('public.pipeline_stages');
select private.attach_axis_trash('public.pipeline_unsubscribe_tokens');
select private.attach_axis_trash('public.progress_events');
select private.attach_axis_trash('public.referrals');
select private.attach_axis_trash('public.student_aid_checklist', '{deadline_id}');
select private.attach_axis_trash('public.student_college_fit');
select private.attach_axis_trash('public.student_colleges');
select private.attach_axis_trash('public.student_status_overrides');
select private.attach_axis_trash('public.test_scores');
-- Only ever set null by a covered delete: their keys, not the rows.
select private.attach_axis_trash('public.alumni_records', '{outcome_id}', false);
select private.attach_axis_trash('public.opportunity_matches', '{deadline_id,assigned_task_id}', false);
select private.attach_axis_trash('public.parent_alerts', '{guardian_id}', false);
select private.attach_axis_trash('public.red_flags', '{deadline_id,deliverable_id}', false);
select private.attach_axis_trash('public.scholarship_matches', '{deadline_id}', false);
select private.attach_axis_trash('public.supplement_docs', '{student_college_id}', false);

-- ---- Restore ----

-- Whether the caller may have this row back, by its table's rule (deny by default).
create or replace function private.axis_trash_allows(p_table text, p_row jsonb, p_uid uuid)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r     private.axis_trash_rules;
  v_one text;
  v_two text;
begin
  select * into r from private.axis_trash_rules where table_name = p_table;
  if not found or p_row is null then
    return false;
  end if;
  v_one := p_row ->> r.columns[1];
  v_two := case when cardinality(r.columns) >= 2 then p_row ->> r.columns[2] end;
  if r.rule = 'student' then
    if v_one is not null then
      return coalesce(private.counselor_can_edit_student(v_one::uuid, p_uid), false);
    end if;
    return v_two is not null and v_two::uuid = p_uid;
  elsif r.rule = 'practice' then
    return coalesce(private.crm_can_access(v_one::uuid, v_two::uuid, p_uid), false);
  elsif r.rule = 'owner' then
    return v_one is not null and v_one::uuid = p_uid;
  elsif r.rule = 'contact' then
    return exists (
      select 1 from public.pipeline_contacts c
      where c.id = v_one::uuid and coalesce(private.crm_can_access(c.firm_id, c.counselor_id, p_uid), false)
    );
  end if;
  return false;
end;
$$;
revoke all on function private.axis_trash_allows(text, jsonb, uuid) from public, anon, authenticated;

-- A table's columns that take a value on insert (generated columns are left to the database).
create or replace function private.axis_trash_columns(p_table text)
returns text
language sql stable set search_path = '' as $$
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
  from pg_attribute a
  where a.attrelid = ('public.' || quote_ident(p_table))::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
$$;
revoke all on function private.axis_trash_columns(text) from public, anon, authenticated;

-- A where clause matching a row's primary key, its values taken from $2.
create or replace function private.axis_trash_pk_match(p_table text, p_pk jsonb)
returns text
language sql stable set search_path = '' as $$
  select string_agg(format('%I = (jsonb_populate_record(null::public.%I, $2)).%I', k, p_table, k), ' and ')
  from jsonb_object_keys(p_pk) k;
$$;
revoke all on function private.axis_trash_pk_match(text, jsonb) from public, anon, authenticated;

create or replace function public.axis_trash_restore(p_action uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := auth.uid();
  r          private.axis_trash;
  v_data     jsonb;
  v_cols     text;
  v_set      text;
  v_row      jsonb;
  v_restored integer := 0;
  v_paused   text[] := '{}';
begin
  if p_action is null then
    return jsonb_build_object('ok', false, 'reason', 'not-yours');
  end if;
  perform 1 from private.axis_trash t where t.action_id = p_action order by t.id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-yours');
  end if;

  -- Run by hand as postgres: the caller is taken to be the deleter, and every other check still applies.
  if v_uid is null then
    if (select count(distinct t.deleted_by) from private.axis_trash t where t.action_id = p_action) <> 1 then
      return jsonb_build_object('ok', false, 'reason', 'not-yours');
    end if;
    select t.deleted_by into v_uid from private.axis_trash t where t.action_id = p_action limit 1;
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  end if;

  if exists (select 1 from private.axis_trash t where t.action_id = p_action and t.deleted_by <> v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'not-yours');
  end if;
  if not coalesce(private.is_counselor(v_uid), false) then
    return jsonb_build_object('ok', false, 'reason', 'not-approved');
  end if;
  if exists (select 1 from private.axis_trash t where t.action_id = p_action and t.restored_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if exists (select 1 from private.axis_trash t where t.action_id = p_action and t.deleted_at < now() - interval '30 days') then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if exists (
    select 1 from private.axis_trash t
    where t.action_id = p_action and not exists (select 1 from private.axis_trash_rules x where x.table_name = t.table_name)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'no-access');
  end if;

  begin
    perform set_config('meridies.axis_restore', 'on', true);
    -- Deleted rows, parents first (the order they were captured in), with their own ids.
    for r in select * from private.axis_trash t where t.action_id = p_action and t.kind = 'delete' order by t.id loop
      v_data := r.row_data;
      if r.table_name = 'pipeline_sequence_enrollments' and v_data ->> 'status' = 'active' then
        v_data := jsonb_set(v_data, '{status}', '"paused"');
        if not 'pipeline_sequence_enrollments' = any (v_paused) then
          v_paused := array_append(v_paused, 'pipeline_sequence_enrollments');
        end if;
      end if;
      v_cols := private.axis_trash_columns(r.table_name);
      execute format('insert into public.%I (%s) overriding system value select %s from jsonb_populate_record(null::public.%I, $1)',
                     r.table_name, v_cols, v_cols, r.table_name)
        using v_data;
      if not private.axis_trash_allows(r.table_name, v_data, v_uid) then
        raise exception 'axis-trash-no-access' using errcode = 'P0001';
      end if;
      v_restored := v_restored + 1;
    end loop;
    -- Keys set null, put back on rows that still exist.
    for r in select * from private.axis_trash t where t.action_id = p_action and t.kind = 'set-null' order by t.id loop
      execute format('select to_jsonb(x) from public.%I x where %s', r.table_name, private.axis_trash_pk_match(r.table_name, r.row_pk))
        into v_row using null::jsonb, r.row_pk;
      continue when v_row is null;
      if not private.axis_trash_allows(r.table_name, v_row, v_uid) then
        raise exception 'axis-trash-no-access' using errcode = 'P0001';
      end if;
      select string_agg(format('%I = (jsonb_populate_record(null::public.%I, $1)).%I', k, r.table_name, k), ', ')
        into v_set from jsonb_object_keys(r.row_data) k;
      execute format('update public.%I set %s where %s', r.table_name, v_set, private.axis_trash_pk_match(r.table_name, r.row_pk))
        using r.row_data, r.row_pk;
    end loop;
    update private.axis_trash t set restored_at = now() where t.action_id = p_action;
    perform set_config('meridies.axis_restore', 'off', true);
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'conflict');
    when foreign_key_violation then
      return jsonb_build_object('ok', false, 'reason', 'parent-missing');
    when raise_exception then
      if sqlerrm = 'axis-trash-no-access' then
        return jsonb_build_object('ok', false, 'reason', 'no-access');
      end if;
      raise;
  end;
  return jsonb_build_object('ok', true, 'restored', v_restored, 'paused', to_jsonb(v_paused));
end;
$$;
revoke all on function public.axis_trash_restore(uuid) from public, anon;
grant execute on function public.axis_trash_restore(uuid) to authenticated, service_role;

-- ---- Purge and forget (service role) ----

-- Rows past 30 days go; the document objects they kept are returned when no live documents row points at them.
create or replace function public.axis_trash_purge(p_now timestamptz default now())
returns table (bucket text, storage_path text)
language sql security definer set search_path = '' as $$
  with gone as (
    delete from private.axis_trash t where t.deleted_at < p_now - interval '30 days'
    returning t.table_name, t.kind, t.row_data
  )
  select distinct g.row_data ->> 'bucket', g.row_data ->> 'storage_path'
  from gone g
  where g.table_name = 'documents' and g.kind = 'delete' and g.row_data ->> 'storage_path' is not null
    and not exists (
      select 1 from public.documents d where d.bucket = g.row_data ->> 'bucket' and d.storage_path = g.row_data ->> 'storage_path'
    );
$$;

-- An account's deletion: the trash it made and the trash about it.
create or replace function public.axis_trash_forget(p_user uuid)
returns table (bucket text, storage_path text)
language sql security definer set search_path = '' as $$
  with gone as (
    delete from private.axis_trash t where t.deleted_by = p_user or t.student_id = p_user
    returning t.table_name, t.kind, t.row_data
  )
  select distinct g.row_data ->> 'bucket', g.row_data ->> 'storage_path'
  from gone g
  where g.table_name = 'documents' and g.kind = 'delete' and g.row_data ->> 'storage_path' is not null
    and not exists (
      select 1 from public.documents d where d.bucket = g.row_data ->> 'bucket' and d.storage_path = g.row_data ->> 'storage_path'
    );
$$;
revoke all on function public.axis_trash_purge(timestamptz) from public, anon, authenticated;
revoke all on function public.axis_trash_forget(uuid) from public, anon, authenticated;
grant execute on function public.axis_trash_purge(timestamptz) to service_role;
grant execute on function public.axis_trash_forget(uuid) to service_role;

-- ---- Triggers that would send, duplicate or rewrite a restored row ----
-- A restore puts back rows exactly as they were. These triggers skip while it runs (meridies.axis_restore = 'on'):
-- each is re-created from its own definition with a WHEN condition added, so its events and columns stay as
-- they are. The restore checks access itself (private.axis_trash_allows), so the guards' client rules aren't needed.
do $$
declare
  t     record;
  v_def text;
begin
  for t in
    select tg.oid, tg.tgname, c.relname
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
    where c.relnamespace = 'public'::regnamespace and not tg.tgisinternal
      and (c.relname, tg.tgname) in (values
        -- send or log what the trash brings back itself
        ('student_colleges', 'student_colleges_notify_counselor'),
        ('meetings', 'meetings_add_primary_attendee'),
        ('pipeline_contacts', 'pipeline_contacts_log'),
        ('pipeline_followups', 'pipeline_followups_log'),
        ('pipeline_payments', 'pipeline_payments_log'),
        -- rewrite the row on insert (a sequence back at step 1, the restorer as its author, a reset digest)
        ('consultant_tasks', 'consultant_tasks_guard'),
        ('document_links', 'document_links_keep_out_clears_digest'),
        ('essay_versions', 'essay_versions_set_word_count'),
        ('essays', 'essays_link_owner_guard'),
        ('essays', 'essays_set_word_count'),
        ('guardians', 'guardians_student_insert_guard'),
        ('meetings', 'meetings_ics_sequence'),
        ('pipeline_activities', 'pipeline_activities_guard'),
        ('pipeline_contacts', 'pipeline_contacts_guard'),
        ('pipeline_contacts', 'pipeline_contacts_status_guard'),
        ('pipeline_followups', 'pipeline_followups_guard'),
        ('pipeline_sequence_enrollments', 'pipeline_sequence_enrollments_guard'),
        ('student_colleges', 'student_colleges_stamp_decision_date'))
  loop
    v_def := pg_get_triggerdef(t.oid);
    continue when v_def ilike '%meridies.axis_restore%';
    if v_def ~* ' WHEN \(' then
      raise exception 'trigger % on % already has a WHEN clause; add the restore condition by hand', t.tgname, t.relname;
    end if;
    v_def := replace(v_def, ' EXECUTE FUNCTION ', ' WHEN (current_setting(''meridies.axis_restore'', true) IS DISTINCT FROM ''on'') EXECUTE FUNCTION ');
    execute format('drop trigger %I on public.%I', t.tgname, t.relname);
    execute v_def;
  end loop;
end;
$$;
